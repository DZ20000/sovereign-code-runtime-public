use super::*;
use ring::{rand::SystemRandom, signature::Ed25519KeyPair};
use tempfile::TempDir;

fn key_pair() -> (Ed25519KeyPair, ParsedTrustedRuntimeKey) {
    use ring::signature::KeyPair as _;
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
    let mut public_key = [0_u8; 32];
    public_key.copy_from_slice(pair.public_key().as_ref());
    (
        pair,
        ParsedTrustedRuntimeKey {
            key_id: "test-key-1".into(),
            public_key,
            minimum_release_sequence: 1,
            maximum_release_sequence: None,
        },
    )
}

fn manager(temp: &TempDir, keys: Vec<ParsedTrustedRuntimeKey>) -> RuntimeCandidateUpdateManager {
    RuntimeCandidateUpdateManager::from_parts(
        temp.path().join("runtime-updates"),
        keys,
        "1.0.0".into(),
        CURRENT_RUNTIME_PROTOCOL_VERSION,
    )
    .unwrap()
}

fn managed_manager(
    temp: &TempDir,
    keys: Vec<ParsedTrustedRuntimeKey>,
) -> RuntimeCandidateUpdateManager {
    RuntimeCandidateUpdateManager::from_parts_with_policy(
        temp.path().join("runtime-updates"),
        keys,
        "1.0.0".into(),
        CURRENT_RUNTIME_PROTOCOL_VERSION,
        true,
    )
    .unwrap()
}

fn create_package(
    manager: &RuntimeCandidateUpdateManager,
    pair: &Ed25519KeyPair,
    release_id: &str,
    sequence: u64,
    runtime_bytes: &[u8],
) -> VerifiedEnvelope {
    let release_root = manager.inner.inbox_root.join(release_id);
    fs::create_dir(&release_root).unwrap();
    fs::write(release_root.join(RUNTIME_HOST_FILE), runtime_bytes).unwrap();
    let manifest = RuntimeCandidateManifest {
        schema_version: RELEASE_MANIFEST_SCHEMA_VERSION.into(),
        release_id: release_id.into(),
        release_sequence: sequence,
        created_at_unix_ms: now_unix_ms(),
        minimum_shell_version: "1.0.0".into(),
        runtime_protocol_version: CURRENT_RUNTIME_PROTOCOL_VERSION,
        component: RuntimeCandidateComponent {
            path: RUNTIME_HOST_FILE.into(),
            size: runtime_bytes.len() as u64,
            sha256: sha256_bytes(runtime_bytes),
        },
    };
    let manifest_sha256 = sha256_bytes(&canonical_json(&manifest).unwrap());
    let signature = URL_SAFE_NO_PAD.encode(pair.sign(&signature_payload(&manifest_sha256)));
    let envelope = RuntimeCandidateEnvelope {
        schema_version: RELEASE_ENVELOPE_SCHEMA_VERSION.into(),
        algorithm: "ed25519".into(),
        key_id: "test-key-1".into(),
        manifest_sha256,
        manifest,
        signature,
    };
    fs::write(
        release_root.join(ENVELOPE_FILE),
        canonical_json(&envelope).unwrap(),
    )
    .unwrap();
    validate_package(
        &release_root,
        release_id,
        &manager.inner.trusted_keys,
        &manager.inner.shell_version,
        manager.inner.runtime_protocol_version,
    )
    .unwrap()
}

fn write_managed_receipt(manager: &RuntimeCandidateUpdateManager, release_id: &str) {
    let candidate = validate_package(
        &manager.inner.inbox_root.join(release_id),
        release_id,
        &manager.inner.trusted_keys,
        &manager.inner.shell_version,
        manager.inner.runtime_protocol_version,
    )
    .unwrap();
    let sequence = candidate.envelope.manifest.release_sequence;
    let core = serde_json::json!({
        "importedAtUnixMs": now_unix_ms(),
        "indexEnvelopeSha256": "1".repeat(64),
        "indexSequence": sequence,
        "indexSha256": "2".repeat(64),
        "indexSigningKeyId": "index-key-1",
        "previousReceiptSha256": null,
        "releases": [{
            "envelopeSha256": sha256_bytes(&candidate.canonical_envelope),
            "outcome": "staged",
            "releaseId": release_id,
            "releaseSequence": sequence,
            "runtimeHostSha256": candidate.envelope.manifest.component.sha256,
            "signingKeyId": candidate.envelope.key_id,
        }],
        "schemaVersion": "scr.runtime-host-release-index-import-receipt/v1",
    });
    let receipt_id = sha256_bytes(&canonical_json(&core).unwrap());
    let mut receipt = core;
    receipt
        .as_object_mut()
        .unwrap()
        .insert("receiptId".into(), Value::String(receipt_id.clone()));
    let receipt_root = manager.inner.root.join("import-receipts");
    fs::create_dir(&receipt_root).unwrap();
    fs::write(
        receipt_root.join(format!("{sequence:016}-{receipt_id}.json")),
        canonical_json(&receipt).unwrap(),
    )
    .unwrap();
}

