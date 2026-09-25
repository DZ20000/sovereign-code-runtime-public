use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use time::{format_description::well_known::Rfc3339, Duration as TimeDuration, OffsetDateTime};

const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
const MAX_CONTROL_BYTES: usize = 64 * 1024;
const RESTART_ACK_TIMEOUT: Duration = Duration::from_secs(3);
const RESTART_ACK_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[cfg(windows)]
fn configure_guardian_command(command: &mut Command, breakaway: bool) {
    use std::os::windows::process::CommandExt;

    // The shell runs inside a job object, and a job or tree kill would take a
    // child guardian with it — leaving nothing to observe the exit or restart
    // the shell. Breaking away keeps the supervisor outside that blast radius.
    // SILENT_BREAKAWAY_OK jobs detach children automatically; an explicit
    // request is denied unless the job allows it, so the caller retries
    // without the flag rather than losing the guardian entirely.
    let mut flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
    if breakaway {
        flags |= CREATE_BREAKAWAY_FROM_JOB;
    }
    command.creation_flags(flags);
}

#[cfg(windows)]
fn spawn_guardian_command(command: &mut Command) -> std::io::Result<Child> {
    configure_guardian_command(command, true);
    match command.spawn() {
        Ok(child) => Ok(child),
        Err(_) => {
            configure_guardian_command(command, false);
            command.spawn()
        }
    }
}

#[cfg(not(windows))]
fn spawn_guardian_command(command: &mut Command) -> std::io::Result<Child> {
    command.spawn()
}

#[cfg(all(test, windows))]
mod tests;

#[derive(Clone)]
pub struct HostGuardian {
    inner: Arc<HostGuardianInner>,
}

struct HostGuardianInner {
    enabled: bool,
    child: Mutex<Option<Child>>,
    control_path: Option<PathBuf>,
    incident_path: Option<PathBuf>,
    token: Option<String>,
    parent_process_id: u32,
    shutdown_started: AtomicBool,
}

fn node_compatible_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn generate_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Could not generate Host Guardian session token: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn unix_time_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn write_control(
    path: &PathBuf,
    token: &str,
    parent_process_id: u32,
    intent: &str,
    reason: Option<&str>,
    restart_request_id: Option<&str>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Host Guardian control path has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Host Guardian state directory: {error}"))?;
    let payload = json!({
        "schemaVersion": "scr.host-guardian-control/v1",
        "token": token,
        "intent": intent,
        "reason": reason,
        "parentPid": parent_process_id,
        "updatedAtUnixMs": unix_time_ms().to_string(),
        "restartRequestId": restart_request_id,
        "guardianObservedRequestId": null,
        "guardianObservedAtUnixMs": null,
        "guardianProcessId": null
    });
    let bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|error| format!("Could not serialize Host Guardian control state: {error}"))?;
    fs::write(path, bytes)
        .map_err(|error| format!("Could not write Host Guardian control state: {error}"))
}

fn restart_acknowledged(
    path: &PathBuf,
    token: &str,
    request_id: &str,
    guardian_process_id: u32,
) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    if bytes.len() > MAX_CONTROL_BYTES {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    value.get("schemaVersion").and_then(Value::as_str) == Some("scr.host-guardian-control/v1")
        && value.get("token").and_then(Value::as_str) == Some(token)
        && value.get("intent").and_then(Value::as_str) == Some("restart")
        && value.get("restartRequestId").and_then(Value::as_str) == Some(request_id)
        && value
            .get("guardianObservedRequestId")
            .and_then(Value::as_str)
            == Some(request_id)
        && value.get("guardianProcessId").and_then(Value::as_u64)
            == Some(u64::from(guardian_process_id))
        && value
            .get("guardianObservedAtUnixMs")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
}

impl HostGuardian {
    pub fn disabled() -> Self {
        Self {
            inner: Arc::new(HostGuardianInner {
                enabled: false,
                child: Mutex::new(None),
                control_path: None,
                incident_path: None,
                token: None,
                parent_process_id: std::process::id(),
                shutdown_started: AtomicBool::new(false),
            }),
        }
    }

