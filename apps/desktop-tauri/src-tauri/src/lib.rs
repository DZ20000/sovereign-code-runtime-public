mod approval;
mod availability;
mod benchmark;
mod dpapi;
mod host_guardian;
mod migration;
mod process_metrics;
mod process_security;
mod renderer_update;
mod runtime_candidate_owner;
mod runtime_candidate_update;
mod runtime_endpoint_router;
mod runtime_health;
mod runtime_host;
mod runtime_host_supervisor;
mod shell_services;
mod startup;

use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, State, WebviewWindow, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use approval::assert_approval_sender;
use availability::HostAvailability;
use host_guardian::HostGuardian;
use renderer_update::{
    RendererHandoff, RendererUpdateManager, RendererUpdateStatus, RENDERER_PROTOCOL_SCHEME,
};
use runtime_candidate_owner::{
    activate_verified_runtime_candidate, restore_active_runtime_candidate,
    startup_restore_requires_abort,
};
use runtime_candidate_update::{
    RuntimeCandidateActivationReceipt, RuntimeCandidateInstallReceipt,
    RuntimeCandidateUpdateManager, RuntimeCandidateUpdateStatus,
};
use runtime_endpoint_router::{RuntimeEndpointRouter, RuntimeHostEndpoint, RuntimeRollingService};
use runtime_health::start_runtime_health_monitor;
use runtime_host::RuntimeHost;
use runtime_host_supervisor::RuntimeHostSupervisor;

const EXIT_MODE_RUNNING: u8 = 0;
const EXIT_MODE_INTENTIONAL: u8 = 1;
const EXIT_MODE_GUARDIAN_RESTART: u8 = 2;
const GUARDIAN_RESTART_EXIT_CODE: i32 = 70;
const EXIT_FOR_RESTART_ARGUMENT: &str = "--exit-for-restart";

const UPDATE_PREFLIGHT_SCHEMA_VERSION: &str = "scr.update-preflight-evidence/v1";
const UPDATE_PREFLIGHT_FLAG: &str = "SCR_UPDATE_PREFLIGHT";
const UPDATE_PREFLIGHT_RELEASE_ID: &str = "SCR_UPDATE_PREFLIGHT_RELEASE_ID";
const UPDATE_PREFLIGHT_RELEASE_SEQUENCE: &str = "SCR_UPDATE_PREFLIGHT_RELEASE_SEQUENCE";
const UPDATE_PREFLIGHT_MANIFEST_SHA256: &str = "SCR_UPDATE_PREFLIGHT_MANIFEST_SHA256";

#[derive(Clone, Debug, PartialEq, Eq)]
struct UpdatePreflightMetadata {
    release_id: String,
    release_sequence: u64,
    manifest_sha256: String,
}

fn valid_update_release_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
}

fn parse_update_preflight_values(
    flag: Option<&str>,
    release_id: Option<&str>,
    release_sequence: Option<&str>,
    manifest_sha256: Option<&str>,
) -> Result<Option<UpdatePreflightMetadata>, String> {
    let values_present = flag.is_some()
        || release_id.is_some()
        || release_sequence.is_some()
        || manifest_sha256.is_some();
    if !values_present {
        return Ok(None);
    }
    if flag != Some("1") {
        return Err("Candidate preflight requires SCR_UPDATE_PREFLIGHT=1.".into());
    }
    let release_id = release_id
        .filter(|value| valid_update_release_id(value))
        .ok_or_else(|| "Candidate preflight release ID is missing or invalid.".to_string())?;
    let release_sequence = release_sequence
        .ok_or_else(|| "Candidate preflight release sequence is missing.".to_string())?
        .parse::<u64>()
        .map_err(|_| "Candidate preflight release sequence is invalid.".to_string())?;
    if release_sequence == 0 {
        return Err("Candidate preflight release sequence must be positive.".into());
    }
    let manifest_sha256 = manifest_sha256
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| "Candidate preflight manifest SHA-256 is missing or invalid.".to_string())?;
    Ok(Some(UpdatePreflightMetadata {
        release_id: release_id.to_string(),
        release_sequence,
        manifest_sha256: manifest_sha256.to_string(),
    }))
}

fn update_preflight_environment_present() -> bool {
    [
        UPDATE_PREFLIGHT_FLAG,
        UPDATE_PREFLIGHT_RELEASE_ID,
        UPDATE_PREFLIGHT_RELEASE_SEQUENCE,
        UPDATE_PREFLIGHT_MANIFEST_SHA256,
    ]
    .iter()
    .any(|name| std::env::var_os(name).is_some())
}

fn update_preflight_from_environment() -> Result<Option<UpdatePreflightMetadata>, String> {
    let read = |name: &str| -> Result<Option<String>, String> {
        std::env::var_os(name)
            .map(|value| {
                value.into_string().map_err(|_| {
                    format!("Candidate preflight environment value is not Unicode: {name}")
                })
            })
            .transpose()
    };
    let flag = read(UPDATE_PREFLIGHT_FLAG)?;
    let release_id = read(UPDATE_PREFLIGHT_RELEASE_ID)?;
    let release_sequence = read(UPDATE_PREFLIGHT_RELEASE_SEQUENCE)?;
    let manifest_sha256 = read(UPDATE_PREFLIGHT_MANIFEST_SHA256)?;
    parse_update_preflight_values(
        flag.as_deref(),
        release_id.as_deref(),
        release_sequence.as_deref(),
        manifest_sha256.as_deref(),
    )
}

