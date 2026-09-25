use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use crate::dpapi;

pub(crate) mod lifecycle;

const PROTOCOL_VERSION: u64 = 1;
pub(crate) const fn protocol_version() -> u64 {
    PROTOCOL_VERSION
}
const MAX_LINE_BYTES: usize = 1_048_576;
const MAX_LOG_CHARS: usize = 32_768;
const CONTROL_METHODS: &[&str] = &[
    "state.get",
    "runtime.start",
    "runtime.stop",
    "workspace.choose",
    "project.workspaces.read",
    "project.workspace.choose",
    "project.workspace.select",
    "connection.bundle",
    "credential.rotate",
    "settings.auto-start",
    "settings.unattended-workspace-access",
    "settings.web-bridge",
    "tunnel.configure",
    "tunnel.automation",
    "tunnel.executable.choose",
    "tunnel.start",
    "tunnel.stop",
    "tunnel.refresh",
    "permission.set",
    "manifest.get",
    "runs.list",
    "runs.get",
    "runs.cancel",
    "tasks.snapshot",
    "tasks.get",
    "tasks.coordination.operator-inbox",
    "tasks.message.user",
    "tool.invoke",
    "audit.list",
    "owned-processes.list",
    "cutover.status",
    "cutover.quiesce",
    "cutover.drain",
    "cutover.checkpoint",
    "cutover.detach",
    "cutover.resume",
    "cutover.promote",
    "cutover.canary",
    "shutdown",
];

#[derive(Clone)]
pub struct RuntimeHost {
    inner: Arc<RuntimeHostInner>,
}

struct RuntimeHostInner {
    app: AppHandle,
    session: String,
    instance_id: String,
    release_id: String,
    runtime_script_sha256: String,
    gateway_bearer_token: String,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<String, mpsc::SyncSender<Result<Value, String>>>>,
    state: Mutex<Value>,
    log_tail: Mutex<String>,
    next_id: AtomicU64,
    last_event_sequence: AtomicU64,
    closing: AtomicBool,
    healthy: AtomicBool,
    emit_state_events: AtomicBool,
    approval: crate::approval::ApprovalSurface,
    started_at: Instant,
}

#[derive(Clone, Debug)]
pub(crate) struct RuntimeHostCandidate {
    pub release_id: String,
    pub instance_id: String,
    pub slot_root: PathBuf,
    pub runtime_script_sha256: String,
    pub promotion_fencing_token: String,
}

impl RuntimeHostCandidate {
    pub(crate) fn from_verified_slot(
        release_id: impl Into<String>,
        slot_root: PathBuf,
        runtime_script_sha256: impl Into<String>,
    ) -> Result<Self, String> {
        let release_id = release_id.into();
        let runtime_script_sha256 = runtime_script_sha256.into();
        validate_runtime_identifier(&release_id, "Runtime candidate release ID")?;
        validate_runtime_sha256(&runtime_script_sha256, "Runtime candidate bundle digest")?;
        let candidate = Self {
            release_id,
            instance_id: generate_runtime_identifier("runtime-candidate")?,
            slot_root,
            runtime_script_sha256,
            promotion_fencing_token: generate_session_secret()?,
        };
        verified_candidate_runtime_script(&candidate)?;
        Ok(candidate)
    }
}

#[derive(Clone, Debug)]
struct RuntimeHostLaunchOptions {
    session: String,
    gateway_bearer_token: String,
    instance_id: String,
    release_id: String,
    role: &'static str,
    promotion_fencing_token: Option<String>,
    user_data: PathBuf,
    workspace_root: PathBuf,
    environment_workspace_root: Option<PathBuf>,
    node_executable: PathBuf,
    runtime_script: PathBuf,
    runtime_script_sha256: String,
    native_agent: PathBuf,
    migrate_legacy_data: bool,
}