#[test]
fn managed_preflight_blocks_install_until_the_inbox_is_receipted() {
    let temp = TempDir::new().unwrap();
    let (pair, key) = key_pair();
    let manager = managed_manager(&temp, vec![key]);
    create_package(&manager, &pair, "runtime-2", 2, b"runtime two");

    let error = manager.install_release("runtime-2").unwrap_err();
    assert!(error.starts_with(MANAGED_PREFLIGHT_ERROR_PREFIX));
    assert!(fs::read_dir(&manager.inner.slots_root)
        .unwrap()
        .next()
        .is_none());
    assert!(!manager.inner.state_path.exists());

    write_managed_receipt(&manager, "runtime-2");
    assert!(!manager.install_release("runtime-2").unwrap().idempotent);
}

#[test]
fn managed_preflight_reloads_durable_state_before_installing() {
    let temp = TempDir::new().unwrap();
    let (pair, key) = key_pair();
    let manager = managed_manager(&temp, vec![key]);
    create_package(&manager, &pair, "runtime-3", 3, b"runtime three");
    write_managed_receipt(&manager, "runtime-3");
    let drifted = RuntimeCandidateState {
        highest_release_sequence: 9,
        ..RuntimeCandidateState::default()
    };
    fs::write(&manager.inner.state_path, canonical_json(&drifted).unwrap()).unwrap();

    let error = manager.install_release("runtime-3").unwrap_err();
    assert!(error.starts_with(MANAGED_PREFLIGHT_ERROR_PREFIX));
    assert!(error.contains("changed outside the shell owner"));
    assert!(fs::read_dir(&manager.inner.slots_root)
        .unwrap()
        .next()
        .is_none());
}

#[test]
fn activation_commit_revalidates_receipts_after_cutover_preparation() {
    let temp = TempDir::new().unwrap();
    let (pair, key) = key_pair();
    let manager = managed_manager(&temp, vec![key]);
    create_package(&manager, &pair, "runtime-4", 4, b"runtime four");
    write_managed_receipt(&manager, "runtime-4");
    manager.install_release("runtime-4").unwrap();
    let transition = manager.acquire_transition().unwrap();
    let verified = manager
        .prepare_activation(&transition, "runtime-4")
        .unwrap();
    fs::create_dir(
        manager
            .inner
            .root
            .join("import-receipts")
            .join(".import-lock"),
    )
    .unwrap();
    let committed = serde_json::json!({
        "outcome": "committed",
        "candidateReleaseId": "runtime-4",
        "failureReason": null,
    });

    let error = manager
        .commit_activation(&transition, &verified, &committed)
        .unwrap_err();
    assert!(error.starts_with(MANAGED_PREFLIGHT_ERROR_PREFIX));
    assert_eq!(manager.status().active_release_id, None);
}

#[test]
fn managed_preflight_failures_do_not_persist_last_failure() {
    let temp = TempDir::new().unwrap();
    let manager = managed_manager(&temp, Vec::new());
    let code = manager.record_failure(format!(
        "Runtime cutover rolled back after {MANAGED_PREFLIGHT_ERROR_PREFIX}receipt chain drifted"
    ));
    assert!(code.starts_with("RUNTIME_CANDIDATE_OPERATION_FAILED:"));
    assert_eq!(manager.status().last_failure, None);
    assert!(!manager.inner.state_path.exists());
}