fn exit_for_restart_requested(arguments: &[String]) -> bool {
    arguments
        .iter()
        .any(|argument| argument == EXIT_FOR_RESTART_ARGUMENT)
}

#[derive(Clone, Default)]
struct UiReadiness(Arc<Mutex<Option<Value>>>);

impl UiReadiness {
    fn set(&self, payload: Value) -> Result<(), String> {
        let mut slot = self
            .0
            .lock()
            .map_err(|_| "UI readiness state lock is poisoned.".to_string())?;
        *slot = Some(payload);
        Ok(())
    }

    fn snapshot(&self) -> Option<Value> {
        self.0.lock().ok().and_then(|slot| slot.clone())
    }
}

#[derive(Default)]
struct ApplicationLifecycle {
    exit_mode: AtomicU8,
}

impl ApplicationLifecycle {
    fn exit_mode(&self) -> u8 {
        self.exit_mode.load(Ordering::SeqCst)
    }

    fn guardian_shutdown_requested(&self) -> bool {
        self.exit_mode() == EXIT_MODE_INTENTIONAL
    }

    fn begin_intentional_exit(&self) {
        let _ = self.exit_mode.compare_exchange(
            EXIT_MODE_RUNNING,
            EXIT_MODE_INTENTIONAL,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }

    fn begin_guardian_restart(&self) -> bool {
        self.exit_mode
            .compare_exchange(
                EXIT_MODE_RUNNING,
                EXIT_MODE_GUARDIAN_RESTART,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }
}

fn guard_standard_user_launch(app: &tauri::App) -> bool {
    let elevation = process_security::is_process_elevated();
    if matches!(elevation, Ok(false)) {
        return false;
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let (title, body) = match elevation {
        Ok(true) => (
            "请普通启动 Sovereign / Start normally".to_string(),
            "Sovereign 不允许以管理员身份运行。管理员模式会让远程 Agent 和子进程继承管理员权限，也可能因 Windows / WebView2 完整性级别不同而打开另一套界面偏好，因此看起来像界面变化或权限选项消失。普通实例中的配置并未因此删除。\n\n请退出此管理员实例，然后从开始菜单普通启动 Sovereign Code Runtime。此程序不需要管理员权限。\n\nSovereign does not run elevated. Administrator mode would grant remote Agent tools and child processes administrator rights and can open a separate Windows/WebView2 preference context. Exit this instance and launch Sovereign normally from the Start menu.".to_string(),
        ),
        Err(error) => (
            "无法确认启动权限 / Launch integrity unavailable".to_string(),
            format!(
                "Sovereign 无法确认当前进程是否以管理员身份运行，因此已停止启动。请从开始菜单普通启动。\n\nSovereign could not verify the current process integrity level and stopped before starting the Runtime Host. Launch it normally from the Start menu.\n\nDiagnostic: {error}"
            ),
        ),
        Ok(false) => unreachable!(),
    };
    let _ = app
        .dialog()
        .message(body)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCustom(
            "退出管理员实例 / Exit".to_string(),
        ))
        .blocking_show_with_result();
    app.state::<ApplicationLifecycle>().begin_intentional_exit();
    app.handle().exit(0);
    true
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(
        app,
        "guardian-open",
        "打开 Sovereign / Open",
        true,
        None::<&str>,
    )?;
    let exit = MenuItem::with_id(
        app,
        "guardian-exit",
        "退出 Sovereign / Exit",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&open, &exit])?;
    let mut builder = TrayIconBuilder::with_id("sovereign-host")
        .tooltip("Sovereign Code Runtime")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "guardian-open" => show_main_window(app),
            "guardian-exit" => {
                app.state::<ApplicationLifecycle>().begin_intentional_exit();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let _ = builder.build(app)?;
    Ok(())
}

fn write_guardian_integration_report(
    directory: &PathBuf,
    file_name: &str,
    report: &Value,
) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| {
        format!("Could not create Host Guardian integration report directory: {error}")
    })?;
    let path = directory.join(file_name);
    let temporary = directory.join(format!("{file_name}.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(report).map_err(|error| {
        format!("Could not serialize Host Guardian integration report: {error}")
    })?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write Host Guardian integration report: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not publish Host Guardian integration report: {error}"))
}