    pub fn start(app: &AppHandle, enabled: bool) -> Result<Self, String> {
        if !enabled {
            return Ok(Self::disabled());
        }

        let explicit_user_data = std::env::var_os("SCR_USER_DATA_PATH")
            .or_else(|| std::env::var_os("SCR_RESOURCE_BENCHMARK_USER_DATA"));
        let user_data = match explicit_user_data {
            Some(path) => PathBuf::from(path),
            None => app.path().app_data_dir().map_err(|error| {
                format!("Could not resolve Host Guardian data directory: {error}")
            })?,
        };
        let user_data = node_compatible_path(user_data);
        let resources = node_compatible_path(app.path().resource_dir().map_err(|error| {
            format!("Could not resolve Host Guardian resource directory: {error}")
        })?);
        let node_executable = resources.join("node/node.exe");
        let guardian_script = resources.join("host-guardian.mjs");
        let shell_executable = node_compatible_path(std::env::current_exe().map_err(|error| {
            format!("Could not resolve the Sovereign shell executable: {error}")
        })?);
        for (path, label) in [
            (&node_executable, "portable Node runtime"),
            (&guardian_script, "Host Guardian script"),
            (&shell_executable, "Sovereign shell executable"),
        ] {
            if !path.is_file() {
                return Err(format!(
                    "Host Guardian {label} is missing: {}",
                    path.display()
                ));
            }
        }

        let state_root = user_data.join("guardian");
        fs::create_dir_all(&state_root)
            .map_err(|error| format!("Could not create Host Guardian state directory: {error}"))?;
        let token = generate_token()?;
        let token_prefix = token.chars().take(12).collect::<String>();
        let parent_process_id = std::process::id();
        let control_path =
            state_root.join(format!("control-{parent_process_id}-{token_prefix}.json"));
        let history_path = state_root.join("restart-history.json");
        let incident_path = state_root.join("last-incident.json");
        write_control(
            &control_path,
            &token,
            parent_process_id,
            "running",
            None,
            None,
        )?;

        let mut command = Command::new(&node_executable);
        command
            .arg(&guardian_script)
            .arg("--parent-pid")
            .arg(parent_process_id.to_string())
            .arg("--shell")
            .arg(&shell_executable)
            .arg("--control")
            .arg(&control_path)
            .arg("--history")
            .arg(&history_path)
            .arg("--incident")
            .arg(&incident_path)
            .arg("--token")
            .arg(&token)
            .arg("--restart-arg")
            .arg("--guardian-restart")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = spawn_guardian_command(&mut command)
            .map_err(|error| format!("Could not start Host Guardian: {error}"))?;

        Ok(Self {
            inner: Arc::new(HostGuardianInner {
                enabled: true,
                child: Mutex::new(Some(child)),
                control_path: Some(control_path),
                incident_path: Some(incident_path),
                token: Some(token),
                parent_process_id,
                shutdown_started: AtomicBool::new(false),
            }),
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.inner.enabled && self.process_id().is_some()
    }

    /// Where the guardian keeps its incident record, and so where evidence of
    /// the failure behind an incident belongs.
    pub fn evidence_directory(&self) -> Option<PathBuf> {
        self.inner
            .incident_path
            .as_ref()
            .and_then(|path| path.parent())
            .map(Path::to_path_buf)
    }

    pub fn process_id(&self) -> Option<u32> {
        let Ok(mut child) = self.inner.child.lock() else {
            return None;
        };
        match child.as_mut() {
            Some(child) => {
                if child.try_wait().ok().flatten().is_none() {
                    Some(child.id())
                } else {
                    None
                }
            }
            None => None,
        }
    }

    pub fn state(&self) -> Value {
        let last_incident = self
            .inner
            .incident_path
            .as_ref()
            .and_then(|path| fs::read(path).ok())
            .filter(|bytes| bytes.len() <= 64 * 1024)
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| {
                let record = value.as_object()?;
                let outcome = record.get("outcome")?.as_str()?;
                if !matches!(outcome, "restarted" | "restart-failed" | "circuit-open") {
                    return None;
                }
                let occurred_at = record.get("occurredAt")?.as_str()?;
                let reason = record.get("reason")?.as_str()?;
                if occurred_at.len() > 128 || reason.len() > 200 {
                    return None;
                }
                Some(json!({
                    "occurredAt": occurred_at,
                    "outcome": outcome,
                    "reason": reason,
                    "restartCountInWindow": record
                        .get("restartCountInWindow")
                        .and_then(Value::as_u64)
                }))
            });
        let circuit_incident = last_incident
            .as_ref()
            .and_then(|incident| incident.get("outcome"))
            .and_then(Value::as_str)
            == Some("circuit-open");
        let circuit_open = circuit_incident
            && last_incident
                .as_ref()
                .and_then(|incident| incident.get("occurredAt"))
                .and_then(Value::as_str)
                .and_then(|occurred_at| OffsetDateTime::parse(occurred_at, &Rfc3339).ok())
                .map(|occurred_at| {
                    let age = OffsetDateTime::now_utc() - occurred_at;
                    age >= TimeDuration::ZERO && age < TimeDuration::minutes(10)
                })
                .unwrap_or(true);
        let process_id = self.process_id();
        json!({
            "available": self.inner.enabled && process_id.is_some(),
            "processId": process_id,
            "closeToTray": self.inner.enabled && process_id.is_some(),
            "circuitOpen": circuit_open,
            "lastIncident": last_incident
        })
    }

    pub fn prepare_restart(&self, reason: &str) -> Result<(), String> {
        if !self.inner.enabled {
            return Err("Host Guardian is unavailable for managed restart.".into());
        }
        if reason.is_empty() || reason.len() > 200 || reason.contains(['\r', '\n', '\0']) {
            return Err("Host Guardian restart reason is invalid.".into());
        }
        let guardian_process_id = self
            .process_id()
            .ok_or_else(|| "Host Guardian process is no longer running.".to_string())?;
        let path = self
            .inner
            .control_path
            .as_ref()
            .ok_or_else(|| "Host Guardian control path is unavailable.".to_string())?;
        let token = self
            .inner
            .token
            .as_deref()
            .ok_or_else(|| "Host Guardian session token is unavailable.".to_string())?;
        let request_id = generate_token()?;
        write_control(
            path,
            token,
            self.inner.parent_process_id,
            "restart",
            Some(reason),
            Some(&request_id),
        )?;

        let deadline = Instant::now() + RESTART_ACK_TIMEOUT;
        loop {
            if restart_acknowledged(path, token, &request_id, guardian_process_id)
                && self.process_id() == Some(guardian_process_id)
            {
                return Ok(());
            }
            if self.process_id() != Some(guardian_process_id) {
                let _ = write_control(
                    path,
                    token,
                    self.inner.parent_process_id,
                    "running",
                    None,
                    None,
                );
                return Err("Host Guardian process stopped before acknowledging restart.".into());
            }
            if Instant::now() >= deadline {
                let _ = write_control(
                    path,
                    token,
                    self.inner.parent_process_id,
                    "running",
                    None,
                    None,
                );
                return Err("Host Guardian did not acknowledge restart in time.".into());
            }
            thread::sleep(RESTART_ACK_POLL_INTERVAL);
        }
    }

    pub fn cancel_restart(&self) -> Result<(), String> {
        if !self.inner.enabled {
            return Ok(());
        }
        let path = self
            .inner
            .control_path
            .as_ref()
            .ok_or_else(|| "Host Guardian control path is unavailable.".to_string())?;
        let token = self
            .inner
            .token
            .as_deref()
            .ok_or_else(|| "Host Guardian session token is unavailable.".to_string())?;
        write_control(
            path,
            token,
            self.inner.parent_process_id,
            "running",
            None,
            None,
        )
    }

    pub fn shutdown(&self) -> Result<(), String> {
        if !self.inner.enabled || self.inner.shutdown_started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let control_error = if let (Some(path), Some(token)) = (
            self.inner.control_path.as_ref(),
            self.inner.token.as_deref(),
        ) {
            write_control(
                path,
                token,
                self.inner.parent_process_id,
                "exit",
                Some("intentional-application-exit"),
                None,
            )
            .err()
        } else {
            None
        };

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let exited = {
                let mut child = self
                    .inner
                    .child
                    .lock()
                    .map_err(|_| "Host Guardian child lock is poisoned.".to_string())?;
                match child.as_mut() {
                    Some(child) => child
                        .try_wait()
                        .map_err(|error| error.to_string())?
                        .is_some(),
                    None => true,
                }
            };
            if exited || Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        if let Ok(mut child) = self.inner.child.lock() {
            if let Some(child) = child.as_mut() {
                if child.try_wait().ok().flatten().is_none() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            child.take();
        }
        if let Some(path) = self.inner.control_path.as_ref() {
            let _ = fs::remove_file(path);
        }
        match control_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