#[test]
fn installs_and_reverifies_a_signed_runtime_candidate() {
    let temp = TempDir::new().unwrap();
    let (pair, key) = key_pair();
    let manager = manager(&temp, vec![key]);
    create_package(&manager, &pair, "runtime-2", 2, b"runtime host bundle");

    let receipt = manager.install_release("runtime-2").unwrap();
    assert_eq!(receipt.release_id, "runtime-2");
    assert!(!receipt.idempotent);
    assert_eq!(manager.status().installed_release_ids, vec!["runtime-2"]);
    let verified = manager.verified_release("runtime-2").unwrap();
    assert_eq!(verified.release_id(), "runtime-2");
    assert_eq!(verified.release_sequence(), 2);
    assert!(verified.slot_root().ends_with("runtime-2"));
    assert!(is_lower_sha256(verified.runtime_script_sha256()));

    let idempotent = manager.install_release("runtime-2").unwrap();
    assert!(idempotent.idempotent);
    let committed = serde_json::json!({
        "outcome": "committed",
        "candidateReleaseId": "runtime-2",
        "failureReason": null,
    });
    let transition = manager.acquire_transition().unwrap();
    let activation = manager
        .commit_activation(&transition, &verified, &committed)
        .unwrap();
    assert_eq!(activation.release_id, "runtime-2");
    assert_eq!(activation.release_sequence, 2);
    assert_eq!(activation.outcome, "activated");
    assert!(is_lower_sha256(&activation.receipt_id));
    assert_eq!(
        manager.status().active_release_id.as_deref(),
        Some("runtime-2")
    );
    let active = manager
        .active_verified_release(&transition)
        .unwrap()
        .unwrap();
    assert_eq!(active.release_id(), "runtime-2");
    assert_eq!(active.release_sequence(), 2);
}

#[test]
fn recovers_a_valid_backup_when_primary_state_is_corrupt() {
    let temp = TempDir::new().unwrap();
    let (pair, key) = key_pair();
    let manager = manager(&temp, vec![key]);
    create_package(&manager, &pair, "runtime-3", 3, b"runtime host bundle");
    manager.install_release("runtime-3").unwrap();
    let verified = manager.verified_release("runtime-3").unwrap();
    let committed = serde_json::json!({
        "outcome": "committed",
        "candidateReleaseId": "runtime-3",
        "failureReason": null,
    });
    let transition = manager.acquire_transition().unwrap();
    manager
        .commit_activation(&transition, &verified, &committed)
        .unwrap();

    let state_path = manager.inner.state_path.clone();
    let backup = state_path.with_extension("json.backup");
    fs::copy(&state_path, &backup).unwrap();
    fs::write(&state_path, b"").unwrap();

    let recovered = load_state(&state_path).unwrap();
    assert_eq!(recovered.active_release_id.as_deref(), Some("runtime-3"));
    assert_eq!(recovered.installed.len(), 1);
    assert!(!backup.exists());
    assert!(read_state_file(&state_path).is_ok());
    assert!(fs::read_dir(state_path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with(".state.json.")
            && entry.file_name().to_string_lossy().ends_with(".invalid")));
}

#[test]
fn valid_primary_state_wins_when_a_stale_backup_cannot_be_removed() {
    let temp = TempDir::new().unwrap();
    let (pair, key) = key_pair();
    let manager = manager(&temp, vec![key]);
    create_package(&manager, &pair, "runtime-4", 4, b"runtime four");
    manager.install_release("runtime-4").unwrap();

    let state_path = manager.inner.state_path.clone();
    let backup = state_path.with_extension("json.backup");
    fs::create_dir(&backup).unwrap();

    let recovered = load_state(&state_path).unwrap();
    assert_eq!(recovered.installed.len(), 1);
    assert_eq!(recovered.installed[0].release_id, "runtime-4");
    assert!(backup.is_dir());
}

#[test]
fn rejects_a_filesystem_volume_root_as_the_update_root() {
    let temp = TempDir::new().unwrap();
    let volume_root = temp.path().ancestors().last().unwrap().to_path_buf();
    let error = RuntimeCandidateUpdateManager::from_parts(
        volume_root,
        Vec::new(),
        "1.0.0".into(),
        CURRENT_RUNTIME_PROTOCOL_VERSION,
    )
    .err()
    .expect("a filesystem root must fail closed");
    assert!(error.contains("may not be a filesystem volume root"));
}

#[test]
fn quarantines_stale_staging_slots_before_inventory_validation() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("runtime-updates");
    let stale = root.join("slots").join(".stage-runtime-1-interrupted");
    fs::create_dir_all(&stale).unwrap();
    fs::write(stale.join(RUNTIME_HOST_FILE), b"partial runtime").unwrap();

    let manager = RuntimeCandidateUpdateManager::from_parts(
        root.clone(),
        Vec::new(),
        "1.0.0".into(),
        CURRENT_RUNTIME_PROTOCOL_VERSION,
    )
    .unwrap();

    assert!(fs::read_dir(&manager.inner.slots_root)
        .unwrap()
        .next()
        .is_none());
    let quarantined = fs::read_dir(root.join(QUARANTINE_DIRECTORY))
        .unwrap()
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    assert_eq!(quarantined.len(), 1);
    assert!(quarantined[0]
        .file_name()
        .to_string_lossy()
        .starts_with("stale-stage-"));
    assert!(quarantined[0].path().join(RUNTIME_HOST_FILE).is_file());
}