fn start_guardian_integration_report(
    app: AppHandle,
    runtime: RuntimeHost,
    guardian: HostGuardian,
    availability: HostAvailability,
    directory: PathBuf,
) {
    thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let mut state_result = runtime.call("state.get", json!({}));
        while state_result
            .as_ref()
            .ok()
            .and_then(|state| state.get("phase"))
            .and_then(Value::as_str)
            .is_some_and(|phase| phase == "starting")
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(150));
            state_result = runtime.call("state.get", json!({}));
        }
        if state_result
            .as_ref()
            .ok()
            .and_then(|state| state.get("phase"))
            .and_then(Value::as_str)
            == Some("stopped")
        {
            state_result = runtime.call("runtime.start", json!({}));
        }
        while state_result
            .as_ref()
            .ok()
            .and_then(|state| state.get("phase"))
            .and_then(Value::as_str)
            .is_some_and(|phase| phase == "starting")
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(150));
            state_result = runtime.call("state.get", json!({}));
        }

        let restart_count = std::env::var("SCR_GUARDIAN_RESTART_COUNT")
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0);
        let recovered = restart_count > 0;
        let phase = state_result
            .as_ref()
            .ok()
            .and_then(|state| state.get("phase"))
            .and_then(Value::as_str)
            .unwrap_or("error");
        let availability_state = availability.state();
        let availability_ready = availability_state.get("available").and_then(Value::as_bool)
            == Some(true)
            && availability_state
                .get("sampledAt")
                .is_some_and(|value| !value.is_null());
        let report = json!({
            "schemaVersion": "scr.host-guardian-integration/v1",
            "recovered": recovered,
            "ok": phase == "running" && runtime.is_healthy() && availability_ready,
            "shellProcessId": std::process::id(),
            "runtimeHostProcessId": runtime.process_id(),
            "guardianProcessId": guardian.process_id(),
            "restartCount": restart_count,
            "restartedAt": std::env::var("SCR_GUARDIAN_RESTARTED_AT").ok(),
            "state": state_result.as_ref().ok(),
            "stateError": state_result.as_ref().err(),
            "availability": availability_state
        });
        let file_name = if recovered {
            "recovered.json"
        } else {
            "initial.json"
        };
        if write_guardian_integration_report(&directory, file_name, &report).is_err() {
            app.state::<ApplicationLifecycle>().begin_intentional_exit();
            app.exit(2);
            return;
        }
        if recovered {
            thread::sleep(Duration::from_millis(750));
            app.state::<ApplicationLifecycle>().begin_intentional_exit();
            app.exit(if phase == "running" { 0 } else { 1 });
        }
    });
}

#[tauri::command]
fn ui_ready(
    window: WebviewWindow,
    readiness: State<'_, UiReadiness>,
    renderer_updates: State<'_, RendererUpdateManager>,
    payload: Value,
) -> Result<(), String> {
    let record = payload
        .as_object()
        .ok_or_else(|| "UI readiness payload must be an object.".to_string())?;
    let href = record
        .get("href")
        .and_then(Value::as_str)
        .ok_or_else(|| "UI readiness href is invalid.".to_string())?;
    let title = record
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| "UI readiness title is invalid.".to_string())?;
    let app_child_count = record
        .get("appChildCount")
        .and_then(Value::as_u64)
        .ok_or_else(|| "UI readiness appChildCount is invalid.".to_string())?;
    if href.len() > 2048 || title.len() > 256 || app_child_count > 100_000 {
        return Err("UI readiness payload exceeds bounds.".to_string());
    }
    renderer_updates.record_ui_ready(&window, &payload)?;
    if window.label() == "main" {
        readiness.set(payload)?;
    }
    Ok(())
}

#[tauri::command]
async fn control_call(
    runtime_router: State<'_, RuntimeEndpointRouter<RuntimeHostEndpoint>>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let supervisor = runtime_router.inner().clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.call(&method, params))
        .await
        .map_err(|error| format!("Runtime Host task failed: {error}"))?
}

fn renderer_preflight_control_allowed(method: &str, params: &Value) -> bool {
    match method {
        "state.get"
        | "manifest.get"
        | "audit.list"
        | "runs.list"
        | "runs.get"
        | "tasks.snapshot"
        | "tasks.get"
        | "tasks.coordination.operator-inbox" => true,
        "tool.invoke" => params
            .as_object()
            .and_then(|record| record.get("toolName"))
            .and_then(Value::as_str)
            .is_some_and(|tool_name| {
                matches!(
                    tool_name,
                    "terminal.session.list"
                        | "terminal.session.read"
                        | "python.capabilities"
                        | "browser.capabilities"
                        | "browser.session.list"
                        | "browser.observe"
                        | "workflow.templates"
                        | "computer.capabilities"
                        | "computer.observe"
                )
            }),
        _ => false,
    }
}

#[tauri::command]
async fn renderer_preflight_control_call(
    window: WebviewWindow,
    runtime_router: State<'_, RuntimeEndpointRouter<RuntimeHostEndpoint>>,
    renderer_updates: State<'_, RendererUpdateManager>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    renderer_updates.assert_active_preflight_window(window.label())?;
    if method.is_empty()
        || method.len() > 128
        || !renderer_preflight_control_allowed(&method, &params)
    {
        return Err(
            "Renderer preflight attempted a command outside its read-only allowlist.".into(),
        );
    }
    let supervisor = runtime_router.inner().clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.call(&method, params))
        .await
        .map_err(|error| format!("Renderer preflight Runtime Host task failed: {error}"))?
}