fn secure_tunnel_placeholder() -> Value {
    json!({
        "phase": "unavailable",
        "clientAvailable": false,
        "executablePath": null,
        "executableSha256": null,
        "executableTrusted": false,
        "tunnelId": null,
        "processId": null,
        "hasRuntimeApiKey": false,
        "runtimeApiKeyStorage": "none",
        "controlPlaneProxyConfigured": false,
        "controlPlaneProxyDisplay": null,
        "controlPlaneProxyStorage": "none",
        "controlPlaneBackupProxyConfigured": false,
        "controlPlaneBackupProxyDisplay": null,
        "controlPlaneBackupProxyStorage": "none",
        "controlPlaneDirectFallbackEnabled": false,
        "controlPlaneRouting": {
            "schemaVersion": "scr.control-plane-routing/v1",
            "enabled": false,
            "lifecycle": "stopped",
            "routeOrder": ["direct"],
            "activeRoute": null,
            "activeRouteDisplay": null,
            "switchCount": 0,
            "lastSwitchAt": null,
            "circuitReason": null,
            "routes": {
                "primary": {
                    "configured": false,
                    "display": "Primary proxy · not configured",
                    "status": "disabled"
                },
                "backup": {
                    "configured": false,
                    "display": "Backup proxy · not configured",
                    "status": "disabled"
                },
                "direct": {
                    "configured": true,
                    "display": "Direct",
                    "status": "untested"
                }
            }
        },
        "autoStart": false,
        "autoReconnect": true,
        "desiredRunning": false,
        "reconnectAttempt": 0,
        "nextReconnectAt": null,
        "lastReadyAt": null,
        "healthUrl": null,
        "errorMessage": null,
        "failureDiagnostic": null,
        "logTail": ""
    })
}

fn state_placeholder(message: &str) -> Value {
    let secure_tunnel = secure_tunnel_placeholder();
    json!({
        "phase": "starting",
        "runtimeVersion": "0.1.0",
        "workspaceRoot": null,
        "endpoint": null,
        "manifestDigest": null,
        "toolCount": 0,
        "sessionCount": 0,
        "capabilities": [],
        "tokenStorage": "main-process-memory",
        "credentialGeneration": 0,
        "autoStart": true,
        "unattendedWorkspaceAccess": false,
        "permissionProfile": "observe",
        "webBridgeUrl": null,
        "secureTunnel": secure_tunnel,
        "errorMessage": message
    })
}

fn bounded_append(current: &mut String, next: &str) {
    current.push_str(next);
    if current.len() > MAX_LOG_CHARS {
        let keep_from = current.len().saturating_sub(MAX_LOG_CHARS);
        let mut boundary = keep_from;
        while !current.is_char_boundary(boundary) && boundary < current.len() {
            boundary += 1;
        }
        current.drain(..boundary);
    }
}

fn protocol_error(message: impl Into<String>) -> String {
    format!("Runtime Host protocol error: {}", message.into())
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

fn generate_session_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Could not generate Runtime Host session secret: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn generate_runtime_identifier(prefix: &str) -> Result<String, String> {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Could not generate Runtime Host identity: {error}"))?;
    Ok(format!(
        "{prefix}-{}-{}",
        std::process::id(),
        hex::encode(bytes)
    ))
}

fn valid_runtime_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().enumerate().all(|(index, byte)| {
            (index == 0 && (byte.is_ascii_alphanumeric()))
                || (index > 0
                    && (byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')))
        })
}

fn validate_runtime_identifier(value: &str, label: &str) -> Result<(), String> {
    if !valid_runtime_identifier(value) {
        return Err(format!("{label} is invalid."));
    }
    Ok(())
}

fn validate_runtime_sha256(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{label} must be a lowercase SHA-256 digest."));
    }
    Ok(())
}

fn validate_runtime_fencing_token(value: &str) -> Result<(), String> {
    if value.len() != 43
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(
            "Runtime Host promotion fencing token must be canonical 256-bit base64url.".into(),
        );
    }
    Ok(())
}

#[cfg(windows)]
fn reject_runtime_reparse_point(metadata: &std::fs::Metadata, label: &str) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT_VALUE: u32 = 0x400;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT_VALUE != 0 {
        return Err(format!("{label} may not be a Windows reparse point."));
    }
    Ok(())
}

#[cfg(not(windows))]
fn reject_runtime_reparse_point(metadata: &std::fs::Metadata, label: &str) -> Result<(), String> {
    if metadata.file_type().is_symlink() {
        return Err(format!("{label} may not be a symbolic link."));
    }
    Ok(())
}

fn hash_regular_runtime_file(path: &Path, label: &str) -> Result<String, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect {label}: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err(format!("{label} is missing, empty, or not a regular file."));
    }
    reject_runtime_reparse_point(&metadata, label)?;
    let mut file = File::open(path).map_err(|error| format!("Could not open {label}: {error}"))?;
    let opened = file
        .metadata()
        .map_err(|error| format!("Could not inspect opened {label}: {error}"))?;
    if !opened.is_file() || opened.len() != metadata.len() {
        return Err(format!("{label} changed before verification."));
    }
    let mut digest = Sha256::new();
    let copied = std::io::copy(&mut file, &mut digest)
        .map_err(|error| format!("Could not hash {label}: {error}"))?;
    if copied != metadata.len() {
        return Err(format!("{label} changed during verification."));
    }
    let after = file
        .metadata()
        .map_err(|error| format!("Could not re-check {label}: {error}"))?;
    if after.len() != metadata.len() {
        return Err(format!("{label} changed after verification."));
    }
    Ok(hex::encode(digest.finalize()))
}

