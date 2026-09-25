use super::*;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::json;
use tempfile::TempDir;

fn signing_key() -> Ed25519KeyPair {
    Ed25519KeyPair::from_seed_unchecked(&[7_u8; 32]).expect("test Ed25519 key")
}

fn trusted_key(pair: &Ed25519KeyPair) -> ParsedTrustedRendererKey {
    let mut public_key = [0_u8; 32];
    public_key.copy_from_slice(pair.public_key().as_ref());
    ParsedTrustedRendererKey {
        key_id: "renderer-test-key".into(),
        public_key,
        minimum_release_sequence: 1,
        maximum_release_sequence: None,
        allowed_channels: HashSet::from(["development".to_string()]),
    }
}

fn component(path: &str, bytes: &[u8]) -> RendererReleaseComponent {
    RendererReleaseComponent {
        path: path.into(),
        sha256: sha256_bytes(bytes),
        bytes: bytes.len() as u64,
    }
}

fn manifest(release_id: &str, release_sequence: u64) -> RendererReleaseManifest {
    let index = b"<!doctype html><html><body><div id=\"app\"></div><script type=\"module\" src=\"./assets/main.js\"></script></body></html>";
    let script = b"document.querySelector('#app').textContent = 'renderer test';\n";
    RendererReleaseManifest {
        schema_version: RENDERER_MANIFEST_SCHEMA_VERSION.into(),
        release_id: release_id.into(),
        release_sequence,
        version: "0.1.1".into(),
        channel: "development".into(),
        created_at: "2026-08-23T00:00:00.000Z".into(),
        entrypoint: "index.html".into(),
        total_bytes: (index.len() + script.len()) as u64,
        components: vec![
            component("index.html", index),
            component("assets/main.js", script),
        ],
        compatibility: RendererReleaseCompatibility {
            minimum_shell_version: SHELL_VERSION.into(),
            maximum_shell_version: None,
            bridge_api_version: RENDERER_BRIDGE_API_VERSION,
        },
    }
}

fn signed_envelope(
    renderer_manifest: RendererReleaseManifest,
    pair: &Ed25519KeyPair,
) -> (RendererReleaseEnvelope, Vec<u8>) {
    validate_manifest(&renderer_manifest).expect("valid test manifest");
    let manifest_bytes = canonical_json(&renderer_manifest).expect("canonical manifest");
    let manifest_sha256 = sha256_bytes(&manifest_bytes);
    let signature = pair
        .sign(&renderer_signature_payload(&manifest_sha256).expect("signature payload"))
        .as_ref()
        .to_vec();
    let envelope = RendererReleaseEnvelope {
        schema_version: RENDERER_SIGNATURE_SCHEMA_VERSION.into(),
        algorithm: "ed25519".into(),
        key_id: "renderer-test-key".into(),
        manifest_sha256,
        signature: URL_SAFE_NO_PAD.encode(signature),
        manifest: renderer_manifest,
    };
    let bytes = serde_json::to_vec_pretty(&envelope).expect("test envelope JSON");
    (envelope, bytes)
}

fn public_key_pem(pair: &Ed25519KeyPair) -> String {
    let mut der = ED25519_SPKI_PREFIX.to_vec();
    der.extend_from_slice(pair.public_key().as_ref());
    format!(
        "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----",
        STANDARD.encode(der)
    )
}

fn write_inbox(root: &Path, release_id: &str, pair: &Ed25519KeyPair) -> RendererReleaseEnvelope {
    let renderer_manifest = manifest(release_id, 2);
    let (envelope, envelope_bytes) = signed_envelope(renderer_manifest, pair);
    let inbox = root.join("inbox").join(release_id);
    let bundle = inbox.join(RENDERER_BUNDLE_DIRECTORY);
    fs::create_dir_all(bundle.join("assets")).expect("create test inbox");
    fs::write(inbox.join(RENDERER_ENVELOPE_FILE), envelope_bytes).expect("write test envelope");
    fs::write(
        bundle.join("index.html"),
        b"<!doctype html><html><body><div id=\"app\"></div><script type=\"module\" src=\"./assets/main.js\"></script></body></html>",
    )
    .expect("write test index");
    fs::write(
        bundle.join("assets").join("main.js"),
        b"document.querySelector('#app').textContent = 'renderer test';\n",
    )
    .expect("write test script");
    envelope
}