#[tauri::command]
fn renderer_update_status(
    renderer_updates: State<'_, RendererUpdateManager>,
) -> Result<RendererUpdateStatus, String> {
    Ok(renderer_updates.status())
}

#[tauri::command]
fn runtime_rolling_status(
    runtime_rolling: State<'_, RuntimeRollingService<RuntimeHostEndpoint>>,
) -> Result<runtime_host_supervisor::RuntimeHostRollingStatus, String> {
    Ok(runtime_rolling.status())
}

fn runtime_candidate_public_error(
    manager: &RuntimeCandidateUpdateManager,
    error: impl Into<String>,
) -> String {
    let code = manager.record_failure(error);
    format!("Runtime candidate operation failed ({code}).")
}

#[tauri::command]
fn runtime_candidate_update_status(
    runtime_updates: State<'_, RuntimeCandidateUpdateManager>,
) -> Result<RuntimeCandidateUpdateStatus, String> {
    Ok(runtime_updates.status())
}

#[tauri::command]
async fn install_runtime_candidate_update(
    runtime_updates: State<'_, RuntimeCandidateUpdateManager>,
    release_id: String,
) -> Result<RuntimeCandidateInstallReceipt, String> {
    let manager = runtime_updates.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .install_release(&release_id)
            .map_err(|error| runtime_candidate_public_error(&manager, error))
    })
    .await
    .map_err(|_| "Runtime candidate installation task failed.".to_string())?
}

#[tauri::command]
async fn activate_runtime_candidate_update(
    app: AppHandle,
    runtime_updates: State<'_, RuntimeCandidateUpdateManager>,
    runtime_supervisor: State<'_, RuntimeHostSupervisor>,
    guardian: State<'_, HostGuardian>,
    lifecycle: State<'_, ApplicationLifecycle>,
    release_id: String,
) -> Result<RuntimeCandidateActivationReceipt, String> {
    let manager = runtime_updates.inner().clone();
    let manager_for_task = manager.clone();
    let supervisor = runtime_supervisor.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        activate_verified_runtime_candidate(&manager_for_task, &supervisor, &release_id)
    })
    .await
    .map_err(|_| "Runtime candidate activation task failed.".to_string())?;

    match result {
        Ok(receipt) => Ok(receipt),
        Err(error) => {
            let requires_restart = runtime_host_supervisor::cutover_requires_restart(&error);
            let public_error = runtime_candidate_public_error(&manager, error);
            if requires_restart {
                if guardian.is_enabled() {
                    match guardian.prepare_restart("runtime-candidate-authority-unresolved") {
                        Ok(()) if lifecycle.begin_guardian_restart() => {
                            app.exit(GUARDIAN_RESTART_EXIT_CODE);
                        }
                        Ok(()) => {
                            let _ = guardian.cancel_restart();
                        }
                        Err(_) => {}
                    }
                } else if lifecycle.begin_guardian_restart() {
                    app.exit(1);
                }
            }
            Err(public_error)
        }
    }
}

#[tauri::command]
async fn renderer_update_install(
    renderer_updates: State<'_, RendererUpdateManager>,
    release_id: String,
) -> Result<RendererUpdateStatus, String> {
    let manager = renderer_updates.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.install(&release_id))
        .await
        .map_err(|error| format!("Renderer install task failed: {error}"))?
}

#[tauri::command]
async fn renderer_update_preflight(
    app: AppHandle,
    renderer_updates: State<'_, RendererUpdateManager>,
    release_id: String,
) -> Result<RendererUpdateStatus, String> {
    let manager = renderer_updates.inner().clone();
    let ticket = manager.begin_preflight(&app, &release_id)?;
    tauri::async_runtime::spawn_blocking(move || manager.await_preflight(&app, ticket))
        .await
        .map_err(|error| format!("Renderer preflight task failed: {error}"))?
}

#[tauri::command]
async fn renderer_update_activate(
    app: AppHandle,
    renderer_updates: State<'_, RendererUpdateManager>,
    release_id: String,
    handoff: Option<RendererHandoff>,
) -> Result<RendererUpdateStatus, String> {
    let manager = renderer_updates.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.activate(&app, &release_id, handoff))
        .await
        .map_err(|error| format!("Renderer activation task failed: {error}"))?
}

#[tauri::command]
async fn renderer_update_rollback(
    app: AppHandle,
    renderer_updates: State<'_, RendererUpdateManager>,
    handoff: Option<RendererHandoff>,
) -> Result<RendererUpdateStatus, String> {
    let manager = renderer_updates.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.rollback(&app, handoff))
        .await
        .map_err(|error| format!("Renderer rollback task failed: {error}"))?
}

#[tauri::command]
fn renderer_update_take_handoff(
    window: WebviewWindow,
    renderer_updates: State<'_, RendererUpdateManager>,
) -> Result<Option<RendererHandoff>, String> {
    renderer_updates.take_handoff(window.label())
}

