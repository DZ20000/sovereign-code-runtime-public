use std::{
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

use serde_json::Value;
use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

const APPROVAL_WINDOW_LABEL: &str = "approval";
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct ApprovalSurface {
    app: AppHandle,
    pending: Arc<Mutex<Option<PendingApproval>>>,
}

struct PendingApproval {
    shell_request_id: String,
    presentation: Value,
    decision_tx: mpsc::SyncSender<String>,
}

impl ApprovalSurface {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Arc::new(Mutex::new(None)),
        }
    }

    pub fn present(&self, shell_request_id: &str, presentation: Value) -> Value {
        if !valid_presentation(&presentation) {
            return Value::String("deny".into());
        }

        let presentation_id = presentation
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let (decision_tx, decision_rx) = mpsc::sync_channel::<String>(1);
        {
            let mut pending = match self.pending.lock() {
                Ok(pending) => pending,
                Err(_) => return Value::String("deny".into()),
            };
            if pending.is_some() {
                return Value::String("deny".into());
            }
            *pending = Some(PendingApproval {
                shell_request_id: shell_request_id.to_string(),
                presentation,
                decision_tx,
            });
        }

        if self.open_window(&presentation_id).is_err() {
            self.deny_presentation(&presentation_id);
            return Value::String("deny".into());
        }

        let decision = decision_rx
            .recv_timeout(APPROVAL_TIMEOUT)
            .unwrap_or_else(|_| "deny".into());
        self.finish_if_pending(&presentation_id, "deny");
        self.close_window();
        Value::String(decision)
    }

    pub fn current(&self) -> Result<Option<Value>, String> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| "Approval state lock is poisoned.".to_string())?;
        Ok(pending.as_ref().map(|entry| entry.presentation.clone()))
    }

    pub fn resolve(&self, request_id: &str, decision: &str) -> Result<(), String> {
        if decision != "allow-once" && decision != "deny" && decision != "drop-to-l1" {
            return Err("Approval decision is invalid.".into());
        }
        let pending = {
            let mut guard = self
                .pending
                .lock()
                .map_err(|_| "Approval state lock is poisoned.".to_string())?;
            let entry = guard
                .as_ref()
                .ok_or_else(|| "No approval request is currently pending.".to_string())?;
            let active_id = entry
                .presentation
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Active approval request id is invalid.".to_string())?;
            if active_id != request_id {
                return Err("Approval request id is stale or invalid.".into());
            }
            if decision == "drop-to-l1"
                && entry
                    .presentation
                    .get("burstDetected")
                    .and_then(Value::as_bool)
                    != Some(true)
            {
                return Err("Drop-to-L1 is only available during approval flood handling.".into());
            }
            guard.take().expect("approval pending entry disappeared")
        };
        let _ = pending.decision_tx.send(decision.to_string());
        self.close_window();
        Ok(())
    }

    pub fn cancel_shell_request(&self, shell_request_id: &str) {
        let pending = {
            let mut guard = match self.pending.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            if guard
                .as_ref()
                .map(|entry| entry.shell_request_id.as_str())
                != Some(shell_request_id)
            {
                return;
            }
            guard.take()
        };
        if let Some(pending) = pending {
            let _ = pending.decision_tx.send("deny".into());
            self.close_window();
        }
    }

    pub fn deny_all(&self) {
        let pending = self.pending.lock().ok().and_then(|mut guard| guard.take());
        if let Some(pending) = pending {
            let _ = pending.decision_tx.send("deny".into());
        }
        self.close_window();
    }

    fn open_window(&self, presentation_id: &str) -> Result<(), String> {
        if let Some(existing) = self.app.get_webview_window(APPROVAL_WINDOW_LABEL) {
            let _ = existing.destroy();
        }

        let approval_smoke = std::env::var_os("SCR_APPROVAL_SMOKE_REPORT_PATH").is_some();
        let approval_url = if approval_smoke {
            "approval.html?approvalSmoke=allow-once"
        } else {
            "approval.html"
        };
        let mut builder = WebviewWindowBuilder::new(
            &self.app,
            APPROVAL_WINDOW_LABEL,
            WebviewUrl::App(approval_url.into()),
        )
        .title("Sovereign approval")
        .inner_size(560.0, 430.0)
        .center()
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .fullscreen(false)
        .skip_taskbar(true)
        .focused(true)
        .zoom_hotkeys_enabled(false)
        .devtools(false)
        .on_navigation(move |url| {
            if url.path() != "/approval.html" {
                return false;
            }
            let query_allowed = match url.query() {
                None => true,
                Some("approvalSmoke=allow-once") => approval_smoke,
                Some(_) => false,
            };
            if !query_allowed {
                return false;
            }
            let production_local =
                (url.scheme() == "http" || url.scheme() == "https")
                    && url.host_str() == Some("tauri.localhost")
                    && url.port().is_none();
            let custom_protocol_local =
                url.scheme() == "tauri"
                    && url.host_str() == Some("localhost")
                    && url.port().is_none();
            let development_local = cfg!(debug_assertions)
                && url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port() == Some(1430);
            production_local || custom_protocol_local || development_local
        });
        if let Some(parent) = self.app.get_webview_window("main") {
            builder = builder
                .parent(&parent)
                .map_err(|error| format!("Could not bind approval window to main window: {error}"))?;
        }
        let window = builder
            .build()
            .map_err(|error| format!("Could not create approval window: {error}"))?;

        if let Some(parent) = self.app.get_webview_window("main") {
            if let (Ok(parent_position), Ok(parent_size), Ok(approval_size)) = (
                parent.outer_position(),
                parent.outer_size(),
                window.outer_size(),
            ) {
                let margin = 12_i32;
                let top_inset = 54_i32;
                let parent_right = parent_position
                    .x
                    .saturating_add(i32::try_from(parent_size.width).unwrap_or(i32::MAX));
                let approval_width = i32::try_from(approval_size.width).unwrap_or(i32::MAX);
                let right_aligned = parent_right
                    .saturating_sub(approval_width)
                    .saturating_sub(margin);
                let minimum_x = parent_position.x.saturating_add(margin);
                let target_x = right_aligned.max(minimum_x);
                let target_y = parent_position.y.saturating_add(top_inset);
                let _ = window.set_position(tauri::PhysicalPosition::new(target_x, target_y));
            }
        }

        let surface = self.clone();
        let expected_id = presentation_id.to_string();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                surface.deny_presentation(&expected_id);
            }
        });
        window
            .show()
            .and_then(|_| window.set_focus())
            .map_err(|error| format!("Could not show approval window: {error}"))?;
        Ok(())
    }

    fn deny_presentation(&self, presentation_id: &str) {
        self.finish_if_pending(presentation_id, "deny");
        self.close_window();
    }

    fn finish_if_pending(&self, presentation_id: &str, decision: &str) {
        let pending = {
            let mut guard = match self.pending.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            let matches = guard
                .as_ref()
                .and_then(|entry| entry.presentation.get("id"))
                .and_then(Value::as_str)
                == Some(presentation_id);
            if matches { guard.take() } else { None }
        };
        if let Some(pending) = pending {
            let _ = pending.decision_tx.send(decision.to_string());
        }
    }

    fn close_window(&self) {
        if let Some(window) = self.app.get_webview_window(APPROVAL_WINDOW_LABEL) {
            let _ = window.destroy();
        }
    }
}

pub fn assert_approval_sender(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != APPROVAL_WINDOW_LABEL {
        return Err("Approval IPC request rejected because its sender is not the active approval window.".into());
    }
    Ok(())
}

fn valid_presentation(value: &Value) -> bool {
    value
        .as_object()
        .map(|record| {
            ["id", "toolName", "title", "message", "detail", "requestedAt", "expiresAt"]
                .iter()
                .all(|key| {
                    record
                        .get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.is_empty() && text.len() <= 65_536)
                })
                && record.get("burstDetected").and_then(Value::as_bool).is_some()
        })
        .unwrap_or(false)
}