fn verified_candidate_runtime_script(candidate: &RuntimeHostCandidate) -> Result<PathBuf, String> {
    validate_runtime_identifier(&candidate.release_id, "Runtime candidate release ID")?;
    validate_runtime_identifier(&candidate.instance_id, "Runtime candidate instance ID")?;
    validate_runtime_sha256(
        &candidate.runtime_script_sha256,
        "Runtime candidate bundle digest",
    )?;
    validate_runtime_fencing_token(&candidate.promotion_fencing_token)?;

    let slot_metadata = std::fs::symlink_metadata(&candidate.slot_root)
        .map_err(|error| format!("Could not inspect Runtime candidate slot: {error}"))?;
    if !slot_metadata.is_dir() {
        return Err("Runtime candidate slot is not a directory.".into());
    }
    reject_runtime_reparse_point(&slot_metadata, "Runtime candidate slot")?;
    let slot_root = std::fs::canonicalize(&candidate.slot_root)
        .map_err(|error| format!("Could not canonicalize Runtime candidate slot: {error}"))?;
    let runtime_script = slot_root.join("runtime-host.cjs");
    let canonical_script = std::fs::canonicalize(&runtime_script)
        .map_err(|error| format!("Could not canonicalize Runtime candidate bundle: {error}"))?;
    if canonical_script.parent() != Some(slot_root.as_path()) {
        return Err("Runtime candidate bundle escaped its verified slot root.".into());
    }
    let observed = hash_regular_runtime_file(&canonical_script, "Runtime candidate bundle")?;
    if observed != candidate.runtime_script_sha256 {
        return Err("Runtime candidate bundle failed its expected SHA-256 check.".into());
    }
    Ok(node_compatible_path(canonical_script))
}

fn write_message(inner: &RuntimeHostInner, message: &Value) -> Result<(), String> {
    let line = serde_json::to_string(message)
        .map_err(|error| format!("Could not serialize Runtime Host protocol message: {error}"))?;
    if line.len() > MAX_LINE_BYTES {
        return Err(protocol_error("outgoing message exceeds 1 MiB"));
    }
    let mut stdin = inner
        .stdin
        .lock()
        .map_err(|_| "Runtime Host stdin lock is poisoned.".to_string())?;
    let writer = stdin
        .as_mut()
        .ok_or_else(|| "Runtime Host stdin is unavailable.".to_string())?;
    writer
        .write_all(line.as_bytes())
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Could not write to Runtime Host: {error}"))
}

fn validate_envelope<'a>(
    inner: &RuntimeHostInner,
    value: &'a Value,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    let record = value
        .as_object()
        .ok_or_else(|| protocol_error("message must be an object"))?;
    if record.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(protocol_error("unsupported protocol version"));
    }
    if record.get("session").and_then(Value::as_str) != Some(inner.session.as_str()) {
        return Err(protocol_error("session secret mismatch"));
    }
    Ok(record)
}

fn update_error_state(inner: &RuntimeHostInner, message: String) {
    inner.healthy.store(false, Ordering::SeqCst);
    let next = {
        let current = inner.state.lock().ok().map(|state| state.clone());
        match current {
            Some(Value::Object(mut record)) => {
                record.insert("phase".into(), Value::String("error".into()));
                record.insert("endpoint".into(), Value::Null);
                record.insert("sessionCount".into(), json!(0));
                record.insert("errorMessage".into(), Value::String(message));
                Value::Object(record)
            }
            _ => state_placeholder(&message),
        }
    };
    if let Ok(mut state) = inner.state.lock() {
        *state = next.clone();
    }
    if inner.emit_state_events.load(Ordering::SeqCst) {
        let _ = inner.app.emit("runtime-state-changed", next);
    }
}

fn respond(inner: &RuntimeHostInner, id: &str, result: Result<Value, String>) {
    let message = match result {
        Ok(value) => json!({
            "v": PROTOCOL_VERSION,
            "session": inner.session,
            "kind": "response",
            "id": id,
            "ok": true,
            "result": value
        }),
        Err(error) => json!({
            "v": PROTOCOL_VERSION,
            "session": inner.session,
            "kind": "response",
            "id": id,
            "ok": false,
            "error": { "code": "SHELL_ERROR", "message": error }
        }),
    };
    let _ = write_message(inner, &message);
}