#[test]
fn rejects_a_slot_inventory_that_is_not_backed_by_state() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("runtime-updates");
    fs::create_dir_all(root.join("slots").join("orphan-release")).unwrap();
    let error = RuntimeCandidateUpdateManager::from_parts(
        root,
        Vec::new(),
        "1.0.0".into(),
        CURRENT_RUNTIME_PROTOCOL_VERSION,
    )
    .err()
    .expect("orphaned slot must fail closed");
    assert!(error.contains("slot inventory does not match trusted state"));
}

#[test]
fn rejects_bad_signatures_downgrades_and_extra_files() {
    let temp = TempDir::new().unwrap();
    let (pair, key) = key_pair();
    let manager = manager(&temp, vec![key]);
    create_package(&manager, &pair, "runtime-5", 5, b"five");
    manager.install_release("runtime-5").unwrap();

    create_package(&manager, &pair, "runtime-4", 4, b"four");
    assert!(manager
        .install_release("runtime-4")
        .unwrap_err()
        .contains("advance monotonically"));

    create_package(&manager, &pair, "runtime-6", 6, b"six");
    fs::write(
        manager.inner.inbox_root.join("runtime-6").join("extra.txt"),
        b"unexpected",
    )
    .unwrap();
    assert!(manager
        .install_release("runtime-6")
        .unwrap_err()
        .contains("only envelope.json"));

    let envelope_path = manager
        .inner
        .inbox_root
        .join("runtime-4")
        .join(ENVELOPE_FILE);
    let mut envelope: RuntimeCandidateEnvelope =
        serde_json::from_slice(&fs::read(&envelope_path).unwrap()).unwrap();
    envelope.signature = URL_SAFE_NO_PAD.encode([0_u8; 64]);
    fs::write(envelope_path, canonical_json(&envelope).unwrap()).unwrap();
    let error = validate_package(
        &manager.inner.inbox_root.join("runtime-4"),
        "runtime-4",
        &manager.inner.trusted_keys,
        &manager.inner.shell_version,
        manager.inner.runtime_protocol_version,
    )
    .unwrap_err();
    assert!(error.contains("signature"));
}

#[test]
fn detects_slot_tampering_before_activation() {
    let temp = TempDir::new().unwrap();
    let (pair, key) = key_pair();
    let manager = manager(&temp, vec![key]);
    create_package(&manager, &pair, "runtime-9", 9, b"trusted runtime");
    manager.install_release("runtime-9").unwrap();
    fs::write(
        manager
            .inner
            .slots_root
            .join("runtime-9")
            .join(RUNTIME_HOST_FILE),
        b"tampered runtime",
    )
    .unwrap();
    assert!(manager.verified_release("runtime-9").is_err());
    assert_eq!(manager.status().active_release_id, None);
}

#[test]
fn activation_rejects_a_transition_guard_from_another_manager() {
    let first_temp = TempDir::new().unwrap();
    let second_temp = TempDir::new().unwrap();
    let (pair, key) = key_pair();
    let first = manager(&first_temp, vec![key.clone()]);
    let second = manager(&second_temp, vec![key]);
    create_package(&second, &pair, "runtime-guarded", 8, b"guarded runtime");
    second.install_release("runtime-guarded").unwrap();

    let wrong_guard = first.acquire_transition().unwrap();
    let error = second
        .prepare_activation(&wrong_guard, "runtime-guarded")
        .unwrap_err();
    assert!(error.contains("does not belong to this manager"));
}

#[test]
fn transition_guard_serializes_install_and_activation() {
    let temp = TempDir::new().unwrap();
    let manager = manager(&temp, Vec::new());
    let first = manager.acquire_transition().unwrap();
    assert!(manager.status().busy);
    assert!(manager.acquire_transition().is_err());
    drop(first);
    assert!(!manager.status().busy);
    assert!(manager.acquire_transition().is_ok());
}