fn manager_with_release_guard(
    root: &Path,
    pair: &Ed25519KeyPair,
    release_guard_required: bool,
) -> RendererUpdateManager {
    RendererUpdateManager::from_parts(
        root.to_path_buf(),
        Url::parse("tauri://localhost/index.html").expect("built-in URL"),
        vec![trusted_key(pair)],
        release_guard_required,
    )
    .expect("renderer update manager")
}

fn manager(root: &Path, pair: &Ed25519KeyPair) -> RendererUpdateManager {
    manager_with_release_guard(root, pair, false)
}

fn release_guard_timestamp(unix_ms: u64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(unix_ms) * 1_000_000)
        .expect("test release guard timestamp")
        .format(&Rfc3339)
        .expect("format test release guard timestamp")
}

fn write_release_guard(root: &Path, envelope: &RendererReleaseEnvelope) {
    let coordination = root.join("coordination");
    fs::create_dir_all(coordination.join("releases")).expect("create release guard directories");
    let now = now_unix_ms();
    let acquired_at = release_guard_timestamp(now.saturating_sub(1_000));
    let lease_id = "renderer-test-lease-0002";
    let release = &envelope.manifest;
    fs::write(
        coordination.join("activation-lease.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "schemaVersion": "scr.renderer-activation-lease/v1",
                "leaseId": lease_id,
                "status": "held",
                "ownerPrincipal": "renderer-test-owner",
                "originTaskId": "task-renderer-test",
                "targetReleaseId": release.release_id,
                "targetReleaseSequence": release.release_sequence,
                "sourceCommit": "a".repeat(40),
                "manifestSha256": envelope.manifest_sha256,
                "previousActiveReleaseId": null,
                "previousActiveSequence": null,
                "shellPid": std::process::id(),
                "acquiredAt": acquired_at,
                "expiresAt": release_guard_timestamp(now.saturating_add(5 * 60_000)),
                "policy": {
                    "allowShellRestart": false,
                    "requireCommittedSnapshot": true,
                    "requireMonotonicSequence": true,
                    "requireOriginTask": true,
                    "quarantineOlderCandidates": true
                }
            }))
            .expect("serialize test activation lease")
        ),
    )
    .expect("write test activation lease");
    fs::write(
        coordination
            .join("releases")
            .join(format!("{}.json", release.release_id)),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "schemaVersion": "scr.renderer-release-provenance/v1",
                "releaseId": release.release_id,
                "releaseSequence": release.release_sequence,
                "version": release.version,
                "channel": release.channel,
                "sourceCommit": "a".repeat(40),
                "originTaskId": "task-renderer-test",
                "ownerPrincipal": "renderer-test-owner",
                "manifestSha256": envelope.manifest_sha256,
                "candidateDirectory": root.join("inbox").join(&release.release_id),
                "stagedAt": acquired_at,
                "leaseId": lease_id
            }))
            .expect("serialize test release provenance")
        ),
    )
    .expect("write test release provenance");
}

#[test]
fn development_install_requires_held_runtime_release_guard() {
    let temporary = TempDir::new().expect("temporary renderer root");
    let pair = signing_key();
    let envelope = write_inbox(temporary.path(), "renderer-guarded-0002", &pair);
    let manager = manager_with_release_guard(temporary.path(), &pair, true);

    assert!(manager
        .install("renderer-guarded-0002")
        .expect_err("unguarded development install must fail")
        .contains("release coordination"));
    assert!(!temporary
        .path()
        .join("slots")
        .join("renderer-guarded-0002")
        .exists());

    write_release_guard(temporary.path(), &envelope);
    let status = manager
        .install("renderer-guarded-0002")
        .expect("guarded development install");
    assert_eq!(status.installed_releases.len(), 1);
}

