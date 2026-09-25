use super::{spawn_guardian_command, HostGuardian, HostGuardianInner};
use serde_json::{json, Value};
use std::{
    env, fs, io,
    os::windows::io::AsRawHandle,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    ptr,
    sync::{atomic::AtomicBool, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tempfile::tempdir;

const FIXTURE_MODE_ENV: &str = "SCR_GUARDIAN_JOB_FIXTURE";
const FIXTURE_GO_ENV: &str = "SCR_GUARDIAN_JOB_GO";
const FIXTURE_READY_ENV: &str = "SCR_GUARDIAN_JOB_READY";
const FIXTURE_STOP_ENV: &str = "SCR_GUARDIAN_JOB_STOP";
const FIXTURE_NODE_ENV: &str = "SCR_GUARDIAN_JOB_NODE";
const FIXTURE_SCRIPT_ENV: &str = "SCR_GUARDIAN_JOB_SCRIPT";
const FIXTURE_CONTROL_ENV: &str = "SCR_GUARDIAN_JOB_CONTROL";
const FIXTURE_HISTORY_ENV: &str = "SCR_GUARDIAN_JOB_HISTORY";
const FIXTURE_INCIDENT_ENV: &str = "SCR_GUARDIAN_JOB_INCIDENT";
const FIXTURE_TARGET_ENV: &str = "SCR_GUARDIAN_JOB_TARGET";
const FIXTURE_MARKER_ENV: &str = "SCR_GUARDIAN_JOB_MARKER";
const RESTART_REASON: &str = "runtime-host-health-ping-failed";
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: u32 = 0x0000_1000;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

type RawHandle = *mut core::ffi::c_void;

#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
#[derive(Default)]
struct BasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimitInformation {
    basic_limit_information: BasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(attributes: *const core::ffi::c_void, name: *const u16) -> RawHandle;
    fn SetInformationJobObject(
        job: RawHandle,
        information_class: i32,
        information: *const core::ffi::c_void,
        information_length: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: RawHandle, process: RawHandle) -> i32;
    fn CloseHandle(handle: RawHandle) -> i32;
}

struct JobObject(RawHandle);

impl JobObject {
    fn new(limit_flags: u32) -> io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut limits = ExtendedLimitInformation::default();
        limits.basic_limit_information.limit_flags = limit_flags;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                (&raw const limits).cast(),
                std::mem::size_of::<ExtendedLimitInformation>() as u32,
            )
        };
        if configured == 0 {
            let error = io::Error::last_os_error();
            unsafe {
                CloseHandle(handle);
            }
            return Err(error);
        }
        Ok(Self(handle))
    }

    fn assign(&self, child: &Child) -> io::Result<()> {
        let assigned = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle().cast()) };
        if assigned == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for JobObject {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

struct ExactProcessCleanup(Option<u32>);

impl Drop for ExactProcessCleanup {
    fn drop(&mut self) {
        if let Some(process_id) = self.0 {
            let _ = Command::new("taskkill.exe")
                .args(["/pid", &process_id.to_string(), "/t", "/f"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

fn required_fixture_path(name: &str) -> PathBuf {
    env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("Missing Guardian fixture environment variable: {name}"))
}

fn write_json(path: &Path, value: Value) {
    fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}

fn wait_for_path(path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.is_file() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("Timed out waiting for {}", path.display());
}

fn wait_for_absent(path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !path.exists() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("Timed out waiting for removal of {}", path.display());
}

fn wait_for_json(path: &Path, timeout: Duration, predicate: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(bytes) = fs::read(path) {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                if predicate(&value) {
                    return value;
                }
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("Timed out waiting for expected JSON at {}", path.display());
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            return true;
        }
        thread::sleep(Duration::from_millis(25));
    }
    false
}

fn node_executable() -> PathBuf {
    env::split_paths(&env::var_os("PATH").unwrap_or_default())
        .map(|entry| entry.join("node.exe"))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| panic!("Node.js is required for the Host Guardian regression."))
}

fn start_fixture(mode: &str, root: &Path, node_path: &Path, target_script: &Path) -> Child {
    Command::new(env::current_exe().unwrap())
        .arg("job_bound_shell_fixture")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env(FIXTURE_MODE_ENV, mode)
        .env(FIXTURE_GO_ENV, root.join("go.marker"))
        .env(FIXTURE_READY_ENV, root.join("ready.json"))
        .env(FIXTURE_STOP_ENV, root.join("stop.marker"))
        .env(FIXTURE_NODE_ENV, node_path)
        .env(FIXTURE_SCRIPT_ENV, root.join("host-guardian.mjs"))
        .env(FIXTURE_CONTROL_ENV, root.join("control.json"))
        .env(FIXTURE_HISTORY_ENV, root.join("restart-history.json"))
        .env(FIXTURE_INCIDENT_ENV, root.join("last-incident.json"))
        .env(FIXTURE_TARGET_ENV, target_script)
        .env(FIXTURE_MARKER_ENV, root.join("restart-marker.json"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn run_spawn_fixture() {
    let go_path = required_fixture_path(FIXTURE_GO_ENV);
    let ready_path = required_fixture_path(FIXTURE_READY_ENV);
    let stop_path = required_fixture_path(FIXTURE_STOP_ENV);
    let node_path = required_fixture_path(FIXTURE_NODE_ENV);
    let target_script = required_fixture_path(FIXTURE_TARGET_ENV);
    let marker_path = required_fixture_path(FIXTURE_MARKER_ENV);
    wait_for_path(&go_path, Duration::from_secs(10));

    let mut command = Command::new(&node_path);
    command
        .arg(target_script)
        .arg(marker_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let result = match spawn_guardian_command(&mut command) {
        Ok(mut child) => json!({
            "spawned": true,
            "processId": child.id(),
            "exited": wait_for_child_exit(&mut child, Duration::from_secs(5))
        }),
        Err(error) => json!({
            "spawned": false,
            "rawOsError": error.raw_os_error(),
            "error": error.to_string()
        }),
    };
    write_json(&ready_path, result);
    wait_for_path(&stop_path, Duration::from_secs(10));
}

fn run_restart_fixture() {
    let go_path = required_fixture_path(FIXTURE_GO_ENV);
    let ready_path = required_fixture_path(FIXTURE_READY_ENV);
    let node_path = required_fixture_path(FIXTURE_NODE_ENV);
    let guardian_script = required_fixture_path(FIXTURE_SCRIPT_ENV);
    let control_path = required_fixture_path(FIXTURE_CONTROL_ENV);
    let history_path = required_fixture_path(FIXTURE_HISTORY_ENV);
    let incident_path = required_fixture_path(FIXTURE_INCIDENT_ENV);
    let target_script = required_fixture_path(FIXTURE_TARGET_ENV);
    let marker_path = required_fixture_path(FIXTURE_MARKER_ENV);
    wait_for_path(&go_path, Duration::from_secs(10));

    let parent_process_id = std::process::id();
    let token = "A".repeat(43);
    write_json(
        &control_path,
        json!({
            "schemaVersion": "scr.host-guardian-control/v1",
            "token": token,
            "intent": "restart",
            "reason": RESTART_REASON,
            "parentPid": parent_process_id,
            "updatedAtUnixMs": SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
                .to_string(),
            "restartRequestId": "R".repeat(43)
        }),
    );

    let mut command = Command::new(&node_path);
    command
        .arg(guardian_script)
        .arg("--parent-pid")
        .arg(parent_process_id.to_string())
        .arg("--shell")
        .arg(&node_path)
        .arg("--control")
        .arg(control_path)
        .arg("--history")
        .arg(history_path)
        .arg("--incident")
        .arg(incident_path)
        .arg("--token")
        .arg(token)
        .arg("--restart-delays-ms")
        .arg("50")
        .arg("--restart-arg")
        .arg(target_script)
        .arg("--restart-arg")
        .arg(marker_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut guardian = spawn_guardian_command(&mut command).expect("Guardian fixture did not start");
    write_json(&ready_path, json!({ "processId": guardian.id() }));

    loop {
        if let Some(status) = guardian.try_wait().unwrap() {
            panic!("Guardian fixture exited before its shell job closed: {status}");
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn job_bound_shell_fixture() {
    match env::var(FIXTURE_MODE_ENV).as_deref() {
        Ok("spawn") => run_spawn_fixture(),
        Ok("restart") => run_restart_fixture(),
        Ok(mode) => panic!("Unknown Guardian fixture mode: {mode}"),
        Err(_) => {}
    }
}

#[test]
fn guardian_command_starts_when_the_shell_job_denies_explicit_breakaway() {
    if env::var_os(FIXTURE_MODE_ENV).is_some() {
        return;
    }

    let root = tempdir().unwrap();
    let target_script = root.path().join("restart-target.mjs");
    fs::write(
        &target_script,
        "import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[2], JSON.stringify({ pid: process.pid }), 'utf8');\n",
    )
    .unwrap();
    let node_path = node_executable();
    let mut shell = start_fixture("spawn", root.path(), &node_path, &target_script);
    let job = JobObject::new(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).unwrap();
    job.assign(&shell).unwrap();
    fs::write(root.path().join("go.marker"), b"go").unwrap();

    let ready_path = root.path().join("ready.json");
    let result = wait_for_json(&ready_path, Duration::from_secs(10), |_| true);
    assert_eq!(
        result.get("spawned").and_then(Value::as_bool),
        Some(true),
        "Guardian command did not start: {result}"
    );
    assert_eq!(result.get("exited").and_then(Value::as_bool), Some(true));
    wait_for_json(
        &root.path().join("restart-marker.json"),
        Duration::from_secs(5),
        |_| true,
    );
    fs::write(root.path().join("stop.marker"), b"stop").unwrap();
    assert!(wait_for_child_exit(&mut shell, Duration::from_secs(5)));
    drop(job);
}

#[test]
fn guardian_consumes_second_restart_after_silent_job_breakaway() {
    if env::var_os(FIXTURE_MODE_ENV).is_some() {
        return;
    }

    let root = tempdir().unwrap();
    let guardian_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("host-guardian.mjs");
    fs::copy(&guardian_script, root.path().join("host-guardian.mjs")).unwrap();
    let history_path = root.path().join("restart-history.json");
    let incident_path = root.path().join("last-incident.json");
    let target_script = root.path().join("restart-target.mjs");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let first_restart_at = now.saturating_sub(1_000);
    write_json(
        &history_path,
        json!({
            "schemaVersion": "scr.host-guardian-history/v1",
            "updatedAt": "2026-09-02T22:59:03.658Z",
            "restartWindowMs": 600000,
            "restartTimestamps": [first_restart_at]
        }),
    );
    write_json(
        &incident_path,
        json!({
            "schemaVersion": "scr.host-guardian-incident/v1",
            "occurredAt": "2026-09-02T22:59:04.134Z",
            "outcome": "restarted",
            "reason": RESTART_REASON,
            "shellPath": "fixture-shell",
            "restartedProcessId": 63704,
            "restartDelayMs": 2000,
            "restartCountInWindow": 1
        }),
    );
    fs::write(
        &target_script,
        "import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[2], JSON.stringify({ pid: process.pid, parentPid: process.ppid }), 'utf8');\n",
    )
    .unwrap();

    let node_path = node_executable();
    let mut shell = start_fixture("restart", root.path(), &node_path, &target_script);
    let job =
        JobObject::new(JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
            .unwrap();
    job.assign(&shell).unwrap();
    fs::write(root.path().join("go.marker"), b"go").unwrap();
    let ready = wait_for_json(
        &root.path().join("ready.json"),
        Duration::from_secs(10),
        |_| true,
    );
    let guardian_process_id = ready["processId"].as_u64().unwrap() as u32;
    let _guardian_cleanup = ExactProcessCleanup(Some(guardian_process_id));
    let acknowledged = wait_for_json(
        &root.path().join("control.json"),
        Duration::from_secs(5),
        |value| {
            value
                .get("guardianObservedRequestId")
                .and_then(Value::as_str)
                == value.get("restartRequestId").and_then(Value::as_str)
                && value.get("guardianProcessId").and_then(Value::as_u64)
                    == Some(u64::from(guardian_process_id))
                && value
                    .get("guardianObservedAtUnixMs")
                    .and_then(Value::as_str)
                    .is_some()
        },
    );
    assert_eq!(
        acknowledged
            .get("guardianObservedRequestId")
            .and_then(Value::as_str),
        Some("RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR")
    );

    drop(job);
    assert!(
        wait_for_child_exit(&mut shell, Duration::from_secs(5)),
        "The job-bound shell fixture did not exit when its job closed."
    );

    let history = wait_for_json(&history_path, Duration::from_secs(10), |value| {
        value
            .get("restartTimestamps")
            .and_then(Value::as_array)
            .is_some_and(|timestamps| timestamps.len() == 2)
    });
    let incident = wait_for_json(&incident_path, Duration::from_secs(10), |value| {
        value.get("outcome").and_then(Value::as_str) == Some("restarted")
            && value.get("reason").and_then(Value::as_str) == Some(RESTART_REASON)
            && value.get("restartCountInWindow").and_then(Value::as_u64) == Some(2)
    });
    let marker = wait_for_json(
        &root.path().join("restart-marker.json"),
        Duration::from_secs(10),
        |_| true,
    );
    wait_for_absent(&root.path().join("control.json"), Duration::from_secs(5));
    let history_temporary_path = PathBuf::from(format!(
        "{}.{}.tmp",
        history_path.to_string_lossy(),
        guardian_process_id
    ));

    let timestamps = history["restartTimestamps"].as_array().unwrap();
    assert_eq!(timestamps[0].as_u64(), Some(first_restart_at));
    assert!(timestamps[1].as_u64().unwrap() >= first_restart_at);
    assert_eq!(
        incident["restartedProcessId"].as_u64(),
        marker["pid"].as_u64()
    );
    assert_eq!(
        marker["parentPid"].as_u64(),
        Some(u64::from(guardian_process_id))
    );
    assert!(!history_temporary_path.exists());
}

#[test]
fn prepare_restart_refuses_a_dead_guardian_process() {
    if env::var_os(FIXTURE_MODE_ENV).is_some() {
        return;
    }

    let root = tempdir().unwrap();
    let control_path = root.path().join("control.json");
    let incident_path = root.path().join("last-incident.json");
    let mut child = Command::new("cmd.exe")
        .args(["/d", "/c", "exit 0"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _ = child.wait().unwrap();

    let guardian = HostGuardian {
        inner: Arc::new(HostGuardianInner {
            enabled: true,
            child: Mutex::new(Some(child)),
            control_path: Some(control_path.clone()),
            incident_path: Some(incident_path),
            token: Some("D".repeat(43)),
            parent_process_id: std::process::id(),
            shutdown_started: AtomicBool::new(false),
        }),
    };

    assert!(!guardian.is_enabled());
    let error = guardian.prepare_restart(RESTART_REASON).unwrap_err();
    assert!(
        error.contains("not running") || error.contains("no longer running"),
        "unexpected error: {error}"
    );
    assert!(!control_path.exists());
}