#[test]
fn startup_recovery_clears_active_authority_without_deleting_the_slot() {
    let temp = TempDir::new().unwrap();
    let (pair, key) = key_pair();
    let manager = manager(&temp, vec![key]);
    create_package(&manager, &pair, "runtime-11", 11, b"runtime eleven");
    manager.install_release("runtime-11").unwrap();
    let verified = manager.verified_release("runtime-11").unwrap();
    let committed = serde_json::json!({
        "outcome": "committed",
        "candidateReleaseId": "runtime-11",
        "failureReason": null,
    });
    let transition = manager.acquire_transition().unwrap();
    manager
        .commit_activation(&transition, &verified, &committed)
        .unwrap();

    drop(transition);
    let code = manager
        .recover_to_built_in(r"candidate startup failed at C:\secret\runtime-host.cjs")
        .unwrap();
    let status = manager.status();
    assert!(code.starts_with("RUNTIME_CANDIDATE_STARTUP_RECOVERY:"));
    assert_eq!(status.active_release_id, None);
    assert_eq!(status.installed_release_ids, vec!["runtime-11"]);
    assert_eq!(status.last_failure.as_deref(), Some(code.as_str()));
    let transition = manager.acquire_transition().unwrap();
    assert!(manager
        .active_verified_release(&transition)
        .unwrap()
        .is_none());
    assert!(!code.contains("secret"));
}

#[test]
fn rolled_back_cutover_does_not_mark_the_candidate_active() {
    let temp = TempDir::new().unwrap();
    let (pair, key) = key_pair();
    let manager = manager(&temp, vec![key]);
    create_package(&manager, &pair, "runtime-12", 12, b"runtime twelve");
    manager.install_release("runtime-12").unwrap();
    let verified = manager.verified_release("runtime-12").unwrap();
    let rolled_back = serde_json::json!({
        "outcome": "rolled-back",
        "candidateReleaseId": "runtime-12",
        "failureReason": "candidate canary failed",
    });

    let transition = manager.acquire_transition().unwrap();
    assert!(manager
        .commit_activation(&transition, &verified, &rolled_back)
        .unwrap_err()
        .contains("did not commit"));
    assert_eq!(manager.status().active_release_id, None);
}

#[test]
fn validates_only_a_committed_matching_cutover_receipt() {
    let committed = serde_json::json!({
        "outcome": "committed",
        "candidateReleaseId": "runtime-12",
        "failureReason": null,
        "checkpointId": "internal-checkpoint",
    });
    assert!(validate_committed_cutover_receipt(&committed, "runtime-12",).is_ok());
    for invalid in [
        serde_json::json!({
            "outcome": "rolled-back",
            "candidateReleaseId": "runtime-12",
            "failureReason": "candidate failed",
        }),
        serde_json::json!({
            "outcome": "committed",
            "candidateReleaseId": "runtime-11",
            "failureReason": null,
        }),
        serde_json::json!({
            "outcome": "committed",
            "candidateReleaseId": "runtime-12",
            "failureReason": "cleanup failed",
        }),
    ] {
        assert!(validate_committed_cutover_receipt(&invalid, "runtime-12",).is_err());
    }
}

#[test]
fn public_status_contains_no_paths_hashes_keys_or_signatures() {
    let temp = TempDir::new().unwrap();
    let manager = manager(&temp, Vec::new());
    manager.record_failure(format!(
        "failure at {} with secret token",
        temp.path().display(),
    ));
    let status = manager.status();
    assert!(!status.enabled);
    let public = serde_json::to_string(&status).unwrap();
    assert!(status
        .last_failure
        .as_deref()
        .is_some_and(|failure| failure.starts_with("RUNTIME_CANDIDATE_OPERATION_FAILED:")));
    for forbidden in [
        temp.path().to_string_lossy().as_ref(),
        "secret token",
        "sha256",
        "signature",
        "publicKey",
        "keyId",
        "slotRoot",
    ] {
        assert!(
            !public.contains(forbidden),
            "unexpected public field: {forbidden}"
        );
    }
}

#[test]
fn parses_canonical_ed25519_public_key_pem() {
    use ring::signature::KeyPair as _;
    let (pair, _) = key_pair();
    let mut der = ED25519_SPKI_PREFIX.to_vec();
    der.extend_from_slice(pair.public_key().as_ref());
    let encoded = STANDARD.encode(der);
    let pem = format!(
        "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
        encoded
    );
    assert_eq!(
        parse_public_key_pem(&pem).unwrap(),
        pair.public_key().as_ref()
    );
    assert!(parse_public_key_pem("not pem").is_err());
}