fn choose_path(app: &AppHandle, connector: bool) -> Result<Value, String> {
    let mut dialog = app.dialog().file().set_can_create_directories(!connector);
    if connector {
        dialog = dialog
            .set_title("Choose OpenAI Secure MCP Tunnel connector")
            .add_filter("tunnel-client.exe", &["exe"]);
        match dialog.blocking_pick_file() {
            Some(path) => path
                .into_path()
                .map(|path| Value::String(path.to_string_lossy().into_owned()))
                .map_err(|error| format!("Selected connector path is invalid: {error}")),
            None => Ok(Value::Null),
        }
    } else {
        match dialog
            .set_title("Choose an authorized workspace")
            .blocking_pick_folder()
        {
            Some(path) => path
                .into_path()
                .map(|path| Value::String(path.to_string_lossy().into_owned()))
                .map_err(|error| format!("Selected workspace path is invalid: {error}")),
            None => Ok(Value::Null),
        }
    }
}

fn prompt_response(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let record = params
        .as_object()
        .ok_or_else(|| "Prompt request must be an object.".to_string())?;
    let title = record
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| "Prompt title is invalid.".to_string())?;
    let message = record
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| "Prompt message is invalid.".to_string())?;
    let detail = record.get("detail").and_then(Value::as_str).unwrap_or("");
    let buttons = record
        .get("buttons")
        .and_then(Value::as_array)
        .ok_or_else(|| "Prompt buttons are invalid.".to_string())?;
    let labels: Vec<String> = buttons
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| "Prompt button label is invalid.".to_string())
        })
        .collect::<Result<_, _>>()?;
    if labels.is_empty() || labels.len() > 3 {
        return Err("Prompt must contain one through three buttons.".into());
    }
    let default_id = record
        .get("defaultId")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "Prompt defaultId is invalid.".to_string())?;
    let cancel_id = record
        .get("cancelId")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "Prompt cancelId is invalid.".to_string())?;
    if default_id >= labels.len() || cancel_id >= labels.len() {
        return Err("Prompt defaultId/cancelId is outside the button range.".into());
    }

    let mut custom_map = HashMap::<String, usize>::new();
    let (button_config, affirmative_index, negative_index, cancel_index) = match labels.as_slice() {
        [only] if default_id == 0 && cancel_id == 0 => {
            custom_map.insert(only.clone(), 0);
            (MessageDialogButtons::OkCustom(only.clone()), 0, 0, 0)
        }
        [first, second] if default_id == 0 && cancel_id == 1 => {
            custom_map.insert(first.clone(), 0);
            custom_map.insert(second.clone(), 1);
            (
                MessageDialogButtons::OkCancelCustom(first.clone(), second.clone()),
                0,
                1,
                1,
            )
        }
        [first, second] if default_id == cancel_id => {
            let safe_index = cancel_id;
            let action_index = if safe_index == 0 { 1 } else { 0 };
            let safe_label = labels[safe_index].clone();
            let action_label = labels[action_index].clone();
            let close_label = if safe_label.eq_ignore_ascii_case("Cancel") {
                "Close".to_string()
            } else {
                "Cancel".to_string()
            };
            custom_map.insert(safe_label.clone(), safe_index);
            custom_map.insert(action_label.clone(), action_index);
            custom_map.insert(close_label.clone(), safe_index);
            (
                MessageDialogButtons::YesNoCancelCustom(safe_label, action_label, close_label),
                safe_index,
                action_index,
                safe_index,
            )
        }
        [first, second, third] if default_id == 0 && cancel_id == 2 => {
            custom_map.insert(first.clone(), 0);
            custom_map.insert(second.clone(), 1);
            custom_map.insert(third.clone(), 2);
            (
                MessageDialogButtons::YesNoCancelCustom(
                    first.clone(),
                    second.clone(),
                    third.clone(),
                ),
                0,
                1,
                2,
            )
        }
        _ => return Ok(json!(cancel_id)),
    };

    let kind = match record.get("type").and_then(Value::as_str) {
        Some("warning") => MessageDialogKind::Warning,
        _ => MessageDialogKind::Info,
    };
    let body = if detail.is_empty() {
        message.to_string()
    } else {
        format!("{message}\n\n{detail}")
    };
    let result = app
        .dialog()
        .message(body)
        .title(title)
        .kind(kind)
        .buttons(button_config)
        .blocking_show_with_result();
    let index = match result {
        MessageDialogResult::Custom(label) => custom_map.get(&label).copied(),
        MessageDialogResult::Ok | MessageDialogResult::Yes => Some(affirmative_index),
        MessageDialogResult::No => Some(negative_index),
        MessageDialogResult::Cancel => Some(cancel_index),
    }
    .unwrap_or(cancel_id);
    Ok(json!(index))
}