#[test]
fn verifies_canonical_ed25519_renderer_envelopes_and_key_registry() {
    let pair = signing_key();
    let (envelope, bytes) = signed_envelope(manifest("renderer-test-0002", 2), &pair);
    let verified =
        verify_renderer_envelope(&bytes, &[trusted_key(&pair)]).expect("signed renderer envelope");
    assert_eq!(verified.envelope.manifest.release_id, "renderer-test-0002");
    assert_eq!(verified.manifest_sha256, envelope.manifest_sha256);

    let registry = json!({
        "schemaVersion": RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
        "keys": [{
            "keyId": "renderer-test-key",
            "algorithm": "ed25519",
            "publicKeyPem": public_key_pem(&pair),
            "minimumReleaseSequence": 1,
            "maximumReleaseSequence": 10,
            "allowedChannels": ["development"]
        }]
    });
    let parsed =
        parse_trusted_key_registry(&serde_json::to_vec(&registry).expect("trusted registry JSON"))
            .expect("trusted renderer key registry");
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].public_key.as_slice(), pair.public_key().as_ref());

    let mut tampered = envelope;
    tampered.manifest.version = "0.1.2".into();
    let tampered_bytes = serde_json::to_vec(&tampered).expect("tampered JSON");
    assert!(verify_renderer_envelope(&tampered_bytes, &parsed)
        .expect_err("tampered manifest must fail")
        .contains("digest does not match"));
}

#[test]
fn installs_serves_and_rejects_tampered_renderer_components() {
    let temporary = TempDir::new().expect("temporary renderer root");
    let pair = signing_key();
    write_inbox(temporary.path(), "renderer-test-0002", &pair);
    let manager = manager(temporary.path(), &pair);

    let status = manager
        .install("renderer-test-0002")
        .expect("install signed renderer");
    assert_eq!(status.installed_releases.len(), 1);
    assert_eq!(
        status.installed_releases[0].release_id,
        "renderer-test-0002"
    );
    let installed_release = manager
        .installed_release("renderer-test-0002")
        .expect("installed renderer release");

    let custom_url = Url::parse("sovereign-ui://localhost/release/renderer-test-0002/index.html")
        .expect("renderer custom URL");
    let built_in_url = Url::parse("tauri://localhost/index.html").expect("built-in renderer URL");
    assert!(!manager.navigation_authorized("main", &custom_url));
    assert!(manager.navigation_authorized("main", &built_in_url));

    let unauthorized = Request::builder()
        .method(Method::GET)
        .uri(custom_url.as_str())
        .body(Vec::new())
        .expect("unauthorized renderer protocol request");
    assert_eq!(
        manager.protocol_response("main", unauthorized).status(),
        StatusCode::FORBIDDEN
    );

    {
        let mut state = manager.inner.state.lock().expect("renderer manager state");
        state.persisted = persist_state_journal(
            temporary.path(),
            &state.persisted,
            Some(installed_release.release.clone()),
            None,
            None,
        )
        .expect("publish active renderer test state");
    }

    assert!(manager.navigation_authorized("main", &custom_url));
    assert!(!manager.navigation_authorized("main", &built_in_url));

    let request = Request::builder()
        .method(Method::GET)
        .uri("sovereign-ui://localhost/release/renderer-test-0002/index.html")
        .body(Vec::new())
        .expect("renderer protocol request");
    let response = manager.protocol_response("main", request);
    assert_eq!(response.status(), StatusCode::OK);
    assert!(String::from_utf8(response.body().clone())
        .expect("renderer response text")
        .contains("<div id=\"app\">"));
    assert_eq!(
        response
            .headers()
            .get("content-security-policy")
            .and_then(|value| value.to_str().ok()),
        Some(CSP_HEADER_VALUE)
    );

    fs::write(
        temporary
            .path()
            .join("slots")
            .join("renderer-test-0002")
            .join("index.html"),
        b"tampered renderer",
    )
    .expect("tamper renderer slot");
    let request = Request::builder()
        .method(Method::GET)
        .uri("sovereign-ui://localhost/release/renderer-test-0002/index.html")
        .body(Vec::new())
        .expect("tampered renderer request");
    let response = manager.protocol_response("main", request);
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(manager
        .status()
        .last_failure
        .as_deref()
        .is_some_and(|value| value.contains("Blocked renderer component")));
    let revision_after_first_failure = manager
        .inner
        .state
        .lock()
        .expect("renderer manager state")
        .persisted
        .revision
        .storage_revision;
    let repeated = Request::builder()
        .method(Method::GET)
        .uri("sovereign-ui://localhost/release/renderer-test-0002/index.html")
        .body(Vec::new())
        .expect("repeated tampered renderer request");
    assert_eq!(
        manager.protocol_response("main", repeated).status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        manager
            .inner
            .state
            .lock()
            .expect("renderer manager state")
            .persisted
            .revision
            .storage_revision,
        revision_after_first_failure,
        "repeated integrity failures must not exhaust the immutable journal"
    );
}