#[tauri::command]
async fn resource_snapshot(
    runtime_router: State<'_, RuntimeEndpointRouter<RuntimeHostEndpoint>>,
    guardian: State<'_, HostGuardian>,
) -> Result<Value, String> {
    let runtime_endpoint = runtime_router.inner().clone();
    let runtime = runtime_endpoint.active();
    let runtime_owner = serde_json::to_value(runtime_endpoint.owner_status())
        .map_err(|error| format!("Could not serialize Runtime Host owner status: {error}"))?;
    let guardian_process_id = guardian.process_id();
    tauri::async_runtime::spawn_blocking(move || {
        let mut snapshot = shell_services::resource_snapshot(&runtime, guardian_process_id)?;
        let record = snapshot
            .as_object_mut()
            .ok_or_else(|| "Resource snapshot must be an object.".to_string())?;
        record.insert("runtimeOwner".into(), runtime_owner);
        Ok(snapshot)
    })
    .await
    .map_err(|error| format!("Resource snapshot task failed: {error}"))?
}

fn attach_host_diagnostics(
    mut startup_state: Value,
    guardian: &HostGuardian,
    availability: &HostAvailability,
) -> Result<Value, String> {
    let record = startup_state
        .as_object_mut()
        .ok_or_else(|| "Host startup state must be an object.".to_string())?;
    record.insert("guardian".into(), guardian.state());
    record.insert("availability".into(), availability.state());
    Ok(startup_state)
}

#[tauri::command]
fn host_startup_state(
    guardian: State<'_, HostGuardian>,
    availability: State<'_, HostAvailability>,
) -> Result<Value, String> {
    attach_host_diagnostics(startup::state()?, guardian.inner(), availability.inner())
}

#[tauri::command]
fn host_startup_set(
    enabled: bool,
    guardian: State<'_, HostGuardian>,
    availability: State<'_, HostAvailability>,
) -> Result<Value, String> {
    attach_host_diagnostics(
        startup::set(enabled)?,
        guardian.inner(),
        availability.inner(),
    )
}

#[tauri::command]
async fn copy_connection_bundle(
    app: tauri::AppHandle,
    runtime_router: State<'_, RuntimeEndpointRouter<RuntimeHostEndpoint>>,
) -> Result<Value, String> {
    let runtime = runtime_router.inner().active();
    tauri::async_runtime::spawn_blocking(move || {
        shell_services::copy_connection_bundle(&app, &runtime)
    })
    .await
    .map_err(|error| format!("Connection bundle task failed: {error}"))?
}

#[tauri::command]
async fn approval_current(
    window: WebviewWindow,
    runtime_router: State<'_, RuntimeEndpointRouter<RuntimeHostEndpoint>>,
) -> Result<Option<Value>, String> {
    assert_approval_sender(&window)?;
    runtime_router.inner().approval_current()
}

#[tauri::command]
async fn approval_resolve(
    window: WebviewWindow,
    runtime_router: State<'_, RuntimeEndpointRouter<RuntimeHostEndpoint>>,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    assert_approval_sender(&window)?;
    runtime_router
        .inner()
        .approval_resolve(&request_id, &decision)
}

