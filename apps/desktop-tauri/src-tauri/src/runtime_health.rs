//! Watches the active Runtime Host from the shell: restarts the tree through the
//! Host Guardian when the host stops answering, wakes the tunnel when the network
//! path changes, and keeps evidence of each Runtime Host failure on disk.

use std::{
    fs,
    net::{IpAddr, UdpSocket},
    path::Path,
    thread,
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::{
    availability::{HostAvailability, POSSIBLE_SUSPEND_GAP_MS}, host_guardian::HostGuardian,
    runtime_host::lifecycle::RuntimeFailureEvidence, runtime_host::RuntimeHost,
    runtime_host_supervisor::RuntimeHostSupervisor, ApplicationLifecycle, EXIT_MODE_RUNNING,
    GUARDIAN_RESTART_EXIT_CODE,
};

const RUNTIME_FAILURE_SCHEMA_VERSION: &str = "scr.runtime-host-failure/v1";
const RUNTIME_FAILURE_FILE: &str = "last-runtime-failure.json";
/// A Runtime Host that answers late is not a hung one. On a host saturated by
/// builds it missed two pings in a row, and restarting the tree for that cut the
/// tunnel and cancelled the build. Require six consecutive missed pings: about
/// two minutes including each five-second timeout and the polling sleeps.
const RUNTIME_PING_FAILURES_BEFORE_RESTART: u8 = 6;

fn routed_source_ip(bind: &str, target: &str) -> Option<IpAddr> {
    let socket = UdpSocket::bind(bind).ok()?;
    socket.connect(target).ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

#[cfg(windows)]
fn best_ipv4_interface_index() -> Option<u32> {
    use windows::Win32::{
        NetworkManagement::IpHelper::GetBestInterfaceEx,
        Networking::WinSock::{AF_INET, SOCKADDR, SOCKADDR_IN},
    };

    let mut destination = SOCKADDR_IN::default();
    destination.sin_family = AF_INET;
    destination.sin_addr.S_un.S_addr = u32::from_be_bytes([1, 1, 1, 1]);
    let mut interface_index = 0_u32;
    let result = unsafe {
        GetBestInterfaceEx(
            (&destination as *const SOCKADDR_IN).cast::<SOCKADDR>(),
            &mut interface_index,
        )
    };
    (result == 0 && interface_index != 0).then_some(interface_index)
}

#[cfg(not(windows))]
fn best_ipv4_interface_index() -> Option<u32> {
    None
}

fn network_path_fingerprint() -> Option<String> {
    if let Some(ipv4) = routed_source_ip("0.0.0.0:0", "1.1.1.1:443") {
        let interface_index = best_ipv4_interface_index()
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".into());
        return Some(format!("if4={interface_index};v4={ipv4}"));
    }
    routed_source_ip("[::]:0", "[2606:4700:4700::1111]:443").map(|ipv6| format!("v6={ipv6}"))
}

fn should_wake_tunnel_after_network_path_change(
    previous: Option<&str>,
    current: Option<&str>,
) -> bool {
    current.is_some() && previous != current
}

fn runtime_failure_record(
    reason: &str,
    evidence: &RuntimeFailureEvidence,
    occurred_at: &str,
) -> Value {
    json!({
        "schemaVersion": RUNTIME_FAILURE_SCHEMA_VERSION,
        "occurredAt": occurred_at,
        "reason": reason,
        "instanceId": evidence.instance_id,
        "processId": evidence.process_id,
        "exitCode": evidence.exit_code,
        "uptimeMs": evidence.uptime_ms,
        "errorMessage": evidence.error_message,
        "stderrTail": evidence.stderr_tail,
    })
}

fn write_runtime_failure_record(directory: &Path, record: &Value) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the failure evidence directory: {error}"))?;
    let path = directory.join(RUNTIME_FAILURE_FILE);
    let temporary = directory.join(format!("{RUNTIME_FAILURE_FILE}.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(record)
        .map_err(|error| format!("Could not serialize Runtime Host failure evidence: {error}"))?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write Runtime Host failure evidence: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not publish Runtime Host failure evidence: {error}"))
}

/// The Runtime Host's stderr lives only in the shell's memory, so a restart
/// would lose the one account of why it failed. Keep it beside the guardian's
/// incident record, once per Runtime Host instance.
fn keep_runtime_failure_evidence(
    runtime: &RuntimeHost,
    guardian: &HostGuardian,
    availability: &HostAvailability,
    reason: &str,
    recorded_instance: &mut Option<String>,
) {
    let instance_id = runtime.instance_id();
    if recorded_instance.as_deref() == Some(instance_id.as_str()) {
        return;
    }
    *recorded_instance = Some(instance_id);
    let Some(directory) = guardian.evidence_directory() else {
        return;
    };
    let occurred_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());
    let record = runtime_failure_record(reason, &runtime.failure_evidence(), &occurred_at);
    if let Err(error) = write_runtime_failure_record(&directory, &record) {
        availability.note_runtime_failure(&error);
    }
}

/// Returns true when the shell is exiting so the Host Guardian can restart it.
fn restart_through_guardian(
    app: &AppHandle,
    lifecycle: &ApplicationLifecycle,
    runtime: &RuntimeHost,
    guardian: &HostGuardian,
    availability: &HostAvailability,
    reason: &str,
) -> bool {
    if !guardian.is_enabled() {
        return false;
    }
    match guardian.prepare_restart(reason) {
        Ok(()) if lifecycle.begin_guardian_restart() => {
            let _ = runtime.shutdown();
            app.exit(GUARDIAN_RESTART_EXIT_CODE);
            true
        }
        Ok(()) => {
            let _ = guardian.cancel_restart();
            false
        }
        Err(error) => {
            availability.note_runtime_failure(&format!(
                "Host Guardian refused managed shell restart: {error}"
            ));
            false
        }
    }
}

pub(crate) fn start_runtime_health_monitor(
    app: AppHandle,
    runtime_supervisor: RuntimeHostSupervisor,
    guardian: HostGuardian,
    availability: HostAvailability,
) {
    thread::spawn(move || {
        let mut ticks = 0_u64;
        let mut ping_failures = 0_u8;
        let mut previous_network_path = network_path_fingerprint();
        let mut network_change_pending = false;
        let mut recorded_failure_instance = None;
        loop {
            thread::sleep(Duration::from_secs(5));
            let lifecycle = app.state::<ApplicationLifecycle>();
            if lifecycle.exit_mode() != EXIT_MODE_RUNNING {
                return;
            }

            let runtime = runtime_supervisor.active();
            let possible_suspend_or_stall = availability.sample_tick();
            let current_network_path = network_path_fingerprint();
            network_change_pending |= should_wake_tunnel_after_network_path_change(
                previous_network_path.as_deref(),
                current_network_path.as_deref(),
            );
            previous_network_path = current_network_path;
            if !runtime.is_healthy() {
                availability.note_runtime_failure(
                    "Runtime Host process or private protocol became unavailable.",
                );
                let reason = "runtime-host-process-or-protocol-unhealthy";
                keep_runtime_failure_evidence(
                    &runtime,
                    &guardian,
                    &availability,
                    reason,
                    &mut recorded_failure_instance,
                );
                if restart_through_guardian(
                    &app,
                    &lifecycle,
                    &runtime,
                    &guardian,
                    &availability,
                    reason,
                ) {
                    return;
                }
                continue;
            }

            ticks = ticks.saturating_add(1);
            if ticks % 3 == 0 {
                let ping_started = Instant::now();
                match runtime.ping() {
                    Ok(state) => {
                        ping_failures = 0;
                        availability.observe_runtime_state(&state);
                    }
                    Err(error) => {
                        availability.note_runtime_failure(&format!(
                            "Runtime Host health ping failed: {error}"
                        ));
                        // The next availability sample records stalls during this
                        // ping and wakes the tunnel. Check elapsed time here without
                        // consuming that sample or counting the stalled ping.
                        if !possible_suspend_or_stall
                            && ping_started.elapsed()
                                < Duration::from_millis(POSSIBLE_SUSPEND_GAP_MS)
                        {
                            ping_failures = ping_failures.saturating_add(1);
                        }
                        if runtime.is_healthy()
                            && ping_failures < RUNTIME_PING_FAILURES_BEFORE_RESTART
                        {
                            continue;
                        }
                        let reason = if runtime.is_healthy() {
                            "runtime-host-health-ping-failed"
                        } else {
                            "runtime-host-process-or-protocol-unhealthy"
                        };
                        keep_runtime_failure_evidence(
                            &runtime,
                            &guardian,
                            &availability,
                            reason,
                            &mut recorded_failure_instance,
                        );
                        if restart_through_guardian(
                            &app,
                            &lifecycle,
                            &runtime,
                            &guardian,
                            &availability,
                            reason,
                        ) {
                            return;
                        }
                        continue;
                    }
                }
            }

            if network_change_pending {
                // A missed ping must not consume a change before it is delivered.
                // Once dispatched, a timeout has an unknown outcome: subsequent
                // regular probes reconcile state instead of replaying a restart.
                network_change_pending = false;
                match runtime.refresh_tunnel_after_network_change() {
                    Ok(state) => availability.observe_runtime_state(&state),
                    Err(error) => availability.note_network_check_failure(&format!(
                        "Secure MCP Tunnel network-change recovery failed: {error}"
                    )),
                }
            } else if possible_suspend_or_stall || ticks % 6 == 0 {
                match runtime.refresh_tunnel() {
                    Ok(state) => availability.observe_runtime_state(&state),
                    Err(error) => availability.note_network_check_failure(&format!(
                        "Secure MCP Tunnel recovery check failed: {error}"
                    )),
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        runtime_failure_record, should_wake_tunnel_after_network_path_change,
        write_runtime_failure_record, RuntimeFailureEvidence, RUNTIME_FAILURE_FILE,
    };

    #[test]
    fn wakes_tunnel_only_when_a_new_usable_network_path_appears() {
        assert!(!should_wake_tunnel_after_network_path_change(None, None));
        assert!(should_wake_tunnel_after_network_path_change(
            None,
            Some("if4=12;v4=10.0.0.2")
        ));
        assert!(!should_wake_tunnel_after_network_path_change(
            Some("if4=12;v4=10.0.0.2"),
            None,
        ));
        assert!(!should_wake_tunnel_after_network_path_change(
            Some("if4=12;v4=10.0.0.2"),
            Some("if4=12;v4=10.0.0.2"),
        ));
        assert!(should_wake_tunnel_after_network_path_change(
            Some("if4=7;v4=192.0.2.10"),
            Some("if4=12;v4=198.51.100.20"),
        ));
    }

    #[test]
    fn keeps_why_the_runtime_host_failed_where_the_guardian_keeps_its_incidents() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let evidence = RuntimeFailureEvidence {
            instance_id: "runtime-instance-1".into(),
            process_id: Some(4242),
            exit_code: Some(1),
            uptime_ms: 44_000,
            error_message: Some("Runtime Host protocol pipe closed unexpectedly.".into()),
            stderr_tail: "[runtime-host uncaught] Error: boom\n".into(),
        };
        let record = runtime_failure_record(
            "runtime-host-process-or-protocol-unhealthy",
            &evidence,
            "2026-09-18T09:21:21Z",
        );
        write_runtime_failure_record(directory.path(), &record).expect("record written");
        write_runtime_failure_record(directory.path(), &record).expect("record replaced");

        let bytes = std::fs::read(directory.path().join(RUNTIME_FAILURE_FILE)).expect("record");
        let written: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(written["schemaVersion"], "scr.runtime-host-failure/v1");
        assert_eq!(written["reason"], "runtime-host-process-or-protocol-unhealthy");
        assert_eq!(written["exitCode"], 1);
        assert_eq!(written["uptimeMs"], 44_000);
        assert_eq!(written["stderrTail"], "[runtime-host uncaught] Error: boom\n");
        let leftovers = std::fs::read_dir(directory.path())
            .expect("directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name() != RUNTIME_FAILURE_FILE)
            .count();
        assert_eq!(leftovers, 0, "no temporary file may be left behind");
    }
}
