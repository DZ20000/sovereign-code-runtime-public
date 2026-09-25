use serde_json::json;

use super::*;

#[test]
fn derives_ready_and_retrying_tunnel_states() {
    let ready = json!({
        "phase": "running",
        "secureTunnel": {
            "phase": "ready",
            "clientAvailable": true,
            "tunnelId": "tunnel_0123456789abcdef0123456789abcdef",
            "desiredRunning": true,
            "autoStart": true,
            "reconnectAttempt": 0,
            "nextReconnectAt": null,
            "lastReadyAt": "2026-08-13T10:00:00Z",
            "errorMessage": null
        }
    });
    let (state, desired, attempt, next_retry, last_ready, detail) =
        tunnel_network_state(&ready);
    assert_eq!(state, NetworkState::Ready);
    assert!(desired);
    assert_eq!(attempt, 0);
    assert_eq!(next_retry, None);
    assert_eq!(last_ready.as_deref(), Some("2026-08-13T10:00:00Z"));
    assert_eq!(detail, None);

    let retrying = json!({
        "phase": "running",
        "secureTunnel": {
            "phase": "error",
            "clientAvailable": true,
            "tunnelId": "tunnel_0123456789abcdef0123456789abcdef",
            "desiredRunning": true,
            "autoStart": true,
            "reconnectAttempt": 3,
            "nextReconnectAt": "2026-08-13T10:01:00Z",
            "lastReadyAt": "2026-08-13T09:59:00Z",
            "errorMessage": "connector exited"
        }
    });
    let (state, desired, attempt, next_retry, _, detail) =
        tunnel_network_state(&retrying);
    assert_eq!(state, NetworkState::Retrying);
    assert!(desired);
    assert_eq!(attempt, 3);
    assert_eq!(next_retry.as_deref(), Some("2026-08-13T10:01:00Z"));
    assert_eq!(detail.as_deref(), Some("connector exited"));
}

#[test]
fn treats_locally_ready_reconnect_as_connecting_until_backoff_is_reset() {
    let stabilizing = json!({
        "phase": "running",
        "secureTunnel": {
            "phase": "ready",
            "clientAvailable": true,
            "tunnelId": "tunnel_0123456789abcdef0123456789abcdef",
            "desiredRunning": true,
            "autoStart": true,
            "reconnectAttempt": 3,
            "nextReconnectAt": null,
            "lastReadyAt": "2026-08-13T10:00:00Z",
            "errorMessage": null
        }
    });
    let (state, desired, attempt, next_retry, last_ready, detail) =
        tunnel_network_state(&stabilizing);
    assert_eq!(state, NetworkState::Connecting);
    assert!(desired);
    assert_eq!(attempt, 3);
    assert_eq!(next_retry, None);
    assert_eq!(last_ready.as_deref(), Some("2026-08-13T10:00:00Z"));
    assert_eq!(
        detail.as_deref(),
        Some("Secure MCP Tunnel is locally ready and stabilizing after reconnect.")
    );
}

#[test]
fn derives_degraded_and_not_configured_states_without_exposing_logs() {
    let degraded = json!({
        "phase": "error",
        "secureTunnel": {
            "phase": "stopped",
            "clientAvailable": true,
            "tunnelId": "tunnel_0123456789abcdef0123456789abcdef",
            "desiredRunning": true,
            "autoStart": true,
            "reconnectAttempt": 0,
            "nextReconnectAt": null,
            "lastReadyAt": null,
            "errorMessage": "runtime unavailable",
            "logTail": "must not cross the diagnostics boundary"
        }
    });
    let (state, desired, _, _, _, detail) = tunnel_network_state(&degraded);
    assert_eq!(state, NetworkState::Degraded);
    assert!(desired);
    assert_eq!(detail.as_deref(), Some("runtime unavailable"));

    let unconfigured = json!({
        "phase": "running",
        "secureTunnel": {
            "phase": "unavailable",
            "clientAvailable": false,
            "tunnelId": null,
            "desiredRunning": false,
            "autoStart": false,
            "reconnectAttempt": 0,
            "nextReconnectAt": null,
            "lastReadyAt": null,
            "errorMessage": null
        }
    });
    let (state, desired, _, _, _, detail) = tunnel_network_state(&unconfigured);
    assert_eq!(state, NetworkState::NotConfigured);
    assert!(!desired);
    assert_eq!(detail, None);
}

#[test]
fn accepts_only_bounded_well_formed_persisted_events() {
    let valid = AvailabilityEvent {
        occurred_at: "2026-08-13T10:00:00Z".to_string(),
        kind: AvailabilityEventKind::NetworkRecovered,
        detail: "Tunnel returned to ready.".to_string(),
        duration_ms: Some(42_000),
    };
    assert!(validate_event(valid).is_some());

    let invalid_time = AvailabilityEvent {
        occurred_at: "not-a-time".to_string(),
        kind: AvailabilityEventKind::NetworkLoss,
        detail: "Tunnel left ready.".to_string(),
        duration_ms: None,
    };
    assert!(validate_event(invalid_time).is_none());

    let oversized = AvailabilityEvent {
        occurred_at: "2026-08-13T10:00:00Z".to_string(),
        kind: AvailabilityEventKind::PossibleSuspendOrStall,
        detail: "x".repeat(MAX_DETAIL_CHARS + 1),
        duration_ms: Some(20_000),
    };
    assert!(validate_event(oversized).is_none());
}