fn start_smoke_report(
    app: AppHandle,
    runtime: RuntimeHost,
    readiness: UiReadiness,
    availability: HostAvailability,
    guardian: HostGuardian,
    path: PathBuf,
    update_preflight: Result<Option<UpdatePreflightMetadata>, String>,
) {
    thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let mut state_result = runtime.call("state.get", json!({}));
        while state_result
            .as_ref()
            .ok()
            .and_then(|state| state.get("phase"))
            .and_then(Value::as_str)
            .is_some_and(|phase| phase == "starting")
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(150));
            state_result = runtime.call("state.get", json!({}));
        }
        if state_result
            .as_ref()
            .ok()
            .and_then(|state| state.get("phase"))
            .and_then(Value::as_str)
            == Some("stopped")
        {
            state_result = runtime.call("runtime.start", json!({}));
        }

        let mut ui_payload = readiness.snapshot();
        while ui_payload.is_none() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(100));
            ui_payload = readiness.snapshot();
        }
        let ui_ready = ui_payload.as_ref().is_some_and(|payload| {
            let href = payload
                .get("href")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let title = payload
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let ready_state = payload
                .get("readyState")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let app_child_count = payload
                .get("appChildCount")
                .and_then(Value::as_u64)
                .unwrap_or_default();
            let local_asset = href.starts_with("http://tauri.localhost/")
                || href.starts_with("https://tauri.localhost/")
                || href.starts_with("tauri://localhost/");
            local_asset
                && title == "Sovereign Code Runtime"
                && matches!(ready_state, "interactive" | "complete")
                && app_child_count > 0
        });

        let manifest_result = runtime.call("manifest.get", json!({}));
        let task_snapshot_result = runtime.call(
            "tasks.snapshot",
            json!({
                "offset": 0,
                "limit": 1
            }),
        );
        let resource_result = shell_services::resource_snapshot(&runtime, guardian.process_id());
        let availability_state = availability.state();
        let availability_ready = availability_state.get("available").and_then(Value::as_bool)
            == Some(true)
            && availability_state
                .get("sampledAt")
                .is_some_and(|value| !value.is_null());
        let (update_preflight_evidence, update_preflight_error) = match update_preflight {
            Ok(Some(metadata)) => match std::env::current_exe() {
                Ok(executable_path) => (
                    Some(json!({
                        "schemaVersion": UPDATE_PREFLIGHT_SCHEMA_VERSION,
                        "releaseId": metadata.release_id,
                        "releaseSequence": metadata.release_sequence,
                        "manifestSha256": metadata.manifest_sha256,
                        "executablePath": executable_path.to_string_lossy(),
                        "runtimeHostProtocolVersion": runtime_host::protocol_version()
                    })),
                    None,
                ),
                Err(error) => (
                    None,
                    Some(format!(
                        "Candidate preflight executable identity is unavailable: {error}"
                    )),
                ),
            },
            Ok(None) => (None, None),
            Err(error) => (None, Some(error)),
        };
        let ok = update_preflight_error.is_none()
            && state_result
                .as_ref()
                .ok()
                .and_then(|state| state.get("phase"))
                .and_then(Value::as_str)
                == Some("running")
            && manifest_result
                .as_ref()
                .ok()
                .is_some_and(|manifest| !manifest.is_null())
            && task_snapshot_result
                .as_ref()
                .ok()
                .and_then(|snapshot| snapshot.get("schemaVersion"))
                .and_then(Value::as_str)
                == Some("scr.task-workspace/v1")
            && resource_result.is_ok()
            && availability_ready
            && ui_ready;
        let report = json!({
            "schemaVersion": "scr.tauri-smoke/v1",
            "ok": ok,
            "uiReady": ui_ready,
            "ui": ui_payload,
            "state": state_result.as_ref().ok(),
            "stateError": state_result.as_ref().err(),
            "manifest": manifest_result.as_ref().ok(),
            "manifestError": manifest_result.as_ref().err(),
            "tasks": task_snapshot_result.as_ref().ok(),
            "tasksError": task_snapshot_result.as_ref().err(),
            "resources": resource_result.as_ref().ok(),
            "resourceError": resource_result.as_ref().err(),
            "availability": availability_state,
            "updatePreflight": update_preflight_evidence,
            "updatePreflightError": update_preflight_error
        });
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let write_result = serde_json::to_vec_pretty(&report)
            .map_err(|error| error.to_string())
            .and_then(|bytes| std::fs::write(&path, bytes).map_err(|error| error.to_string()));
        if write_result.is_err() {
            app.exit(2);
        } else {
            app.exit(if ok { 0 } else { 1 });
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_arguments = std::env::args().collect::<Vec<_>>();
    let exit_for_restart_on_startup = exit_for_restart_requested(&startup_arguments);
    let guardian_integration_directory =
        std::env::var_os("SCR_HOST_GUARDIAN_INTEGRATION_DIR").map(PathBuf::from);
    let update_preflight_requested = update_preflight_environment_present();
    let update_preflight = update_preflight_from_environment();
    let verified_update_preflight = update_preflight
        .as_ref()
        .ok()
        .and_then(|metadata| metadata.as_ref())
        .is_some();
    let isolated_test_process = std::env::var_os("SCR_SMOKE_REPORT_PATH").is_some()
        || std::env::var_os("SCR_APPROVAL_SMOKE_REPORT_PATH").is_some()
        || std::env::var_os("SCR_RESOURCE_BENCHMARK_SCENARIO").is_some()
        || guardian_integration_directory.is_some()
        || update_preflight_requested;
    let guardian_enabled = guardian_integration_directory.is_some()
        || verified_update_preflight
        || (!isolated_test_process && !cfg!(debug_assertions));
    let guardian_integration_directory_for_setup = guardian_integration_directory.clone();
    let update_preflight_for_setup = update_preflight.clone();
    let renderer_protocol_manager: Arc<Mutex<Option<RendererUpdateManager>>> =
        Arc::new(Mutex::new(None));
    let renderer_protocol_for_handler = renderer_protocol_manager.clone();
    let renderer_protocol_for_setup = renderer_protocol_manager.clone();
    let builder = tauri::Builder::default()
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("renderer-navigation-policy")
                .on_navigation(|webview, url| {
                    if let Some(manager) = webview.app_handle().try_state::<RendererUpdateManager>()
                    {
                        manager.navigation_authorized(webview.label(), url)
                    } else {
                        webview.label() == "main"
                            && renderer_update::navigation_allowed(webview.label(), url)
                    }
                })
                .build(),
        )
        .register_uri_scheme_protocol(RENDERER_PROTOCOL_SCHEME, move |context, request| {
            let manager = renderer_protocol_for_handler
                .lock()
                .ok()
                .and_then(|slot| slot.clone());
            match manager {
                Some(manager) => manager.protocol_response(context.webview_label(), request),
                None => tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::SERVICE_UNAVAILABLE)
                    .header(
                        tauri::http::header::CONTENT_TYPE,
                        "text/plain; charset=utf-8",
                    )
                    .header(tauri::http::header::CACHE_CONTROL, "no-store")
                    .body(b"Renderer update manager is not initialized.".to_vec())
                    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new())),
            }
        });
    let builder = if isolated_test_process {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(
            |app, arguments, _working_directory| {
                if exit_for_restart_requested(&arguments) {
                    app.state::<ApplicationLifecycle>().begin_intentional_exit();
                    app.exit(0);
                    return;
                }
                if arguments
                    .iter()
                    .any(|argument| argument == "--autostart" || argument == "--guardian-restart")
                {
                    return;
                }
                show_main_window(app);
            },
        ))
    };
    let app = builder
        .manage(UiReadiness::default())
        .manage(ApplicationLifecycle::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            if exit_for_restart_on_startup {
                app.state::<ApplicationLifecycle>().begin_intentional_exit();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                app.handle().exit(0);
                return Ok(());
            }
            if !isolated_test_process && guard_standard_user_launch(app) {
                return Ok(());
            }
            let background_launch = startup::is_background_launch()
                || guardian_integration_directory_for_setup.is_some();
            if background_launch {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            let smoke_path = std::env::var_os("SCR_SMOKE_REPORT_PATH").map(PathBuf::from);
            let renderer_updates = if isolated_test_process {
                RendererUpdateManager::isolated(app.handle())
            } else {
                RendererUpdateManager::new(app.handle())
            }
            .map_err(std::io::Error::other)?;
            {
                let mut slot = renderer_protocol_for_setup
                    .lock()
                    .map_err(|_| std::io::Error::other("Renderer protocol manager lock is poisoned."))?;
                *slot = Some(renderer_updates.clone());
            }
            app.manage(renderer_updates.clone());
            let readiness = app.state::<UiReadiness>().inner().clone();
            let benchmark_config = benchmark::config_from_environment().map_err(std::io::Error::other)?;
            let availability = HostAvailability::new(app.handle());
            app.manage(availability.clone());
            let guardian = match HostGuardian::start(app.handle(), guardian_enabled) {
                Ok(guardian) => guardian,
                Err(error) if guardian_integration_directory_for_setup.is_some() => {
                    return Err(std::io::Error::other(error).into());
                }
                Err(error) => {
                    eprintln!("Host Guardian unavailable; continuing without automatic shell recovery: {error}");
                    HostGuardian::disabled()
                }
            };
            app.manage(guardian.clone());
            let runtime_supervisor = match RuntimeHostSupervisor::start(app.handle().clone()) {
                Ok(supervisor) => supervisor,
                Err(error) => {
                    if let Some(path) = smoke_path.as_ref() {
                        if let Some(parent) = path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        let report = json!({
                            "schemaVersion": "scr.tauri-smoke/v1",
                            "ok": false,
                            "startupError": error
                        });
                        if let Ok(bytes) = serde_json::to_vec_pretty(&report) {
                            let _ = std::fs::write(path, bytes);
                        }
                    }
                    if let Some(config) = benchmark_config.as_ref() {
                        let failure_path = PathBuf::from(format!("{}.failure.txt", config.output_path.display()));
                        if let Some(parent) = failure_path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        let _ = std::fs::write(failure_path, format!("{error}\n"));
                    }
                    return Err(std::io::Error::other(error).into());
                }
            };
            let runtime_updates = RuntimeCandidateUpdateManager::new(app.handle())
                .map_err(std::io::Error::other)?;
            runtime_supervisor.set_rolling_enabled(runtime_updates.is_enabled());
            if let Err(error) =
                restore_active_runtime_candidate(&runtime_updates, &runtime_supervisor)
            {
                if startup_restore_requires_abort(&error) {
                    return Err(std::io::Error::other(error).into());
                }
                let recovery_code = runtime_updates
                    .recover_to_built_in(error)
                    .map_err(std::io::Error::other)?;
                eprintln!(
                    "Runtime candidate startup restore failed; continuing with the built-in Runtime Host ({recovery_code})."
                );
            }
            let runtime_endpoint = RuntimeHostEndpoint::new(runtime_supervisor.clone());
            let runtime_router = RuntimeEndpointRouter::new(runtime_endpoint);
            let runtime_rolling = RuntimeRollingService::new(runtime_router.clone());
            let runtime = runtime_supervisor.active();
            if let Ok(state) = runtime.ping() {
                availability.observe_runtime_state(&state);
            }
            if let Some(config) = benchmark_config {
                benchmark::start(app.handle().clone(), runtime.clone(), config);
            } else if let Some(path) = smoke_path {
                start_smoke_report(
                    app.handle().clone(),
                    runtime.clone(),
                    readiness,
                    availability.clone(),
                    guardian.clone(),
                    path,
                    update_preflight_for_setup.clone(),
                );
            }
            app.manage(runtime_supervisor.clone());
            app.manage(runtime_updates);
            app.manage(runtime_router);
            app.manage(runtime_rolling);
            if !isolated_test_process {
                renderer_updates
                    .start_active_renderer(app.handle(), !background_launch)
                    .map_err(std::io::Error::other)?;
            }
            if guardian.is_enabled() && !isolated_test_process {
                install_tray(app)?;
            }
            start_runtime_health_monitor(
                app.handle().clone(),
                runtime_supervisor.clone(),
                guardian.clone(),
                availability.clone(),
            );
            if let Some(directory) = guardian_integration_directory_for_setup.clone() {
                start_guardian_integration_report(
                    app.handle().clone(),
                    runtime,
                    guardian,
                    availability,
                    directory,
                );
            }
            Ok(())

        })
        .on_window_event(move |window, event| {
            if exit_for_restart_on_startup || window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. }
                    if !isolated_test_process
                        && window.state::<HostGuardian>().is_enabled()
                        && window.state::<ApplicationLifecycle>().exit_mode()
                            == EXIT_MODE_RUNNING =>
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
                WindowEvent::Destroyed => {
                    let runtime_router =
                        window.state::<RuntimeEndpointRouter<RuntimeHostEndpoint>>();
                    let _ = runtime_router.inner().shutdown();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            ui_ready,
            control_call,
            renderer_preflight_control_call,
            renderer_update_status,
            runtime_rolling_status,
            runtime_candidate_update_status,
            install_runtime_candidate_update,
            activate_runtime_candidate_update,
            renderer_update_install,
            renderer_update_preflight,
            renderer_update_activate,
            renderer_update_rollback,
            renderer_update_take_handoff,
            resource_snapshot,
            host_startup_state,
            host_startup_set,
            copy_connection_bundle,
            approval_current,
            approval_resolve
        ])
        .build(tauri::generate_context!())
        .expect("error while building Sovereign Tauri shell");

    app.run(move |app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. }) {
            let lifecycle = app_handle.state::<ApplicationLifecycle>();
            if exit_for_restart_on_startup {
                return;
            }
            let runtime_router = app_handle.state::<RuntimeEndpointRouter<RuntimeHostEndpoint>>();
            let _ = runtime_router.inner().shutdown();
            if lifecycle.guardian_shutdown_requested() {
                let guardian = app_handle.state::<HostGuardian>();
                let _ = guardian.shutdown();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        exit_for_restart_requested, parse_update_preflight_values,
        ApplicationLifecycle,
        UpdatePreflightMetadata, EXIT_FOR_RESTART_ARGUMENT, EXIT_MODE_RUNNING,
    };

    #[test]
    fn guardian_shutdown_requires_explicit_intentional_exit() {
        let lifecycle = ApplicationLifecycle::default();
        assert_eq!(lifecycle.exit_mode(), EXIT_MODE_RUNNING);
        assert!(!lifecycle.guardian_shutdown_requested());

        lifecycle.begin_intentional_exit();
        assert!(lifecycle.guardian_shutdown_requested());

        let restart = ApplicationLifecycle::default();
        assert!(restart.begin_guardian_restart());
        assert!(!restart.guardian_shutdown_requested());
    }

    #[test]
    fn parses_complete_update_preflight_metadata() {
        let digest = "a".repeat(64);
        assert_eq!(
            parse_update_preflight_values(
                Some("1"),
                Some("release-0002"),
                Some("2"),
                Some(&digest),
            ),
            Ok(Some(UpdatePreflightMetadata {
                release_id: "release-0002".into(),
                release_sequence: 2,
                manifest_sha256: digest,
            }))
        );
    }

    #[test]
    fn rejects_partial_or_noncanonical_update_preflight_metadata() {
        let digest = "a".repeat(64);
        assert!(parse_update_preflight_values(
            Some("1"),
            Some("release-0002"),
            None,
            Some(&digest)
        )
        .is_err());
        assert!(parse_update_preflight_values(
            Some("true"),
            Some("release-0002"),
            Some("2"),
            Some(&digest)
        )
        .is_err());
        assert!(parse_update_preflight_values(
            Some("1"),
            Some("Release-0002"),
            Some("2"),
            Some(&digest)
        )
        .is_err());
        assert!(parse_update_preflight_values(
            Some("1"),
            Some("release-0002"),
            Some("0"),
            Some(&digest)
        )
        .is_err());
        assert!(parse_update_preflight_values(
            Some("1"),
            Some("release-0002"),
            Some("2"),
            Some(&"A".repeat(64))
        )
        .is_err());
    }

    #[test]
    fn recognizes_only_the_explicit_restart_exit_argument() {
        assert!(exit_for_restart_requested(&[
            "SovereignCodeRuntime.exe".to_string(),
            EXIT_FOR_RESTART_ARGUMENT.to_string(),
        ]));
        assert!(!exit_for_restart_requested(&[
            "SovereignCodeRuntime.exe".to_string(),
            "--guardian-restart".to_string(),
        ]));
        assert!(!exit_for_restart_requested(&[
            "SovereignCodeRuntime.exe".to_string(),
            "--exit-for-restart=1".to_string(),
        ]));
    }
}
