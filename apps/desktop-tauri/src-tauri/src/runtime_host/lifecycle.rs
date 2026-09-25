//! How a Runtime Host ends: an orderly shutdown, teardown when its last handle
//! drops, and the evidence the shell can keep when it fails instead.

use std::{
    sync::{atomic::Ordering, mpsc},
    thread,
    time::{Duration, Instant},
};

use serde_json::{json, Value};

use super::{write_message, RuntimeHost, RuntimeHostInner, PROTOCOL_VERSION};

/// What the shell knows about a Runtime Host that stopped answering, with this
/// launch's protocol session and Gateway Bearer removed so it can go to disk.
pub(crate) struct RuntimeFailureEvidence {
    pub instance_id: String,
    pub process_id: Option<u32>,
    /// None while the process is still running.
    pub exit_code: Option<i32>,
    pub uptime_ms: u64,
    pub error_message: Option<String>,
    pub stderr_tail: String,
}

fn redact_launch_secrets(text: &str, secrets: &[&str]) -> String {
    secrets
        .iter()
        .filter(|secret| !secret.is_empty())
        .fold(text.to_string(), |text, secret| text.replace(secret, "[redacted]"))
}

impl RuntimeHost {
    pub(crate) fn failure_evidence(&self) -> RuntimeFailureEvidence {
        let secrets = [
            self.inner.session.as_str(),
            self.inner.gateway_bearer_token.as_str(),
        ];
        let exit_code = self.inner.child.lock().ok().and_then(|mut child| {
            child
                .as_mut()
                .and_then(|child| child.try_wait().ok().flatten())
                .and_then(|status| status.code())
        });
        let error_message = self.inner.state.lock().ok().and_then(|state| {
            state
                .get("errorMessage")
                .and_then(Value::as_str)
                .map(|message| redact_launch_secrets(message, &secrets))
        });
        let stderr_tail = self
            .inner
            .log_tail
            .lock()
            .map(|log| redact_launch_secrets(&log, &secrets))
            .unwrap_or_default();
        RuntimeFailureEvidence {
            instance_id: self.instance_id(),
            process_id: self.process_id(),
            exit_code,
            uptime_ms: self.uptime_ms(),
            error_message,
            stderr_tail,
        }
    }

    pub fn shutdown(&self) -> Result<(), String> {
        if self.inner.closing.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.inner.healthy.store(false, Ordering::SeqCst);
        self.inner.approval.deny_all();
        let _ = self.call_shutdown_direct();
        if let Ok(mut stdin) = self.inner.stdin.lock() {
            stdin.take();
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let exited = {
                let mut child = self
                    .inner
                    .child
                    .lock()
                    .map_err(|_| "Runtime Host child lock is poisoned.".to_string())?;
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
        Ok(())
    }

    fn call_shutdown_direct(&self) -> Result<(), String> {
        let id = format!(
            "tauri-shutdown-{}",
            self.inner.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = mpsc::sync_channel(1);
        self.inner
            .pending
            .lock()
            .map_err(|_| "Runtime Host pending-request lock is poisoned.".to_string())?
            .insert(id.clone(), tx);
        write_message(
            &self.inner,
            &json!({
                "v": PROTOCOL_VERSION,
                "session": self.inner.session,
                "kind": "request",
                "id": id,
                "method": "shutdown",
                "params": {}
            }),
        )?;
        let _ = rx.recv_timeout(Duration::from_secs(2));
        Ok(())
    }
}

impl Drop for RuntimeHostInner {
    fn drop(&mut self) {
        self.closing.store(true, Ordering::SeqCst);
        if let Ok(stdin) = self.stdin.get_mut() {
            stdin.take();
        }
        if let Ok(child) = self.child.get_mut() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::redact_launch_secrets;

    #[test]
    fn removes_this_launch_secrets_before_evidence_reaches_disk() {
        let session = "c2Vzc2lvbi1zZWNyZXQtdmFsdWU";
        let bearer = "YmVhcmVyLXRva2VuLXZhbHVl";
        let text = format!(
            "[runtime-host protocol] session {session} rejected\nAuthorization: Bearer {bearer}\n"
        );
        let redacted = redact_launch_secrets(&text, &[session, bearer]);
        assert!(!redacted.contains(session));
        assert!(!redacted.contains(bearer));
        assert!(redacted.contains("Bearer [redacted]"));
        assert!(redacted.contains("[runtime-host protocol] session [redacted] rejected"));
    }

    #[test]
    fn leaves_text_alone_when_a_secret_is_empty() {
        assert_eq!(
            redact_launch_secrets("stderr line\n", &["", ""]),
            "stderr line\n"
        );
    }
}