#[test]
fn rejects_extra_payload_entries_and_protocol_traversal() {
    let temporary = TempDir::new().expect("temporary renderer root");
    let pair = signing_key();
    write_inbox(temporary.path(), "renderer-extra-0002", &pair);
    fs::write(
        temporary
            .path()
            .join("inbox")
            .join("renderer-extra-0002")
            .join("bundle")
            .join("extra.txt"),
        b"extra",
    )
    .expect("write extra renderer component");
    let manager = manager(temporary.path(), &pair);
    assert!(manager
        .install("renderer-extra-0002")
        .expect_err("extra renderer payload must fail")
        .contains("missing or extra"));

    let request = Request::builder()
        .method(Method::GET)
        .uri("sovereign-ui://localhost/release/renderer-extra-0002/../envelope.json")
        .body(Vec::new())
        .expect("renderer traversal request");
    let response = manager.protocol_response("main", request);
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[test]
fn staged_renderer_does_not_raise_the_activation_floor_on_a_clean_restart() {
    let temporary = TempDir::new().expect("temporary renderer root");
    let pair = signing_key();
    write_inbox(temporary.path(), "renderer-staged-0002", &pair);
    let current = manager(temporary.path(), &pair);
    current
        .install("renderer-staged-0002")
        .expect("install staged renderer");
    drop(current);

    let restarted = manager(temporary.path(), &pair);
    let status = restarted.status();
    assert_eq!(status.highest_release_sequence, 0);
    assert_eq!(status.installed_releases.len(), 1);
    assert!(status.active_release.is_none());
}

#[test]
fn corrupt_state_recovery_raises_the_floor_to_verified_installed_slots() {
    let temporary = TempDir::new().expect("temporary renderer root");
    let pair = signing_key();
    write_inbox(temporary.path(), "renderer-recovered-0002", &pair);
    let current = manager(temporary.path(), &pair);
    current
        .install("renderer-recovered-0002")
        .expect("install staged renderer");
    {
        let mut state = current.inner.state.lock().expect("renderer manager state");
        state.persisted =
            persist_state_journal(temporary.path(), &state.persisted, None, None, None)
                .expect("write renderer state revision");
    }
    drop(current);
    fs::write(
        temporary.path().join("state").join(state_revision_name(1)),
        b"{corrupt",
    )
    .expect("corrupt renderer journal");

    let recovered = manager(temporary.path(), &pair);
    let status = recovered.status();
    assert_eq!(status.highest_release_sequence, 2);
    assert!(status.built_in_active);
    assert!(status
        .last_failure
        .as_deref()
        .is_some_and(|value| value.contains("state journal was corrupt")));
}

#[test]
fn status_exposes_only_live_digest_bound_preflight_receipts() {
    let temporary = TempDir::new().expect("temporary renderer root");
    let pair = signing_key();
    write_inbox(temporary.path(), "renderer-preflighted-0002", &pair);
    let manager = manager(temporary.path(), &pair);
    manager
        .install("renderer-preflighted-0002")
        .expect("install renderer candidate");
    assert!(manager.status().preflighted_release_ids.is_empty());
    let installed = manager
        .installed_release("renderer-preflighted-0002")
        .expect("installed renderer candidate");
    {
        let mut state = manager.inner.state.lock().expect("renderer manager state");
        state.preflight_receipts.insert(
            installed.release.release_id.clone(),
            PreflightReceipt {
                release: installed.release.clone(),
                completed_at: Instant::now(),
            },
        );
    }
    assert_eq!(
        manager.status().preflighted_release_ids,
        vec!["renderer-preflighted-0002".to_string()]
    );
    {
        let mut state = manager.inner.state.lock().expect("renderer manager state");
        state
            .preflight_receipts
            .get_mut("renderer-preflighted-0002")
            .expect("preflight receipt")
            .completed_at = Instant::now()
            .checked_sub(PREFLIGHT_RECEIPT_TTL + Duration::from_secs(1))
            .expect("expired preflight timestamp");
    }
    assert!(manager.status().preflighted_release_ids.is_empty());
}

#[test]
fn preflight_commands_require_a_live_manager_ticket() {
    let temporary = TempDir::new().expect("temporary renderer root");
    let pair = signing_key();
    let manager = manager(temporary.path(), &pair);
    let label = "renderer-preflight-live-ticket";
    assert!(manager.assert_active_preflight_window(label).is_err());
    {
        let mut state = manager.inner.state.lock().expect("renderer manager state");
        state.preflight_waits.insert(
            label.to_string(),
            PreflightWait {
                expected_release_id: "renderer-test-0002".into(),
                result: None,
            },
        );
    }
    assert!(manager.assert_active_preflight_window(label).is_ok());
    manager
        .inner
        .state
        .lock()
        .expect("renderer manager state")
        .preflight_waits
        .remove(label);
    assert!(manager.assert_active_preflight_window(label).is_err());
    assert!(manager.assert_active_preflight_window("main").is_err());
}

#[test]
fn webview_navigation_preserves_built_in_urls() {
    let built_in = Url::parse(
        "http://tauri.localhost/index.html?rendererActivation=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .expect("built-in renderer URL");
    assert_eq!(
        webview_navigation_url(built_in.clone()).expect("built-in WebView URL"),
        built_in
    );
}

#[cfg(windows)]
#[test]
fn webview_navigation_translates_custom_protocol_for_webview2() {
    let native = Url::parse(
        "sovereign-ui://localhost/release/renderer-test-0002/index.html?rendererActivation=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .expect("native renderer URL");
    let translated = webview_navigation_url(native).expect("Windows renderer WebView URL");
    assert_eq!(
        translated.as_str(),
        "http://sovereign-ui.localhost/release/renderer-test-0002/index.html?rendererActivation=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    assert!(navigation_allowed("main", &translated));
}

#[cfg(not(windows))]
#[test]
fn webview_navigation_preserves_custom_protocol_off_windows() {
    let native = Url::parse(
        "sovereign-ui://localhost/release/renderer-test-0002/index.html?rendererActivation=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .expect("native renderer URL");
    assert_eq!(
        webview_navigation_url(native.clone()).expect("renderer WebView URL"),
        native
    );
}

#[test]
fn navigation_policy_blocks_external_and_cross_surface_navigation() {
    let activation_id = "a".repeat(32);
    assert!(navigation_allowed(
        "main",
        &Url::parse("tauri://localhost/index.html").expect("built-in URL")
    ));
    assert!(navigation_allowed(
        "main",
        &Url::parse(&format!(
            "sovereign-ui://localhost/release/renderer-test-0002/index.html?rendererActivation={activation_id}"
        ))
        .expect("renderer URL")
    ));
    assert!(navigation_allowed(
        "main",
        &Url::parse("http://sovereign-ui.localhost/release/renderer-test-0002/index.html")
            .expect("Windows renderer URL")
    ));
    assert!(!navigation_allowed(
        "main",
        &Url::parse("http://sovereign-ui.localhost/release/renderer-test-0002/assets/main.js")
            .expect("Windows renderer asset navigation")
    ));
    assert!(!navigation_allowed(
        "main",
        &Url::parse("https://example.com/").expect("external URL")
    ));
    assert!(!navigation_allowed(
        "main",
        &Url::parse(
            "sovereign-ui://localhost/release/renderer-test-0002/index.html?rendererActivation=bad"
        )
        .expect("bad activation URL")
    ));
    assert!(!navigation_allowed(
        "main",
        &Url::parse("sovereign-ui://localhost/release/renderer-test-0002/index.html?unexpected=1")
            .expect("unexpected query URL")
    ));

    assert!(!navigation_allowed(
        "main",
        &Url::parse("sovereign-ui://localhost/release/renderer-test-0002/approval.html")
            .expect("non-entrypoint renderer URL")
    ));

    let label = "renderer-preflight-0123456789abcdef";
    assert!(navigation_allowed(
        label,
        &Url::parse(&format!(
            "sovereign-ui://localhost/release/renderer-test-0002/index.html?rendererPreflight=1&preflightLabel={label}"
        ))
        .expect("preflight URL")
    ));
    assert!(!navigation_allowed(
        label,
        &Url::parse("tauri://localhost/index.html").expect("built-in preflight URL")
    ));
    assert!(!navigation_allowed(
        label,
        &Url::parse("sovereign-ui://localhost/release/renderer-test-0002/index.html?rendererPreflight=1&preflightLabel=renderer-preflight-other")
            .expect("mismatched preflight URL")
    ));
    assert!(navigation_allowed(
        "approval",
        &Url::parse("tauri://localhost/approval.html").expect("approval URL")
    ));
}

#[test]
fn activation_guards_bind_the_built_in_target_to_a_unique_nonce() {
    let temporary = TempDir::new().expect("temporary renderer root");
    let pair = signing_key();
    let manager = manager(temporary.path(), &pair);

    let activation_id = manager
        .begin_activation_guard(None, None, None, "rollback", false)
        .expect("built-in activation guard");
    assert_eq!(activation_id.len(), 32);
    let pending = manager
        .status()
        .pending_activation
        .expect("pending activation status");
    assert!(pending.built_in);
    assert!(pending.release_id.is_none());
    let url = manager
        .activation_url(None, &activation_id)
        .expect("built-in activation URL");
    assert_eq!(
        url.query_pairs()
            .find(|(name, _)| name == "rendererActivation")
            .map(|(_, value)| value.into_owned()),
        Some(activation_id.clone())
    );
    assert!(manager.navigation_authorized("main", &url));
    assert!(!manager.navigation_authorized(
        "main",
        &Url::parse("tauri://localhost/index.html").expect("built-in URL without nonce")
    ));
    assert!(!manager.navigation_authorized(
        "main",
        &Url::parse(&format!(
            "tauri://localhost/index.html?rendererActivation={}",
            "b".repeat(32)
        ))
        .expect("built-in URL with stale nonce")
    ));
    assert!(manager.activation_url(None, "not-a-valid-nonce").is_err());
    assert!(manager
        .restore_pending_activation("0", "stale activation", true)
        .is_err());
    assert!(manager.status().pending_activation.is_some());

    let restored = manager
        .restore_pending_activation(&activation_id, "test rollback", true)
        .expect("restore built-in activation");
    assert!(restored.is_none());
    assert!(manager.status().pending_activation.is_none());
}

#[test]
fn highest_release_sequence_remains_monotonic_after_rollback() {
    let temporary = TempDir::new().expect("temporary renderer root");
    let release = RendererReleaseRef {
        release_id: "renderer-sequence-0005".into(),
        release_sequence: 5,
        version: "0.1.5".into(),
        channel: "development".into(),
        manifest_sha256: "a".repeat(64),
    };
    let active = persist_state_journal(
        temporary.path(),
        &default_persisted_state(),
        Some(release),
        None,
        None,
    )
    .expect("persist active renderer sequence");
    assert_eq!(active.revision.highest_release_sequence, 5);

    let rolled_back = persist_state_journal(
        temporary.path(),
        &active,
        None,
        None,
        Some("local rollback".into()),
    )
    .expect("persist renderer rollback");
    assert_eq!(rolled_back.revision.highest_release_sequence, 5);
    let reloaded = load_state_journal(temporary.path()).expect("reload renderer journal");
    assert_eq!(reloaded.revision.highest_release_sequence, 5);

    let floored =
        persist_state_journal_with_floor(temporary.path(), &reloaded, None, None, None, 7)
            .expect("raise renderer sequence floor");
    assert_eq!(floored.revision.highest_release_sequence, 7);
}

#[test]
fn rejects_missing_required_nullable_fields() {
    let pair = signing_key();
    let (envelope, _) = signed_envelope(manifest("renderer-nullable-0002", 2), &pair);
    let mut envelope_value = serde_json::to_value(envelope).expect("renderer envelope value");
    envelope_value["manifest"]["compatibility"]
        .as_object_mut()
        .expect("renderer compatibility object")
        .remove("maximumShellVersion");
    assert!(verify_renderer_envelope(
        &serde_json::to_vec(&envelope_value).expect("renderer envelope JSON"),
        &[trusted_key(&pair)],
    )
    .expect_err("missing nullable compatibility field must fail")
    .contains("missing field"));

    let mut registry = json!({
        "schemaVersion": RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
        "keys": [{
            "keyId": "renderer-test-key",
            "algorithm": "ed25519",
            "publicKeyPem": public_key_pem(&pair),
            "minimumReleaseSequence": 1,
            "maximumReleaseSequence": null,
            "allowedChannels": ["development"]
        }]
    });
    registry["keys"][0]
        .as_object_mut()
        .expect("trusted renderer key object")
        .remove("maximumReleaseSequence");
    assert!(parse_trusted_key_registry(
        &serde_json::to_vec(&registry).expect("trusted registry JSON")
    )
    .expect_err("missing nullable trusted-key field must fail")
    .contains("missing field"));

    let handoff = json!({
        "schemaVersion": RENDERER_HANDOFF_SCHEMA_VERSION,
        "settingsTab": null,
        "scrollTop": 0
    });
    assert!(serde_json::from_value::<RendererHandoff>(handoff).is_err());

    let mut state =
        serde_json::to_value(default_persisted_state().revision).expect("renderer state value");
    state
        .as_object_mut()
        .expect("renderer state object")
        .remove("lastFailure");
    assert!(serde_json::from_value::<RendererStateRevision>(state).is_err());
}

#[test]
fn rejects_release_sequences_outside_the_safe_json_integer_range() {
    let pair = signing_key();
    let mut renderer_manifest = manifest("renderer-too-large", 2);
    renderer_manifest.release_sequence = MAX_SAFE_JSON_INTEGER + 1;
    assert!(validate_manifest(&renderer_manifest)
        .expect_err("unsafe renderer sequence must fail")
        .contains("safe JSON integer"));

    let registry = json!({
        "schemaVersion": RENDERER_TRUSTED_KEYS_SCHEMA_VERSION,
        "keys": [{
            "keyId": "renderer-test-key",
            "algorithm": "ed25519",
            "publicKeyPem": public_key_pem(&pair),
            "minimumReleaseSequence": MAX_SAFE_JSON_INTEGER + 1,
            "maximumReleaseSequence": null,
            "allowedChannels": ["development"]
        }]
    });
    assert!(parse_trusted_key_registry(
        &serde_json::to_vec(&registry).expect("trusted registry JSON")
    )
    .expect_err("unsafe trusted key sequence must fail")
    .contains("safe JSON integer"));
}

#[test]
fn quarantines_corrupt_state_and_restores_the_built_in_renderer() {
    let temporary = TempDir::new().expect("temporary renderer root");
    fs::create_dir_all(temporary.path()).expect("renderer root");
    let persisted = persist_state_journal(
        temporary.path(),
        &default_persisted_state(),
        None,
        None,
        None,
    )
    .expect("persist initial renderer state");
    assert_eq!(persisted.revision.storage_revision, 1);
    fs::write(
        temporary.path().join("state").join(state_revision_name(1)),
        b"{not-json",
    )
    .expect("corrupt renderer state");

    let manager = RendererUpdateManager::from_parts(
        temporary.path().to_path_buf(),
        Url::parse("tauri://localhost/index.html").expect("built-in URL"),
        Vec::new(),
        false,
    )
    .expect("recover corrupt renderer state");
    let status = manager.status();
    assert!(status.built_in_active);
    assert!(status
        .last_failure
        .as_deref()
        .is_some_and(|value| value.contains("state journal was corrupt")));
    let quarantines = fs::read_dir(temporary.path())
        .expect("enumerate renderer root")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("state-corrupt-")
        })
        .count();
    assert_eq!(quarantines, 1);
}
