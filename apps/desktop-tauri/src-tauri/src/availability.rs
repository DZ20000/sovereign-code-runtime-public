use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const MONITOR_INTERVAL_MS: u64 = 5_000;
pub(crate) const POSSIBLE_SUSPEND_GAP_MS: u64 = 20_000;
const MAX_EVENTS: usize = 32;
const MAX_EVENT_FILE_BYTES: u64 = 128 * 1024;
const MAX_DETAIL_CHARS: usize = 512;

#[cfg(test)]
mod tests;

#[derive(Clone)]
pub struct HostAvailability {
    inner: Arc<Mutex<HostAvailabilityInner>>,
}

struct HostAvailabilityInner {
    state: HostAvailabilityState,
    previous_sample_instant: Option<Instant>,
    previous_power_source: Option<PowerSource>,
    previous_network_state: Option<NetworkState>,
    network_outage_started_unix_ms: Option<u64>,
    event_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostAvailabilityState {
    schema_version: &'static str,
    available: bool,
    monitor_started_at: String,
    sampled_at: Option<String>,
    monitor_interval_ms: u64,
    possible_suspend_gap_threshold_ms: u64,
    event_storage: EventStorage,
    system_uptime_ms: Option<u64>,
    power_source: PowerSource,
    battery_percent: Option<u8>,
    battery_saver: Option<bool>,
    possible_suspend_count: u64,
    last_possible_suspend_at: Option<String>,
    last_possible_suspend_duration_ms: Option<u64>,
    network_state: NetworkState,
    network_desired: bool,
    last_network_check_at: Option<String>,
    last_network_ready_at: Option<String>,
    last_network_loss_at: Option<String>,
    last_network_recovery_at: Option<String>,
    last_network_outage_duration_ms: Option<u64>,
    reconnect_attempt: u64,
    next_reconnect_at: Option<String>,
    detail: Option<String>,
    recent_events: Vec<AvailabilityEvent>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum EventStorage {
    Persistent,
    MemoryOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum PowerSource {
    Ac,
    Battery,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum NetworkState {
    NotConfigured,
    Offline,
    Connecting,
    Retrying,
    Ready,
    Degraded,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AvailabilityEvent {
    occurred_at: String,
    kind: AvailabilityEventKind,
    detail: String,
    duration_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AvailabilityEventKind {
    PossibleSuspendOrStall,
    PowerSourceChanged,
    NetworkLoss,
    NetworkRecovered,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAvailabilityEvents {
    schema_version: String,
    events: Vec<AvailabilityEvent>,
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn bounded_detail(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_DETAIL_CHARS {
        return trimmed.to_string();
    }
    trimmed.chars().take(MAX_DETAIL_CHARS).collect()
}

fn resolve_event_path(app: &AppHandle) -> Option<PathBuf> {
    let explicit_user_data = std::env::var_os("SCR_USER_DATA_PATH")
        .or_else(|| std::env::var_os("SCR_RESOURCE_BENCHMARK_USER_DATA"));
    let root = match explicit_user_data {
        Some(path) => PathBuf::from(path),
        None => app.path().app_data_dir().ok()?,
    };
    Some(root.join("host-availability.json"))
}

fn validate_event(event: AvailabilityEvent) -> Option<AvailabilityEvent> {
    if event.occurred_at.len() > 128
        || OffsetDateTime::parse(&event.occurred_at, &Rfc3339).is_err()
        || event.detail.is_empty()
        || event.detail.chars().count() > MAX_DETAIL_CHARS
    {
        return None;
    }
    Some(event)
}

fn load_events(path: &PathBuf) -> Vec<AvailabilityEvent> {
    let Ok(metadata) = fs::metadata(path) else {
        return Vec::new();
    };
    if !metadata.is_file() || metadata.len() > MAX_EVENT_FILE_BYTES {
        return Vec::new();
    }
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    let Ok(persisted) = serde_json::from_slice::<PersistedAvailabilityEvents>(&bytes) else {
        return Vec::new();
    };
    if persisted.schema_version != "scr.host-availability-events/v1" {
        return Vec::new();
    }
    persisted
        .events
        .into_iter()
        .filter_map(validate_event)
        .rev()
        .take(MAX_EVENTS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn persist_events(inner: &HostAvailabilityInner) {
    let Some(path) = inner.event_path.as_ref() else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let persisted = PersistedAvailabilityEvents {
        schema_version: "scr.host-availability-events/v1".to_string(),
        events: inner.state.recent_events.clone(),
    };
    let Ok(bytes) = serde_json::to_vec_pretty(&persisted) else {
        return;
    };
    if bytes.len() > MAX_EVENT_FILE_BYTES as usize {
        return;
    }
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    if fs::write(&temporary, bytes).is_err() {
        return;
    }
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    if fs::rename(&temporary, path).is_err() {
        let _ = fs::remove_file(&temporary);
    }
}

fn record_event(
    inner: &mut HostAvailabilityInner,
    kind: AvailabilityEventKind,
    detail: impl AsRef<str>,
    duration_ms: Option<u64>,
) {
    inner.state.recent_events.push(AvailabilityEvent {
        occurred_at: now_iso(),
        kind,
        detail: bounded_detail(detail.as_ref()),
        duration_ms,
    });
    if inner.state.recent_events.len() > MAX_EVENTS {
        let remove_count = inner.state.recent_events.len() - MAX_EVENTS;
        inner.state.recent_events.drain(..remove_count);
    }
    persist_events(inner);
}

#[cfg(windows)]
fn power_snapshot() -> (PowerSource, Option<u8>, Option<bool>, Option<u64>) {
    use windows::Win32::System::{
        Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS},
        SystemInformation::GetTickCount64,
    };

    let uptime_ms = Some(unsafe { GetTickCount64() });
    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
        return (PowerSource::Unknown, None, None, uptime_ms);
    }
    let power_source = match status.ACLineStatus {
        0 => PowerSource::Battery,
        1 => PowerSource::Ac,
        _ => PowerSource::Unknown,
    };
    let battery_percent = (status.BatteryLifePercent <= 100).then_some(status.BatteryLifePercent);
    let battery_saver = Some(status.SystemStatusFlag == 1);
    (power_source, battery_percent, battery_saver, uptime_ms)
}

#[cfg(not(windows))]
fn power_snapshot() -> (PowerSource, Option<u8>, Option<bool>, Option<u64>) {
    (PowerSource::Unknown, None, None, None)
}

fn tunnel_network_state(runtime_state: &Value) -> (NetworkState, bool, u64, Option<String>, Option<String>, Option<String>) {
    let runtime_phase = runtime_state
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or("error");
    let Some(tunnel) = runtime_state.get("secureTunnel") else {
        return (
            NetworkState::NotConfigured,
            false,
            0,
            None,
            None,
            Some("Secure MCP Tunnel state is unavailable.".to_string()),
        );
    };
    let phase = tunnel.get("phase").and_then(Value::as_str).unwrap_or("error");
    let tunnel_id_present = tunnel.get("tunnelId").is_some_and(|value| !value.is_null());
    let client_available = tunnel
        .get("clientAvailable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let desired = tunnel
        .get("desiredRunning")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || tunnel
            .get("autoStart")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let next_reconnect_at = tunnel
        .get("nextReconnectAt")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let last_ready_at = tunnel
        .get("lastReadyAt")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let reconnect_attempt = tunnel
        .get("reconnectAttempt")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let error_detail = tunnel
        .get("errorMessage")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(bounded_detail);
    let stabilizing_reconnect = phase == "ready" && reconnect_attempt > 0;
    let detail = error_detail.or_else(|| {
        stabilizing_reconnect.then(|| {
            "Secure MCP Tunnel is locally ready and stabilizing after reconnect.".to_string()
        })
    });

    let network_state = if phase == "ready" && !stabilizing_reconnect {
        NetworkState::Ready
    } else if stabilizing_reconnect {
        NetworkState::Connecting
    } else if next_reconnect_at.is_some() {
        NetworkState::Retrying
    } else if matches!(phase, "starting" | "running" | "stopping") {
        NetworkState::Connecting
    } else if desired || phase == "error" || runtime_phase == "error" {
        NetworkState::Degraded
    } else if !tunnel_id_present || !client_available {
        NetworkState::NotConfigured
    } else {
        NetworkState::Offline
    };
    (
        network_state,
        desired,
        reconnect_attempt,
        next_reconnect_at,
        last_ready_at,
        detail,
    )
}

impl HostAvailability {
    pub fn new(app: &AppHandle) -> Self {
        let event_path = resolve_event_path(app);
        let recent_events = event_path.as_ref().map(load_events).unwrap_or_default();
        let event_storage = if event_path.is_some() {
            EventStorage::Persistent
        } else {
            EventStorage::MemoryOnly
        };
        let instance = Self {
            inner: Arc::new(Mutex::new(HostAvailabilityInner {
                state: HostAvailabilityState {
                    schema_version: "scr.host-availability/v1",
                    available: true,
                    monitor_started_at: now_iso(),
                    sampled_at: None,
                    monitor_interval_ms: MONITOR_INTERVAL_MS,
                    possible_suspend_gap_threshold_ms: POSSIBLE_SUSPEND_GAP_MS,
                    event_storage,
                    system_uptime_ms: None,
                    power_source: PowerSource::Unknown,
                    battery_percent: None,
                    battery_saver: None,
                    possible_suspend_count: 0,
                    last_possible_suspend_at: None,
                    last_possible_suspend_duration_ms: None,
                    network_state: NetworkState::NotConfigured,
                    network_desired: false,
                    last_network_check_at: None,
                    last_network_ready_at: None,
                    last_network_loss_at: None,
                    last_network_recovery_at: None,
                    last_network_outage_duration_ms: None,
                    reconnect_attempt: 0,
                    next_reconnect_at: None,
                    detail: None,
                    recent_events,
                },
                previous_sample_instant: None,
                previous_power_source: None,
                previous_network_state: None,
                network_outage_started_unix_ms: None,
                event_path,
            })),
        };
        let _ = instance.sample_tick();
        instance
    }

    pub fn sample_tick(&self) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        let sample_instant = Instant::now();
        let now = now_iso();
        let mut possible_suspend = false;
        if let Some(previous) = inner.previous_sample_instant {
            let gap_ms = sample_instant
                .duration_since(previous)
                .as_millis()
                .min(u64::MAX as u128) as u64;
            if gap_ms >= POSSIBLE_SUSPEND_GAP_MS {
                possible_suspend = true;
                inner.state.possible_suspend_count =
                    inner.state.possible_suspend_count.saturating_add(1);
                inner.state.last_possible_suspend_at = Some(now.clone());
                inner.state.last_possible_suspend_duration_ms = Some(gap_ms);
                record_event(
                    &mut inner,
                    AvailabilityEventKind::PossibleSuspendOrStall,
                    format!(
                        "Host monitor observed a {gap_ms} ms scheduling gap; Windows sleep/resume or a severe host stall is possible."
                    ),
                    Some(gap_ms),
                );
            }
        }
        inner.previous_sample_instant = Some(sample_instant);

        let (power_source, battery_percent, battery_saver, system_uptime_ms) = power_snapshot();
        if let Some(previous) = inner.previous_power_source {
            if previous != power_source
                && previous != PowerSource::Unknown
                && power_source != PowerSource::Unknown
            {
                record_event(
                    &mut inner,
                    AvailabilityEventKind::PowerSourceChanged,
                    format!("Power source changed from {previous:?} to {power_source:?}."),
                    None,
                );
            }
        }
        inner.previous_power_source = Some(power_source);
        inner.state.sampled_at = Some(now);
        inner.state.system_uptime_ms = system_uptime_ms;
        inner.state.power_source = power_source;
        inner.state.battery_percent = battery_percent;
        inner.state.battery_saver = battery_saver;
        possible_suspend
    }

    pub fn observe_runtime_state(&self, runtime_state: &Value) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let now_ms = now_unix_ms();
        let now = now_iso();
        let (
            network_state,
            network_desired,
            reconnect_attempt,
            next_reconnect_at,
            last_ready_at,
            detail,
        ) = tunnel_network_state(runtime_state);

        match inner.previous_network_state {
            Some(NetworkState::Ready) if network_state != NetworkState::Ready && network_desired => {
                inner.network_outage_started_unix_ms = Some(now_ms);
                inner.state.last_network_loss_at = Some(now.clone());
                record_event(
                    &mut inner,
                    AvailabilityEventKind::NetworkLoss,
                    detail
                        .as_deref()
                        .unwrap_or("Secure MCP Tunnel left the ready state while continuous availability was desired."),
                    None,
                );
            }
            Some(previous) if previous != NetworkState::Ready && network_state == NetworkState::Ready => {
                let duration_ms = inner
                    .network_outage_started_unix_ms
                    .take()
                    .map(|started| now_ms.saturating_sub(started));
                inner.state.last_network_recovery_at = Some(now.clone());
                inner.state.last_network_outage_duration_ms = duration_ms;
                record_event(
                    &mut inner,
                    AvailabilityEventKind::NetworkRecovered,
                    "Secure MCP Tunnel returned to ready.",
                    duration_ms,
                );
            }
            None if network_desired && network_state != NetworkState::Ready => {
                inner.network_outage_started_unix_ms = Some(now_ms);
                inner.state.last_network_loss_at = Some(now.clone());
            }
            _ => {}
        }

        if network_state == NetworkState::Ready {
            inner.state.last_network_ready_at = last_ready_at.or_else(|| Some(now.clone()));
            inner.network_outage_started_unix_ms = None;
        } else if let Some(last_ready_at) = last_ready_at {
            inner.state.last_network_ready_at = Some(last_ready_at);
        }
        inner.previous_network_state = Some(network_state);
        inner.state.network_state = network_state;
        inner.state.network_desired = network_desired;
        inner.state.last_network_check_at = Some(now);
        inner.state.reconnect_attempt = reconnect_attempt;
        inner.state.next_reconnect_at = next_reconnect_at;
        inner.state.detail = detail;
    }

    pub fn note_runtime_failure(&self, reason: &str) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let now_ms = now_unix_ms();
        let now = now_iso();
        if inner.previous_network_state == Some(NetworkState::Ready) {
            inner.network_outage_started_unix_ms = Some(now_ms);
            inner.state.last_network_loss_at = Some(now.clone());
            record_event(
                &mut inner,
                AvailabilityEventKind::NetworkLoss,
                reason,
                None,
            );
        }
        inner.previous_network_state = Some(NetworkState::Degraded);
        inner.state.network_state = NetworkState::Degraded;
        inner.state.last_network_check_at = Some(now);
        inner.state.detail = Some(bounded_detail(reason));
    }

    pub fn note_network_check_failure(&self, reason: &str) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.state.last_network_check_at = Some(now_iso());
        inner.state.detail = Some(bounded_detail(reason));
        if inner.state.network_desired && inner.state.network_state != NetworkState::Ready {
            inner.state.network_state = NetworkState::Degraded;
        }
    }

    pub fn state(&self) -> Value {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| serde_json::to_value(&inner.state).ok())
            .unwrap_or_else(|| {
                json!({
                    "schemaVersion": "scr.host-availability/v1",
                    "available": false,
                    "monitorStartedAt": null,
                    "sampledAt": null,
                    "monitorIntervalMs": MONITOR_INTERVAL_MS,
                    "possibleSuspendGapThresholdMs": POSSIBLE_SUSPEND_GAP_MS,
                    "eventStorage": "memory-only",
                    "systemUptimeMs": null,
                    "powerSource": "unknown",
                    "batteryPercent": null,
                    "batterySaver": null,
                    "possibleSuspendCount": 0,
                    "lastPossibleSuspendAt": null,
                    "lastPossibleSuspendDurationMs": null,
                    "networkState": "degraded",
                    "networkDesired": false,
                    "lastNetworkCheckAt": null,
                    "lastNetworkReadyAt": null,
                    "lastNetworkLossAt": null,
                    "lastNetworkRecoveryAt": null,
                    "lastNetworkOutageDurationMs": null,
                    "reconnectAttempt": 0,
                    "nextReconnectAt": null,
                    "detail": "Host availability state lock is unavailable.",
                    "recentEvents": []
                })
            })
    }
}
