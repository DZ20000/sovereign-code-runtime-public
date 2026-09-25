use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::runtime_host::{RuntimeHost, RuntimeHostCandidate};

const CUTOVER_RECEIPT_SCHEMA_VERSION: &str = "scr.runtime-host-owner-cutover/v1";
const RESTART_REQUIRED_PREFIX: &str = "RUNTIME_HOST_RESTART_REQUIRED:";

pub(crate) fn cutover_requires_restart(error: &str) -> bool {
    error.starts_with(RESTART_REQUIRED_PREFIX)
}
const IDENTIFIER_PATTERN: fn(u8, usize) -> bool = |byte, index| {
    (index == 0 && byte.is_ascii_alphanumeric())
        || (index > 0
            && (byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')))
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeHostOwnerStatus {
    schema_version: &'static str,
    instance_id: String,
    release_id: String,
    process_id: Option<u32>,
    runtime_script_sha256: String,
    healthy: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeHostRollingEndpointIdentity {
    instance_id: String,
    release_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeHostRollingRouterSnapshot {
    generation: u64,
    active: RuntimeHostRollingEndpointIdentity,
    fencing_token_sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeHostRollingStatus {
    schema_version: &'static str,
    enabled: bool,
    busy: bool,
    active: RuntimeHostRollingRouterSnapshot,
    disabled_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeHostOwnerCutoverReceipt {
    schema_version: &'static str,
    outcome: &'static str,
    previous_release_id: String,
    previous_instance_id: String,
    candidate_release_id: String,
    candidate_instance_id: Option<String>,
    checkpoint_id: Option<String>,
    external_route_desired: Option<bool>,
    previous_process_id: Option<u32>,
    candidate_process_id: Option<u32>,
    started_at_unix_ms: u64,
    completed_at_unix_ms: u64,
    phases: Vec<String>,
    failure_reason: Option<String>,
    cleanup_failures: Vec<String>,
}

#[derive(Clone)]
pub(crate) struct RuntimeHostSupervisor {
    inner: Arc<RuntimeHostSupervisorInner>,
}

struct RuntimeHostSupervisorInner {
    app: AppHandle,
    active: Mutex<RuntimeHost>,
    transition: Mutex<()>,
    rolling_enabled: AtomicBool,
    generation: AtomicU64,
    fencing_token_sha256: Mutex<Option<String>>,
}

trait RuntimeCutoverProcess {
    fn instance_id(&self) -> String;
    fn release_id(&self) -> String;
    fn call(&self, method: &str, params: Value) -> Result<Value, String>;
    fn shutdown(&self) -> Result<(), String>;
}

impl RuntimeCutoverProcess for RuntimeHost {
    fn instance_id(&self) -> String {
        self.instance_id()
    }

    fn release_id(&self) -> String {
        self.release_id()
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call(method, params)
    }

    fn shutdown(&self) -> Result<(), String> {
        self.shutdown()
    }
}

#[derive(Debug)]
struct CutoverExecution {
    outcome: &'static str,
    checkpoint_id: Option<String>,
    external_route_desired: Option<bool>,
    phases: Vec<String>,
    failure_reason: Option<String>,
    cleanup_failures: Vec<String>,
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn bounded_error(error: impl Into<String>) -> String {
    error
        .into()
        .replace(['\r', '\n', '\0'], " ")
        .chars()
        .take(1_024)
        .collect()
}

fn sha256_text(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .enumerate()
            .all(|(index, byte)| IDENTIFIER_PATTERN(byte, index))
    {
        return Err(format!("{label} is invalid."));
    }
    Ok(())
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object."))
}

fn string_field(value: &Value, key: &str, label: &str) -> Result<String, String> {
    let value = object(value, label)?
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{label} field {key} is invalid."))?;
    validate_identifier(value, &format!("{label} field {key}"))?;
    Ok(value.to_string())
}

fn bool_field(value: &Value, key: &str, label: &str) -> Result<bool, String> {
    object(value, label)?
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("{label} field {key} is invalid."))
}

fn u64_field(value: &Value, key: &str, label: &str) -> Result<u64, String> {
    object(value, label)?
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{label} field {key} is invalid."))
}

fn optional_gateway_generation(value: &Value, label: &str) -> Result<Option<u64>, String> {
    match object(value, label)?.get("gateway") {
        Some(Value::Null) | None => Ok(None),
        Some(gateway) => Ok(Some(u64_field(
            gateway,
            "generation",
            "Runtime Gateway status",
        )?)),
    }
}

fn verify_status<P: RuntimeCutoverProcess>(
    process: &P,
    status: &Value,
    expected_role: &str,
    expected_promoted: bool,
) -> Result<(), String> {
    let label = "Runtime cutover status";
    if string_field(status, "instanceId", label)? != process.instance_id() {
        return Err("Runtime cutover status reported the wrong instance ID.".into());
    }
    if string_field(status, "releaseId", label)? != process.release_id() {
        return Err("Runtime cutover status reported the wrong release ID.".into());
    }
    if object(status, label)?.get("role").and_then(Value::as_str) != Some(expected_role) {
        return Err("Runtime cutover status reported the wrong authority role.".into());
    }
    if bool_field(status, "promoted", label)? != expected_promoted {
        return Err("Runtime cutover status reported the wrong promotion state.".into());
    }
    Ok(())
}

fn restore_previous_authority<P: RuntimeCutoverProcess>(
    active: &P,
    candidate: &P,
    candidate_authority_attempted: bool,
    quiesce_attempted: bool,
    mut control_generation: Option<u64>,
    mut gateway_generation: Option<u64>,
    external_route_desired: Option<bool>,
    phases: &mut Vec<String>,
    cleanup_failures: &mut Vec<String>,
) -> bool {
    let mut restored = true;
    phases.push("stop-candidate".into());
    let candidate_shutdown_confirmed = match candidate.shutdown() {
        Ok(()) => true,
        Err(error) => {
            cleanup_failures.push(format!("stop-candidate: {}", bounded_error(error)));
            false
        }
    };
    if candidate_authority_attempted && !candidate_shutdown_confirmed {
        cleanup_failures.push(
            "resume-active skipped because promoted candidate shutdown was not confirmed.".into(),
        );
        return false;
    }
    if !quiesce_attempted {
        return restored;
    }

    phases.push("resume-active".into());
    if control_generation.is_none() {
        match active.call("cutover.status", json!({})) {
            Ok(status) => {
                control_generation =
                    u64_field(&status, "controlGeneration", "Runtime recovery status").ok();
                gateway_generation =
                    optional_gateway_generation(&status, "Runtime recovery status")
                        .ok()
                        .flatten();
            }
            Err(error) => {
                cleanup_failures.push(format!("resume-active-status: {}", bounded_error(error)))
            }
        }
    }
    let Some(control_generation) = control_generation else {
        cleanup_failures.push("resume-active: Runtime control generation is unavailable.".into());
        return false;
    };
    match active.call(
        "cutover.resume",
        json!({
            "controlGeneration": control_generation,
            "gatewayGeneration": gateway_generation
        }),
    ) {
        Ok(status) => {
            let resumed = verify_status(active, &status, "active", true).is_ok()
                && bool_field(&status, "controlQuiesced", "Runtime resume status") == Ok(false)
                && bool_field(&status, "trafficDetached", "Runtime resume status") == Ok(false)
                && external_route_desired.is_none_or(|expected| {
                    bool_field(&status, "externalRouteDesired", "Runtime resume status")
                        == Ok(expected)
                })
                && gateway_generation.is_none_or(|_| {
                    object(&status, "Runtime resume status")
                        .ok()
                        .and_then(|record| record.get("gateway"))
                        .and_then(Value::as_object)
                        .and_then(|gateway| gateway.get("acceptingRequests"))
                        .and_then(Value::as_bool)
                        == Some(true)
                });
            if !resumed {
                restored = false;
                cleanup_failures
                    .push("resume-active: Runtime Host authority was not fully restored.".into());
            }
        }
        Err(error) => {
            restored = false;
            cleanup_failures.push(format!("resume-active: {}", bounded_error(error)));
        }
    }
    restored
}

fn commit_after_canary<P, T, F>(
    active: &P,
    candidate: &P,
    mut execution: CutoverExecution,
    commit: F,
) -> Result<(CutoverExecution, T), String>
where
    P: RuntimeCutoverProcess,
    F: FnOnce() -> Result<T, String>,
{
    if execution.outcome != "committed" {
        let reason = execution
            .failure_reason
            .clone()
            .unwrap_or_else(|| "Runtime Host cutover did not commit.".into());
        if execution.outcome == "failed" {
            let _ = active.shutdown();
            return Err(format!(
                "{RESTART_REQUIRED_PREFIX} Runtime Host cutover recovery was not confirmed: {reason}"
            ));
        }
        return Err(format!(
            "Runtime Host candidate cutover rolled back: {reason}"
        ));
    }

    match commit() {
        Ok(value) => Ok((execution, value)),
        Err(error) => {
            let error = bounded_error(error);
            let restored = restore_previous_authority(
                active,
                candidate,
                true,
                true,
                None,
                None,
                execution.external_route_desired,
                &mut execution.phases,
                &mut execution.cleanup_failures,
            );
            if restored {
                Err(format!(
                    "Runtime candidate durable activation commit failed after canary; previous Runtime Host authority was restored: {error}"
                ))
            } else {
                let _ = active.shutdown();
                Err(format!(
                    "{RESTART_REQUIRED_PREFIX} Runtime candidate durable activation commit failed and previous Runtime Host authority could not be restored: {error}"
                ))
            }
        }
    }
}

fn execute_cutover<P: RuntimeCutoverProcess>(
    active: &P,
    candidate: &P,
    fencing_token: &str,
) -> CutoverExecution {
    let mut phases = Vec::new();
    let mut cleanup_failures = Vec::new();
    let mut control_generation = None;
    let mut gateway_generation = None;
    let mut checkpoint_id = None;
    let mut external_route_desired = None;
    let mut quiesce_attempted = false;
    let mut candidate_authority_attempted = false;

    let operation = (|| -> Result<(), String> {
        phases.push("verify-active".into());
        let active_status = active.call("cutover.status", json!({}))?;
        verify_status(active, &active_status, "active", true)?;

        phases.push("verify-candidate".into());
        let candidate_status = candidate.call("cutover.status", json!({}))?;
        verify_status(candidate, &candidate_status, "candidate", false)?;

        phases.push("quiesce-active".into());
        quiesce_attempted = true;
        let quiesced = active.call("cutover.quiesce", json!({}))?;
        let control = u64_field(&quiesced, "controlGeneration", "Runtime quiesce status")?;
        let gateway = optional_gateway_generation(&quiesced, "Runtime quiesce status")?;
        control_generation = Some(control);
        gateway_generation = gateway;

        phases.push("drain-active".into());
        let drained = active.call(
            "cutover.drain",
            json!({
                "controlGeneration": control,
                "gatewayGeneration": gateway,
                "timeoutMs": 30_000
            }),
        )?;
        if !bool_field(&drained, "drained", "Runtime drain report")?
            || bool_field(&drained, "timedOut", "Runtime drain report")?
            || bool_field(&drained, "interrupted", "Runtime drain report")?
            || u64_field(&drained, "unknownOutcomeCount", "Runtime drain report")? != 0
            || u64_field(
                &drained,
                "activeControlRequestCount",
                "Runtime drain report",
            )? != 0
            || u64_field(
                &drained,
                "activeGatewayRequestCount",
                "Runtime drain report",
            )? != 0
        {
            return Err("Runtime Host did not reach an evidence-backed idle point.".into());
        }

        phases.push("checkpoint-active".into());
        let checkpoint = active.call(
            "cutover.checkpoint",
            json!({
                "controlGeneration": control,
                "gatewayGeneration": gateway,
                "fencingToken": fencing_token
            }),
        )?;
        let checkpoint = string_field(&checkpoint, "checkpointId", "Runtime cutover checkpoint")?;
        let route_desired = bool_field(
            &active.call("cutover.status", json!({}))?,
            "externalRouteDesired",
            "Runtime cutover status",
        )?;
        checkpoint_id = Some(checkpoint.clone());
        external_route_desired = Some(route_desired);

        phases.push("detach-active-route".into());
        let detached = active.call(
            "cutover.detach",
            json!({
                "controlGeneration": control,
                "gatewayGeneration": gateway,
                "checkpointId": checkpoint,
                "fencingToken": fencing_token
            }),
        )?;
        if !bool_field(&detached, "trafficDetached", "Runtime detach status")? {
            return Err("Runtime Host did not detach its external route.".into());
        }

        phases.push("promote-candidate".into());
        candidate_authority_attempted = true;
        let promoted = candidate.call(
            "cutover.promote",
            json!({
                "checkpointId": checkpoint_id,
                "fencingToken": fencing_token,
                "externalRouteDesired": route_desired
            }),
        )?;
        verify_status(candidate, &promoted, "active", true)?;
        if object(&promoted, "Runtime promotion status")?
            .get("promotedCheckpointId")
            .and_then(Value::as_str)
            != checkpoint_id.as_deref()
        {
            return Err("Runtime Host candidate promotion used the wrong checkpoint.".into());
        }

        phases.push("canary-candidate".into());
        let canary = candidate.call("cutover.canary", json!({}))?;
        if string_field(&canary, "instanceId", "Runtime canary")? != candidate.instance_id()
            || string_field(&canary, "releaseId", "Runtime canary")? != candidate.release_id()
            || !bool_field(&canary, "promoted", "Runtime canary")?
            || object(&canary, "Runtime canary")?
                .get("promotedCheckpointId")
                .and_then(Value::as_str)
                != checkpoint_id.as_deref()
            || bool_field(&canary, "externalRouteDesired", "Runtime canary")? != route_desired
        {
            return Err("Runtime Host candidate canary identity did not match the cutover.".into());
        }
        Ok(())
    })();

    match operation {
        Ok(()) => CutoverExecution {
            outcome: "committed",
            checkpoint_id,
            external_route_desired,
            phases,
            failure_reason: None,
            cleanup_failures,
        },
        Err(error) => {
            let failure_reason = bounded_error(error);
            let restored = restore_previous_authority(
                active,
                candidate,
                candidate_authority_attempted,
                quiesce_attempted,
                control_generation,
                gateway_generation,
                external_route_desired,
                &mut phases,
                &mut cleanup_failures,
            );
            CutoverExecution {
                outcome: if restored { "rolled-back" } else { "failed" },
                checkpoint_id,
                external_route_desired,
                phases,
                failure_reason: Some(failure_reason),
                cleanup_failures,
            }
        }
    }
}

impl RuntimeHostSupervisor {
    pub(crate) fn start(app: AppHandle) -> Result<Self, String> {
        let active = RuntimeHost::start(app.clone())?;
        Ok(Self {
            inner: Arc::new(RuntimeHostSupervisorInner {
                app,
                active: Mutex::new(active),
                transition: Mutex::new(()),
                rolling_enabled: AtomicBool::new(false),
                generation: AtomicU64::new(1),
                fencing_token_sha256: Mutex::new(None),
            }),
        })
    }

    pub(crate) fn active(&self) -> RuntimeHost {
        self.inner
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(crate) fn status(&self) -> RuntimeHostOwnerStatus {
        let active = self.active();
        RuntimeHostOwnerStatus {
            schema_version: "scr.runtime-host-owner-status/v1",
            instance_id: active.instance_id(),
            release_id: active.release_id(),
            process_id: active.process_id(),
            runtime_script_sha256: active.runtime_script_sha256(),
            healthy: active.is_healthy(),
        }
    }

    pub(crate) fn set_rolling_enabled(&self, enabled: bool) {
        self.inner.rolling_enabled.store(enabled, Ordering::SeqCst);
    }

    pub(crate) fn rolling_status(&self) -> RuntimeHostRollingStatus {
        let active = self.active();
        let enabled = self.inner.rolling_enabled.load(Ordering::SeqCst);
        let busy = self.inner.transition.try_lock().is_err();
        let fencing_token_sha256 = self
            .inner
            .fencing_token_sha256
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        RuntimeHostRollingStatus {
            schema_version: "scr.runtime-rolling-service-status/v1",
            enabled,
            busy,
            active: RuntimeHostRollingRouterSnapshot {
                generation: self.inner.generation.load(Ordering::SeqCst),
                active: RuntimeHostRollingEndpointIdentity {
                    instance_id: active.instance_id(),
                    release_id: active.release_id(),
                },
                fencing_token_sha256,
            },
            disabled_reason: (!enabled)
                .then(|| "No trusted signed Runtime candidate launcher is configured.".into()),
        }
    }

    pub(crate) fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.active().call(method, params)
    }

    pub(crate) fn approval_current(&self) -> Result<Option<Value>, String> {
        self.active().approval_current()
    }

    pub(crate) fn approval_resolve(&self, request_id: &str, decision: &str) -> Result<(), String> {
        self.active().approval_resolve(request_id, decision)
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        let _transition = self
            .inner
            .transition
            .lock()
            .map_err(|_| "Runtime Host transition lock is poisoned.".to_string())?;
        self.active().shutdown()
    }

    pub(crate) fn cutover_verified_slot<T, F>(
        &self,
        release_id: impl Into<String>,
        slot_root: PathBuf,
        runtime_script_sha256: impl Into<String>,
        commit: F,
    ) -> Result<T, String>
    where
        F: FnOnce(&RuntimeHostOwnerCutoverReceipt) -> Result<T, String>,
    {
        if !self.inner.rolling_enabled.load(Ordering::SeqCst) {
            return Err("Signed Runtime candidate cutover is not enabled.".into());
        }
        let _transition = self
            .inner
            .transition
            .try_lock()
            .map_err(|_| "Another Runtime Host cutover is already active.".to_string())?;
        let started_at_unix_ms = now_unix_ms();
        let active = self.active();
        let candidate_spec =
            RuntimeHostCandidate::from_verified_slot(release_id, slot_root, runtime_script_sha256)?;
        let previous_release_id = active.release_id();
        let previous_instance_id = active.instance_id();
        let previous_process_id = active.process_id();
        let candidate_release_id = candidate_spec.release_id.clone();
        let candidate_instance_id = candidate_spec.instance_id.clone();
        let fencing_token = candidate_spec.promotion_fencing_token.clone();
        let candidate = RuntimeHost::start_candidate(
            self.inner.app.clone(),
            &candidate_spec,
            &active.gateway_bearer_token(),
        )
        .map_err(|error| {
            format!(
                "Could not start verified Runtime Host candidate: {}",
                bounded_error(error)
            )
        })?;
        let candidate_process_id = candidate.process_id();
        let execution = execute_cutover(&active, &candidate, &fencing_token);
        if execution.outcome != "committed" {
            return commit_after_canary(&active, &candidate, execution, || Ok::<(), String>(()))
                .map(|_| unreachable!());
        }

        {
            let active_guard = self
                .inner
                .active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if active_guard.instance_id() != previous_instance_id {
                drop(active_guard);
                return commit_after_canary(&active, &candidate, execution, || {
                    Err::<(), String>(
                        "Active Runtime Host changed before durable ownership publication.".into(),
                    )
                })
                .map(|_| unreachable!());
            }
        }

        let current_generation = self.inner.generation.load(Ordering::SeqCst);
        let Some(next_generation) = current_generation.checked_add(1) else {
            return commit_after_canary(&active, &candidate, execution, || {
                Err::<(), String>(
                    "Runtime Host rolling generation reached its maximum value.".into(),
                )
            })
            .map(|_| unreachable!());
        };

        let receipt = RuntimeHostOwnerCutoverReceipt {
            schema_version: CUTOVER_RECEIPT_SCHEMA_VERSION,
            outcome: "committed",
            previous_release_id,
            previous_instance_id: previous_instance_id.clone(),
            candidate_release_id,
            candidate_instance_id: Some(candidate_instance_id),
            checkpoint_id: execution.checkpoint_id.clone(),
            external_route_desired: execution.external_route_desired,
            previous_process_id,
            candidate_process_id,
            started_at_unix_ms,
            completed_at_unix_ms: now_unix_ms(),
            phases: execution.phases.clone(),
            failure_reason: None,
            cleanup_failures: execution.cleanup_failures.clone(),
        };
        let (_execution, committed_value) =
            commit_after_canary(&active, &candidate, execution, || commit(&receipt))?;

        let mut active_guard = self
            .inner
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        debug_assert_eq!(active_guard.instance_id(), previous_instance_id);
        candidate.enable_state_events();
        *active_guard = candidate.clone();
        self.inner
            .generation
            .store(next_generation, Ordering::SeqCst);
        *self
            .inner
            .fencing_token_sha256
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sha256_text(&fencing_token));
        drop(active_guard);
        if let Err(error) = active.shutdown() {
            eprintln!(
                "Previous Runtime Host cleanup failed after durable candidate publication: {}",
                bounded_error(error)
            );
        }
        Ok(committed_value)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::{
        commit_after_canary, execute_cutover, RuntimeCutoverProcess, RESTART_REQUIRED_PREFIX,
    };
    use serde_json::{json, Value};

    #[derive(Clone)]
    struct FakeProcess {
        instance_id: String,
        release_id: String,
        role: &'static str,
        promoted: Arc<Mutex<bool>>,
        calls: Arc<Mutex<Vec<String>>>,
        fail_at: Arc<Mutex<Option<String>>>,
        shutdowns: Arc<Mutex<u32>>,
        fail_shutdown: Arc<Mutex<bool>>,
    }

    impl FakeProcess {
        fn new(instance_id: &str, release_id: &str, role: &'static str) -> Self {
            Self {
                instance_id: instance_id.into(),
                release_id: release_id.into(),
                role,
                promoted: Arc::new(Mutex::new(role == "active")),
                calls: Arc::new(Mutex::new(Vec::new())),
                fail_at: Arc::new(Mutex::new(None)),
                shutdowns: Arc::new(Mutex::new(0)),
                fail_shutdown: Arc::new(Mutex::new(false)),
            }
        }

        fn fail_at(&self, method: &str) {
            *self.fail_at.lock().unwrap() = Some(method.into());
        }

        fn fail_shutdown(&self) {
            *self.fail_shutdown.lock().unwrap() = true;
        }
    }

    impl RuntimeCutoverProcess for FakeProcess {
        fn instance_id(&self) -> String {
            self.instance_id.clone()
        }

        fn release_id(&self) -> String {
            self.release_id.clone()
        }

        fn call(&self, method: &str, params: Value) -> Result<Value, String> {
            self.calls.lock().unwrap().push(method.into());
            if self.fail_at.lock().unwrap().as_deref() == Some(method) {
                return Err(format!("{method} failed"));
            }
            match method {
                "cutover.status" => Ok(json!({
                    "instanceId": self.instance_id,
                    "releaseId": self.release_id,
                    "role": if *self.promoted.lock().unwrap() { "active" } else { self.role },
                    "promoted": *self.promoted.lock().unwrap(),
                    "promotedCheckpointId": if *self.promoted.lock().unwrap() {
                        Value::String("checkpoint-1".into())
                    } else {
                        Value::Null
                    },
                    "controlQuiesced": false,
                    "controlGeneration": 1,
                    "gateway": {
                        "generation": 1,
                        "acceptingRequests": true
                    },
                    "externalRouteDesired": true,
                    "trafficDetached": false
                })),
                "cutover.quiesce" => Ok(json!({
                    "controlGeneration": 1,
                    "gateway": { "generation": 1 }
                })),
                "cutover.drain" => Ok(json!({
                    "drained": true,
                    "timedOut": false,
                    "interrupted": false,
                    "unknownOutcomeCount": 0,
                    "activeControlRequestCount": 0,
                    "activeGatewayRequestCount": 0
                })),
                "cutover.checkpoint" => Ok(json!({
                    "checkpointId": "checkpoint-1"
                })),
                "cutover.detach" => Ok(json!({
                    "trafficDetached": true
                })),
                "cutover.promote" => {
                    *self.promoted.lock().unwrap() = true;
                    Ok(json!({
                        "instanceId": self.instance_id,
                        "releaseId": self.release_id,
                        "role": "active",
                        "promoted": true,
                        "promotedCheckpointId": "checkpoint-1"
                    }))
                }
                "cutover.canary" => Ok(json!({
                    "instanceId": self.instance_id,
                    "releaseId": self.release_id,
                    "promoted": true,
                    "promotedCheckpointId": "checkpoint-1",
                    "externalRouteDesired": true
                })),
                "cutover.resume" => Ok(json!({
                    "instanceId": self.instance_id,
                    "releaseId": self.release_id,
                    "role": "active",
                    "promoted": true,
                    "promotedCheckpointId": "checkpoint-1",
                    "controlQuiesced": false,
                    "controlGeneration": 2,
                    "gateway": {
                        "generation": 2,
                        "acceptingRequests": true
                    },
                    "externalRouteDesired": true,
                    "trafficDetached": false
                })),
                _ => Err(format!("unexpected method {method}: {params}")),
            }
        }

        fn shutdown(&self) -> Result<(), String> {
            *self.shutdowns.lock().unwrap() += 1;
            if *self.fail_shutdown.lock().unwrap() {
                Err("shutdown failed".into())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn commits_only_after_checkpoint_detach_promotion_and_canary() {
        let active = FakeProcess::new("active-1", "release-1", "active");
        let candidate = FakeProcess::new("candidate-2", "release-2", "candidate");
        let execution = execute_cutover(
            &active,
            &candidate,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );

        assert_eq!(execution.outcome, "committed");
        assert_eq!(execution.checkpoint_id.as_deref(), Some("checkpoint-1"));
        assert_eq!(
            active.calls.lock().unwrap().as_slice(),
            [
                "cutover.status",
                "cutover.quiesce",
                "cutover.drain",
                "cutover.checkpoint",
                "cutover.status",
                "cutover.detach"
            ]
        );
        assert_eq!(
            candidate.calls.lock().unwrap().as_slice(),
            ["cutover.status", "cutover.promote", "cutover.canary"]
        );
    }

    #[test]
    fn candidate_canary_failure_stops_candidate_and_resumes_active() {
        let active = FakeProcess::new("active-1", "release-1", "active");
        let candidate = FakeProcess::new("candidate-2", "release-2", "candidate");
        candidate.fail_at("cutover.canary");
        let execution = execute_cutover(
            &active,
            &candidate,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );

        assert_eq!(execution.outcome, "rolled-back");
        assert!(execution
            .failure_reason
            .as_deref()
            .is_some_and(|value| value.contains("cutover.canary failed")));
        assert_eq!(*candidate.shutdowns.lock().unwrap(), 1);
        assert_eq!(
            active.calls.lock().unwrap().last().map(String::as_str),
            Some("cutover.resume")
        );
    }

    #[test]
    fn quiesce_uncertain_failure_reloads_generation_and_resumes_active() {
        let active = FakeProcess::new("active-1", "release-1", "active");
        let candidate = FakeProcess::new("candidate-2", "release-2", "candidate");
        active.fail_at("cutover.quiesce");
        let execution = execute_cutover(
            &active,
            &candidate,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );

        assert_eq!(execution.outcome, "rolled-back");
        assert_eq!(
            active.calls.lock().unwrap().as_slice(),
            [
                "cutover.status",
                "cutover.quiesce",
                "cutover.status",
                "cutover.resume"
            ]
        );
    }

    #[test]
    fn promoted_candidate_shutdown_failure_is_fail_closed() {
        let active = FakeProcess::new("active-1", "release-1", "active");
        let candidate = FakeProcess::new("candidate-2", "release-2", "candidate");
        candidate.fail_at("cutover.canary");
        candidate.fail_shutdown();
        let execution = execute_cutover(
            &active,
            &candidate,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );

        assert_eq!(execution.outcome, "failed");
        assert!(execution
            .cleanup_failures
            .iter()
            .any(|value| value.contains("stop-candidate")));
        assert_ne!(
            active.calls.lock().unwrap().last().map(String::as_str),
            Some("cutover.resume")
        );
        assert!(execution
            .cleanup_failures
            .iter()
            .any(|value| { value.contains("promoted candidate shutdown was not confirmed") }));
    }

    #[test]
    fn durable_commit_failure_stops_candidate_and_resumes_previous_authority() {
        let active = FakeProcess::new("active-1", "release-1", "active");
        let candidate = FakeProcess::new("candidate-2", "release-2", "candidate");
        let execution = execute_cutover(
            &active,
            &candidate,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );

        let error = commit_after_canary(&active, &candidate, execution, || {
            Err::<(), String>("state publish failed".into())
        })
        .unwrap_err();

        assert!(error.contains("previous Runtime Host authority was restored"));
        assert_eq!(*candidate.shutdowns.lock().unwrap(), 1);
        assert_eq!(
            active.calls.lock().unwrap().last().map(String::as_str),
            Some("cutover.resume")
        );
    }

    #[test]
    fn uncertain_durable_commit_rollback_requires_a_controlled_restart() {
        let active = FakeProcess::new("active-1", "release-1", "active");
        let candidate = FakeProcess::new("candidate-2", "release-2", "candidate");
        candidate.fail_shutdown();
        let execution = execute_cutover(
            &active,
            &candidate,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );

        let error = commit_after_canary(&active, &candidate, execution, || {
            Err::<(), String>("state publish failed".into())
        })
        .unwrap_err();

        assert!(error.starts_with(RESTART_REQUIRED_PREFIX));
        assert_eq!(*active.shutdowns.lock().unwrap(), 1);
        assert_ne!(
            active.calls.lock().unwrap().last().map(String::as_str),
            Some("cutover.resume")
        );
    }

    #[test]
    fn resume_failure_is_reported_as_fail_closed() {
        let active = FakeProcess::new("active-1", "release-1", "active");
        let candidate = FakeProcess::new("candidate-2", "release-2", "candidate");
        candidate.fail_at("cutover.canary");
        active.fail_at("cutover.resume");
        let execution = execute_cutover(
            &active,
            &candidate,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );

        assert_eq!(execution.outcome, "failed");
        assert!(execution
            .cleanup_failures
            .iter()
            .any(|value| value.contains("resume-active")));
    }
}
