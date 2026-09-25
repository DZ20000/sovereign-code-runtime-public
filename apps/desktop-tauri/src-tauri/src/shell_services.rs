use std::{collections::HashMap, thread, time::Duration as StdDuration};

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};

use crate::{process_metrics, runtime_host::RuntimeHost};

const CLIPBOARD_SECRET_TTL_SECONDS: i64 = 60;

pub fn copy_connection_bundle(app: &AppHandle, runtime: &RuntimeHost) -> Result<Value, String> {
    let bundle = runtime.call("connection.bundle", json!({}))?;
    let serialized = bundle
        .get("serialized")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "Runtime Host returned an invalid serialized connection bundle.".to_string()
        })?
        .to_string();
    let endpoint = bundle
        .get("endpoint")
        .and_then(Value::as_str)
        .ok_or_else(|| "Runtime Host returned an invalid connection endpoint.".to_string())?
        .to_string();
    let target = bundle
        .get("target")
        .and_then(Value::as_str)
        .ok_or_else(|| "Runtime Host returned an invalid connection target.".to_string())?
        .to_string();
    if target != "local" && target != "web-bridge" {
        return Err("Runtime Host returned an unknown connection target.".into());
    }

    app.clipboard()
        .write_text(serialized.clone())
        .map_err(|error| format!("Could not copy the Sovereign connection bundle: {error}"))?;

    let copied_at = OffsetDateTime::now_utc();
    let clears_at = copied_at + Duration::seconds(CLIPBOARD_SECRET_TTL_SECONDS);
    let clipboard = app.clone();
    let expected = serialized;
    thread::spawn(move || {
        thread::sleep(StdDuration::from_secs(CLIPBOARD_SECRET_TTL_SECONDS as u64));
        let current = clipboard.clipboard().read_text().ok();
        if current.as_deref() == Some(expected.as_str()) {
            let _ = clipboard.clipboard().write_text(String::new());
        }
    });

    Ok(json!({
        "schemaVersion": "scr.connection/v1",
        "endpoint": endpoint,
        "target": target,
        "copiedAt": copied_at
            .format(&Rfc3339)
            .map_err(|error| format!("Could not format clipboard timestamp: {error}"))?,
        "clipboardClearsAt": clears_at
            .format(&Rfc3339)
            .map_err(|error| format!("Could not format clipboard expiry timestamp: {error}"))?
    }))
}