fn handle_shell_request(inner: Arc<RuntimeHostInner>, id: String, method: String, params: Value) {
    let result = match method.as_str() {
        "workspace.choose" => choose_path(&inner.app, false),
        "tunnel.executable.choose" => choose_path(&inner.app, true),
        "secret.protect" => match params.get("value").and_then(Value::as_str) {
            Some(value) => Ok(dpapi::protect_string(value)
                .map(Value::String)
                .unwrap_or(Value::Null)),
            None => Err("Secret protect value is invalid.".to_string()),
        },
        "secret.restore" => match params.get("encoded").and_then(Value::as_str) {
            Some(encoded) => Ok(match dpapi::unprotect_string(encoded) {
                Ok(value) => json!({
                    "value": value,
                    "encoded": encoded
                }),
                Err(_) => Value::Null,
            }),
            None => Err("Secret restore ciphertext is invalid.".to_string()),
        },
        "prompt" => prompt_response(&inner.app, &params),
        "approval.present" => Ok(inner.approval.present(&id, params.clone())),
        _ => Err(format!("Unknown Runtime Host shell request: {method}")),
    };
    respond(&inner, &id, result);
}

fn handle_protocol_message(
    inner: Arc<RuntimeHostInner>,
    value: Value,
    ready: &mpsc::SyncSender<Result<Value, String>>,
) -> Result<(), String> {
    let record = validate_envelope(&inner, &value)?;
    match record.get("kind").and_then(Value::as_str) {
        Some("response") => {
            let id = record
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| protocol_error("response id is invalid"))?;
            let sender = inner
                .pending
                .lock()
                .map_err(|_| "Runtime Host pending-request lock is poisoned.".to_string())?
                .remove(id);
            if let Some(sender) = sender {
                let response = if record.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(record.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(record
                        .get("error")
                        .and_then(Value::as_object)
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("Runtime Host request failed.")
                        .to_string())
                };
                let _ = sender.send(response);
            }
        }
        Some("event") => {
            let sequence = record
                .get("sequence")
                .and_then(Value::as_u64)
                .ok_or_else(|| protocol_error("event sequence is invalid"))?;
            let previous = inner.last_event_sequence.swap(sequence, Ordering::SeqCst);
            if sequence <= previous {
                return Err(protocol_error("event sequence repeated or moved backwards"));
            }
            let event = record
                .get("event")
                .and_then(Value::as_str)
                .ok_or_else(|| protocol_error("event name is invalid"))?;
            let payload = record.get("payload").cloned().unwrap_or(Value::Null);
            match event {
                "state.changed" => {
                    if let Ok(mut state) = inner.state.lock() {
                        *state = payload.clone();
                    }
                    if inner.emit_state_events.load(Ordering::SeqCst) {
                        let _ = inner.app.emit("runtime-state-changed", payload);
                    }
                }
                "host.ready" => {
                    let state = payload
                        .get("state")
                        .cloned()
                        .ok_or_else(|| protocol_error("host.ready state is missing"))?;
                    if let Ok(mut current) = inner.state.lock() {
                        *current = state.clone();
                    }
                    inner.healthy.store(true, Ordering::SeqCst);
                    let _ = ready.send(Ok(state.clone()));
                    if inner.emit_state_events.load(Ordering::SeqCst) {
                        let _ = inner.app.emit("runtime-state-changed", state);
                    }
                }
                "host.log" => {
                    if let Some(message) = payload.as_str() {
                        if let Ok(mut log) = inner.log_tail.lock() {
                            bounded_append(&mut log, message);
                        }
                    }
                }
                _ => return Err(protocol_error(format!("unknown event: {event}"))),
            }
        }
        Some("request") => {
            let id = record
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| protocol_error("shell request id is invalid"))?
                .to_string();
            let method = record
                .get("method")
                .and_then(Value::as_str)
                .ok_or_else(|| protocol_error("shell request method is invalid"))?
                .to_string();
            let params = record.get("params").cloned().unwrap_or_else(|| json!({}));
            let request_inner = inner.clone();
            thread::spawn(move || handle_shell_request(request_inner, id, method, params));
        }
        Some("cancel") => {
            let id = record
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| protocol_error("cancel id is invalid"))?;
            inner.approval.cancel_shell_request(id);
        }
        _ => return Err(protocol_error("unknown message kind")),
    }
    Ok(())
}

impl RuntimeHost {
    pub fn start(app: AppHandle) -> Result<Self, String> {
        let options = Self::default_launch_options(&app)?;
        Self::start_with_options(app, options)
    }

    pub(crate) fn start_candidate(
        app: AppHandle,
        candidate: &RuntimeHostCandidate,
        gateway_bearer_token: &str,
    ) -> Result<Self, String> {
        validate_runtime_fencing_token(gateway_bearer_token)?;
        let runtime_script = verified_candidate_runtime_script(candidate)?;
        let mut options = Self::default_launch_options(&app)?;
        options.session = generate_session_secret()?;
        options.gateway_bearer_token = gateway_bearer_token.to_string();
        options.instance_id = candidate.instance_id.clone();
        options.release_id = candidate.release_id.clone();
        options.role = "candidate";
        options.promotion_fencing_token = Some(candidate.promotion_fencing_token.clone());
        options.runtime_script = runtime_script;
        options.runtime_script_sha256 = candidate.runtime_script_sha256.clone();
        options.migrate_legacy_data = false;
        Self::start_with_options(app, options)
    }

    fn default_launch_options(app: &AppHandle) -> Result<RuntimeHostLaunchOptions, String> {
        let explicit_user_data = std::env::var_os("SCR_USER_DATA_PATH")
            .or_else(|| std::env::var_os("SCR_RESOURCE_BENCHMARK_USER_DATA"));
        let user_data = match explicit_user_data.as_ref() {
            Some(path) => PathBuf::from(path),
            None => app
                .path()
                .app_data_dir()
                .map_err(|error| format!("Could not resolve Tauri app data directory: {error}"))?,
        };
        let user_data = node_compatible_path(user_data);

        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace_root = manifest_dir
            .ancestors()
            .nth(3)
            .ok_or_else(|| "Could not resolve Sovereign workspace root for Tauri POC.".to_string())?
            .to_path_buf();
        let environment_workspace_root = std::env::var_os("SCR_WORKSPACE_ROOT").map(PathBuf::from);
        let (node_executable, runtime_script, native_agent) = if cfg!(debug_assertions) {
            (
                PathBuf::from("node"),
                workspace_root.join("apps/runtime-host/dist/bundle/runtime-host.cjs"),
                workspace_root.join("apps/desktop/native/bin/SovereignNativeAgent.exe"),
            )
        } else {
            let resources = app
                .path()
                .resource_dir()
                .map_err(|error| format!("Could not resolve Tauri resources directory: {error}"))?;
            (
                resources.join("node/node.exe"),
                resources.join("runtime-host.cjs"),
                resources.join("native/bin/SovereignNativeAgent.exe"),
            )
        };
        let node_executable = node_compatible_path(node_executable);
        let runtime_script = node_compatible_path(runtime_script);
        let native_agent = node_compatible_path(native_agent);

        if !cfg!(debug_assertions) && !node_executable.is_file() {
            return Err(format!(
                "Portable Node runtime is missing: {}",
                node_executable.display()
            ));
        }
        if !runtime_script.is_file() {
            return Err(format!(
                "Runtime Host bundle is missing: {}",
                runtime_script.display()
            ));
        }
        if !native_agent.is_file() {
            return Err(format!(
                "Native agent is missing: {}",
                native_agent.display()
            ));
        }
        let runtime_script_sha256 =
            hash_regular_runtime_file(&runtime_script, "Runtime Host bundle")?;

        Ok(RuntimeHostLaunchOptions {
            session: generate_session_secret()?,
            gateway_bearer_token: generate_session_secret()?,
            instance_id: generate_runtime_identifier("runtime-active")?,
            release_id: format!("runtime-{}", env!("CARGO_PKG_VERSION")),
            role: "active",
            promotion_fencing_token: None,
            user_data,
            workspace_root,
            environment_workspace_root,
            node_executable,
            runtime_script,
            runtime_script_sha256,
            native_agent,
            migrate_legacy_data: explicit_user_data.is_none(),
        })
    }