pub fn resource_snapshot(
    runtime: &RuntimeHost,
    guardian_process_id: Option<u32>,
) -> Result<Value, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not resolve the current Sovereign executable: {error}"))?;
    let executable_path = executable.to_string_lossy().to_string();
    let launch_kind = if executable
        .parent()
        .is_some_and(|parent| parent.join("portable-package.json").is_file())
    {
        "portable"
    } else if executable
        .parent()
        .is_some_and(|parent| parent.join("uninstall.exe").is_file())
    {
        "installed"
    } else if executable_path
        .replace('/', "\\")
        .to_ascii_lowercase()
        .contains("\\apps\\desktop-tauri\\src-tauri\\target\\")
    {
        "development"
    } else {
        "unknown"
    };
    let owned = runtime.call("owned-processes.list", json!({}))?;
    let mut known = HashMap::<u32, (String, String)>::new();
    known.insert(
        std::process::id(),
        ("desktop-main".into(), "Tauri desktop shell".into()),
    );
    if let Some(runtime_pid) = runtime.process_id() {
        known.insert(
            runtime_pid,
            ("runtime-host".into(), "Node Runtime Host".into()),
        );
    }
    if let Some(guardian_pid) = guardian_process_id {
        known.insert(
            guardian_pid,
            ("host-guardian".into(), "Host Guardian".into()),
        );
    }
    if let Some(entries) = owned.as_array() {
        for entry in entries {
            let Some(process_id) = entry.get("processId").and_then(Value::as_u64) else {
                continue;
            };
            if process_id == 0 || process_id > u32::MAX as u64 {
                continue;
            }
            let role = entry
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("other-owned")
                .to_string();
            let label = entry
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("Runtime-owned process")
                .to_string();
            known.insert(process_id as u32, (role, label));
        }
    }

    let tree = process_metrics::process_tree(std::process::id())?;
    let mut processes = Vec::<Value>::new();
    let mut seen = std::collections::HashSet::<u32>::new();
    let mut shell_working = 0u64;
    let mut shell_private = 0u64;
    let mut runtime_working = 0u64;
    let mut runtime_private = 0u64;
    let mut service_working = 0u64;
    let mut service_private = 0u64;

    for process in &tree {
        seen.insert(process.process_id);
        let (role, label) = known
            .get(&process.process_id)
            .cloned()
            .unwrap_or_else(|| classify_descendant(&process.executable));
        let memory = process_metrics::memory(process.process_id);
        let working = memory.map(|entry| entry.working_set_bytes).unwrap_or(0);
        let private = memory.map(|entry| entry.private_bytes);
        add_totals(
            &role,
            working,
            private.unwrap_or(0),
            &mut shell_working,
            &mut shell_private,
            &mut runtime_working,
            &mut runtime_private,
            &mut service_working,
            &mut service_private,
        );
        processes.push(json!({
            "processId": process.process_id,
            "role": role,
            "label": label,
            "workingSetBytes": working,
            "privateBytes": private,
            "cpuPercent": null
        }));
    }

    for (process_id, (role, label)) in known {
        if seen.contains(&process_id) {
            continue;
        }
        let memory = process_metrics::memory(process_id);
        let working = memory.map(|entry| entry.working_set_bytes).unwrap_or(0);
        let private = memory.map(|entry| entry.private_bytes);
        add_totals(
            &role,
            working,
            private.unwrap_or(0),
            &mut shell_working,
            &mut shell_private,
            &mut runtime_working,
            &mut runtime_private,
            &mut service_working,
            &mut service_private,
        );
        processes.push(json!({
            "processId": process_id,
            "role": role,
            "label": label,
            "workingSetBytes": working,
            "privateBytes": private,
            "cpuPercent": null
        }));
    }
    processes.sort_by_key(|entry| entry.get("processId").and_then(Value::as_u64).unwrap_or(0));

    let captured_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| format!("Could not format resource timestamp: {error}"))?;
    Ok(json!({
        "schemaVersion": "scr.resources/v1",
        "capturedAt": captured_at,
        "uptimeMs": runtime.uptime_ms(),
        "runtimePlacement": "sidecar",
        "shellExecutablePath": executable_path,
        "shellLaunchKind": launch_kind,
        "processes": processes,
        "totals": {
            "shellWorkingSetBytes": shell_working,
            "shellPrivateBytes": shell_private,
            "runtimeWorkingSetBytes": runtime_working,
            "runtimePrivateBytes": runtime_private,
            "serviceWorkingSetBytes": service_working,
            "servicePrivateBytes": service_private,
            "productWorkingSetBytes": shell_working + runtime_working + service_working,
            "productPrivateBytes": shell_private + runtime_private + service_private,
            "processCount": processes.len()
        }
    }))
}

fn classify_descendant(executable: &str) -> (String, String) {
    if executable.eq_ignore_ascii_case("msedgewebview2.exe") {
        ("renderer".into(), "WebView2 process".into())
    } else {
        ("other-owned".into(), executable.to_string())
    }
}

#[allow(clippy::too_many_arguments)]
fn add_totals(
    role: &str,
    working: u64,
    private: u64,
    shell_working: &mut u64,
    shell_private: &mut u64,
    runtime_working: &mut u64,
    runtime_private: &mut u64,
    service_working: &mut u64,
    service_private: &mut u64,
) {
    match role {
        "desktop-main" | "renderer" | "gpu" | "utility" => {
            *shell_working += working;
            *shell_private += private;
        }
        "runtime-host" => {
            *runtime_working += working;
            *runtime_private += private;
        }
        _ => {
            *service_working += working;
            *service_private += private;
        }
    }
}