    fn start_with_options(
        app: AppHandle,
        options: RuntimeHostLaunchOptions,
    ) -> Result<Self, String> {
        validate_runtime_fencing_token(&options.gateway_bearer_token)?;
        validate_runtime_identifier(&options.instance_id, "Runtime Host instance ID")?;
        validate_runtime_identifier(&options.release_id, "Runtime Host release ID")?;
        validate_runtime_sha256(&options.runtime_script_sha256, "Runtime Host bundle digest")?;
        if options.role != "active" && options.role != "candidate" {
            return Err("Runtime Host cutover role is invalid.".into());
        }
        if options.role == "candidate" {
            validate_runtime_fencing_token(
                options.promotion_fencing_token.as_deref().ok_or_else(|| {
                    "Passive Runtime Host candidate requires a promotion fencing token.".to_string()
                })?,
            )?;
        } else if options.promotion_fencing_token.is_some() {
            return Err("Active Runtime Host may not receive a promotion fencing token.".into());
        }
        let observed_runtime_sha256 =
            hash_regular_runtime_file(&options.runtime_script, "Runtime Host bundle")?;
        if observed_runtime_sha256 != options.runtime_script_sha256 {
            return Err("Runtime Host bundle changed before launch.".into());
        }
        if options.migrate_legacy_data {
            crate::migration::migrate_legacy_electron_data_if_needed(
                &options.node_executable,
                &options.user_data,
            )?;
        }
        std::fs::create_dir_all(&options.user_data)
            .map_err(|error| format!("Could not create Tauri app data directory: {error}"))?;

        let mut command = Command::new(&options.node_executable);
        command
            .arg(&options.runtime_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("SCR_CONTROL_SESSION_SECRET", &options.session)
            .env("SCR_CONTROL_USER_DATA_PATH", &options.user_data)
            .env("SCR_CONTROL_NATIVE_AGENT_PATH", &options.native_agent)
            .env("SCR_CONTROL_PARENT_PID", std::process::id().to_string())
            .env(
                "SCR_RUNTIME_GATEWAY_BEARER_TOKEN",
                &options.gateway_bearer_token,
            )
            .env("SCR_RUNTIME_INSTANCE_ID", &options.instance_id)
            .env("SCR_RUNTIME_RELEASE_ID", &options.release_id)
            .env("SCR_RUNTIME_CUTOVER_ROLE", options.role);
        if let Some(promotion_fencing_token) = options.promotion_fencing_token.as_ref() {
            command.env(
                "SCR_RUNTIME_PROMOTION_FENCING_TOKEN",
                promotion_fencing_token,
            );
        }
        if let Some(environment_workspace_root) = options.environment_workspace_root.as_ref() {
            command.env("SCR_WORKSPACE_ROOT", environment_workspace_root);
        } else if cfg!(debug_assertions) {
            command.env("SCR_WORKSPACE_ROOT", &options.workspace_root);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start Node Runtime Host: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Runtime Host stdin was not created.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Runtime Host stdout was not created.".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Runtime Host stderr was not created.".to_string())?;

        let emit_state_events = options.role == "active";
        let inner = Arc::new(RuntimeHostInner {
            app: app.clone(),
            session: options.session,
            instance_id: options.instance_id,
            release_id: options.release_id,
            runtime_script_sha256: options.runtime_script_sha256,
            gateway_bearer_token: options.gateway_bearer_token,
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            state: Mutex::new(state_placeholder("Waiting for Node Runtime Host.")),
            log_tail: Mutex::new(String::new()),
            next_id: AtomicU64::new(1),
            last_event_sequence: AtomicU64::new(0),
            closing: AtomicBool::new(false),
            healthy: AtomicBool::new(false),
            emit_state_events: AtomicBool::new(emit_state_events),
            approval: crate::approval::ApprovalSurface::new(app),
            started_at: Instant::now(),
        });
        let host = Self {
            inner: inner.clone(),
        };

        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<Value, String>>(1);
        let stdout_inner = inner.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(line) => line,
                    Err(error) => {
                        update_error_state(
                            &stdout_inner,
                            format!("Runtime Host stdout failed: {error}"),
                        );
                        break;
                    }
                };
                if line.len() > MAX_LINE_BYTES {
                    update_error_state(
                        &stdout_inner,
                        protocol_error("incoming message exceeds 1 MiB"),
                    );
                    break;
                }
                if line.is_empty() {
                    continue;
                }
                let parsed = match serde_json::from_str::<Value>(&line) {
                    Ok(value) => value,
                    Err(error) => {
                        update_error_state(
                            &stdout_inner,
                            protocol_error(format!("invalid JSON: {error}")),
                        );
                        break;
                    }
                };
                if let Err(error) = handle_protocol_message(stdout_inner.clone(), parsed, &ready_tx)
                {
                    update_error_state(&stdout_inner, error);
                    break;
                }
            }
            stdout_inner.healthy.store(false, Ordering::SeqCst);
            stdout_inner.approval.deny_all();
            if !stdout_inner.closing.load(Ordering::SeqCst) {
                update_error_state(
                    &stdout_inner,
                    "Runtime Host protocol pipe closed unexpectedly.".into(),
                );
            }
        });

        let stderr_inner = inner.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut log) = stderr_inner.log_tail.lock() {
                    bounded_append(&mut log, &format!("{line}\n"));
                }
            }
        });

        match ready_rx.recv_timeout(Duration::from_secs(20)) {
            Ok(Ok(state)) => {
                if let Ok(mut current) = inner.state.lock() {
                    *current = state;
                }
                Ok(host)
            }
            Ok(Err(error)) => {
                let _ = host.shutdown();
                Err(error)
            }
            Err(_) => {
                let log = inner
                    .log_tail
                    .lock()
                    .map(|log| log.clone())
                    .unwrap_or_default();
                let _ = host.shutdown();
                Err(format!(
                    "Node Runtime Host did not become ready within 20 seconds. {log}"
                ))
            }
        }
    }
    pub fn approval_current(&self) -> Result<Option<Value>, String> {
        self.inner.approval.current()
    }

    pub fn approval_resolve(&self, request_id: &str, decision: &str) -> Result<(), String> {
        self.inner.approval.resolve(request_id, decision)
    }

    pub fn uptime_ms(&self) -> u64 {
        self.inner
            .started_at
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64
    }

    pub(crate) fn instance_id(&self) -> String {
        self.inner.instance_id.clone()
    }

    pub(crate) fn release_id(&self) -> String {
        self.inner.release_id.clone()
    }

    pub(crate) fn runtime_script_sha256(&self) -> String {
        self.inner.runtime_script_sha256.clone()
    }

    pub(crate) fn gateway_bearer_token(&self) -> String {
        self.inner.gateway_bearer_token.clone()
    }

    pub(crate) fn enable_state_events(&self) {
        self.inner.emit_state_events.store(true, Ordering::SeqCst);
        if let Ok(state) = self.inner.state.lock() {
            let _ = self.inner.app.emit("runtime-state-changed", state.clone());
        }
    }

    pub fn process_id(&self) -> Option<u32> {
        self.inner
            .child
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(Child::id))
    }

    pub fn is_process_alive(&self) -> bool {
        let Ok(mut child) = self.inner.child.lock() else {
            return false;
        };
        match child.as_mut() {
            Some(child) => child.try_wait().ok().flatten().is_none(),
            None => false,
        }
    }

    pub fn is_healthy(&self) -> bool {
        !self.inner.closing.load(Ordering::SeqCst)
            && self.inner.healthy.load(Ordering::SeqCst)
            && self.is_process_alive()
    }

    pub fn ping(&self) -> Result<Value, String> {
        self.call_with_timeout("state.get", json!({}), Duration::from_secs(5))
    }

    pub fn refresh_tunnel(&self) -> Result<Value, String> {
        self.call_with_timeout("tunnel.refresh", json!({}), Duration::from_secs(10))
    }

    pub fn refresh_tunnel_after_network_change(&self) -> Result<Value, String> {
        self.call_with_timeout(
            "tunnel.refresh",
            json!({ "networkChanged": true }),
            Duration::from_secs(20),
        )
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let timeout = if method == "shutdown" {
            Duration::from_secs(30)
        } else {
            Duration::from_secs(310)
        };
        self.call_with_timeout(method, params, timeout)
    }

    fn call_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !CONTROL_METHODS.contains(&method) {
            return Err(format!("Unknown Runtime Host control method: {method}"));
        }
        if self.inner.closing.load(Ordering::SeqCst) {
            return Err("Runtime Host is shutting down.".into());
        }
        let id = format!(
            "tauri-{}",
            self.inner.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = mpsc::sync_channel(1);
        self.inner
            .pending
            .lock()
            .map_err(|_| "Runtime Host pending-request lock is poisoned.".to_string())?
            .insert(id.clone(), tx);
        let message = json!({
            "v": PROTOCOL_VERSION,
            "session": self.inner.session,
            "kind": "request",
            "id": id,
            "method": method,
            "params": params
        });
        if let Err(error) = write_message(&self.inner, &message) {
            if let Ok(mut pending) = self.inner.pending.lock() {
                pending.remove(&id);
            }
            self.inner.healthy.store(false, Ordering::SeqCst);
            return Err(error);
        }
        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                if let Ok(mut pending) = self.inner.pending.lock() {
                    pending.remove(&id);
                }
                Err(format!("Runtime Host request timed out: {method}"))
            }
        }
    }
}
