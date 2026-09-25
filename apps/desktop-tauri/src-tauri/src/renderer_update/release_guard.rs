use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

use serde::{de::DeserializeOwned, Deserialize, Deserializer};
use serde_json::Value;
use time::{format_description::well_known::Rfc3339, OffsetDateTime, UtcOffset};

use super::{
    ensure_directory_shape, is_lower_sha256, is_valid_identifier, now_unix_ms,
    reject_reparse_point, reject_shared_file, RendererReleaseRef, RendererStateRevision,
    MAX_SAFE_JSON_INTEGER,
};

const ACTIVATION_LEASE_SCHEMA: &str = "scr.renderer-activation-lease/v1";
const RELEASE_PROVENANCE_SCHEMA: &str = "scr.renderer-release-provenance/v1";
const MAX_COORDINATION_RECORD_BYTES: usize = 32 * 1024;
const MIN_LEASE_TTL_MS: u64 = 60 * 1_000;
const MAX_LEASE_TTL_MS: u64 = 24 * 60 * 60 * 1_000;

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererActivationLeasePolicy {
    allow_shell_restart: bool,
    require_committed_snapshot: bool,
    require_monotonic_sequence: bool,
    require_origin_task: bool,
    quarantine_older_candidates: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererActivationLease {
    schema_version: String,
    lease_id: String,
    status: String,
    owner_principal: String,
    origin_task_id: String,
    target_release_id: String,
    target_release_sequence: u64,
    source_commit: String,
    manifest_sha256: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    previous_active_release_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    previous_active_sequence: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_option")]
    shell_pid: Option<u64>,
    acquired_at: String,
    expires_at: String,
    #[serde(default, rename = "completedAt")]
    _completed_at: Option<String>,
    #[serde(default, rename = "result")]
    _result: Option<Value>,
    policy: RendererActivationLeasePolicy,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererReleaseProvenance {
    schema_version: String,
    release_id: String,
    release_sequence: u64,
    version: String,
    channel: String,
    source_commit: String,
    origin_task_id: String,
    owner_principal: String,
    manifest_sha256: String,
    candidate_directory: String,
    staged_at: String,
    lease_id: String,
}

fn read_record<T: DeserializeOwned>(path: &Path, label: &str) -> Result<T, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect {label}: {error}"))?;
    if !metadata.file_type().is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_COORDINATION_RECORD_BYTES as u64
    {
        return Err(format!(
            "{label} is missing, empty, or exceeds its size limit."
        ));
    }
    reject_reparse_point(&metadata, label)?;
    let mut file = File::open(path).map_err(|error| format!("Could not open {label}: {error}"))?;
    reject_shared_file(&file, label)?;
    let before = file
        .metadata()
        .map_err(|error| format!("Could not inspect opened {label}: {error}"))?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take((MAX_COORDINATION_RECORD_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {label}: {error}"))?;
    let after = file
        .metadata()
        .map_err(|error| format!("Could not re-check opened {label}: {error}"))?;
    if bytes.len() > MAX_COORDINATION_RECORD_BYTES
        || before.len() != after.len()
        || bytes.len() as u64 != before.len()
    {
        return Err(format!("{label} changed while it was being read."));
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("{label} is invalid JSON: {error}"))
}

fn safe_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 192 {
        return false;
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn full_source_commit(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_timestamp_ms(value: &str, label: &str) -> Result<u64, String> {
    if value.is_empty()
        || value.len() > 64
        || !value.ends_with('Z')
        || value.contains(['\r', '\n', '\0'])
    {
        return Err(format!("{label} is not a bounded UTC RFC 3339 timestamp."));
    }
    let parsed = OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| format!("{label} is not a real RFC 3339 timestamp."))?;
    if parsed.offset() != UtcOffset::UTC || parsed.unix_timestamp_nanos() < 0 {
        return Err(format!("{label} must use a non-negative UTC timestamp."));
    }
    u64::try_from(parsed.unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| format!("{label} exceeds the supported timestamp range."))
}

fn validate_lease_identity(lease: &RendererActivationLease) -> Result<(), String> {
    if lease.schema_version != ACTIVATION_LEASE_SCHEMA || lease.status != "held" {
        return Err("Renderer activation lease is not one held v1 lease.".into());
    }
    for (label, value) in [
        ("lease ID", lease.lease_id.as_str()),
        ("owner principal", lease.owner_principal.as_str()),
        ("origin Task ID", lease.origin_task_id.as_str()),
    ] {
        if !safe_id(value) {
            return Err(format!("Renderer activation lease {label} is invalid."));
        }
    }
    if !is_valid_identifier(&lease.target_release_id) {
        return Err("Renderer activation lease target release ID is invalid.".into());
    }
    if lease.target_release_sequence == 0
        || lease.target_release_sequence > MAX_SAFE_JSON_INTEGER
        || !full_source_commit(&lease.source_commit)
        || !is_lower_sha256(&lease.manifest_sha256)
    {
        return Err("Renderer activation lease release identity is invalid.".into());
    }
    Ok(())
}

fn validate_lease_time_and_policy(lease: &RendererActivationLease) -> Result<(), String> {
    let now = now_unix_ms();
    let acquired_at = parse_timestamp_ms(&lease.acquired_at, "Renderer lease acquiredAt")?;
    let expires_at = parse_timestamp_ms(&lease.expires_at, "Renderer lease expiresAt")?;
    let ttl = expires_at
        .checked_sub(acquired_at)
        .ok_or_else(|| "Renderer activation lease expires before it is acquired.".to_string())?;
    if acquired_at > now || expires_at <= now {
        return Err("Renderer activation lease is not currently live.".into());
    }
    if !(MIN_LEASE_TTL_MS..=MAX_LEASE_TTL_MS).contains(&ttl) {
        return Err("Renderer activation lease TTL is outside the reviewed bounds.".into());
    }
    if lease.shell_pid != Some(u64::from(std::process::id())) {
        return Err(
            "Renderer activation lease is not owned by this Sovereign Shell process.".into(),
        );
    }
    if lease.policy.allow_shell_restart
        || !lease.policy.require_committed_snapshot
        || !lease.policy.require_monotonic_sequence
        || !lease.policy.require_origin_task
    {
        return Err("Renderer activation lease policy weakens a required release guard.".into());
    }
    let _ = lease.policy.quarantine_older_candidates;
    Ok(())
}

fn validate_state_baseline(
    lease: &RendererActivationLease,
    release: &RendererReleaseRef,
    revision: &RendererStateRevision,
) -> Result<(), String> {
    if release.release_sequence <= revision.highest_release_sequence {
        return Err("Renderer release is not newer than the durable sequence floor.".into());
    }
    match (
        lease.previous_active_release_id.as_deref(),
        lease.previous_active_sequence,
        revision.active_release.as_ref(),
    ) {
        (None, None, None) => {}
        (Some(expected_id), Some(expected_sequence), Some(active))
            if expected_id == active.release_id && expected_sequence == active.release_sequence => {
        }
        _ => {
            return Err(
                "Renderer activation lease baseline no longer matches the durable active release."
                    .into(),
            )
        }
    }
    Ok(())
}

fn validate_provenance(
    update_root: &Path,
    lease: &RendererActivationLease,
    provenance: &RendererReleaseProvenance,
    release: &RendererReleaseRef,
) -> Result<(), String> {
    if provenance.schema_version != RELEASE_PROVENANCE_SCHEMA {
        return Err("Renderer release provenance is not a v1 record.".into());
    }
    if provenance.release_id != release.release_id
        || provenance.release_sequence != release.release_sequence
        || provenance.version != release.version
        || provenance.channel != release.channel
        || provenance.manifest_sha256 != release.manifest_sha256
        || provenance.source_commit != lease.source_commit
        || provenance.origin_task_id != lease.origin_task_id
        || provenance.owner_principal != lease.owner_principal
        || provenance.lease_id != lease.lease_id
        || provenance.staged_at != lease.acquired_at
    {
        return Err(
            "Renderer release provenance does not match the held lease and signed candidate."
                .into(),
        );
    }
    if !full_source_commit(&provenance.source_commit)
        || !safe_id(&provenance.origin_task_id)
        || !safe_id(&provenance.owner_principal)
        || !safe_id(&provenance.lease_id)
        || provenance.release_sequence == 0
        || provenance.release_sequence > MAX_SAFE_JSON_INTEGER
        || !is_lower_sha256(&provenance.manifest_sha256)
    {
        return Err("Renderer release provenance contains an invalid identity field.".into());
    }
    parse_timestamp_ms(&provenance.staged_at, "Renderer provenance stagedAt")?;

    let inbox = update_root.join("inbox");
    let expected_candidate = inbox.join(&release.release_id);
    let recorded_candidate = PathBuf::from(&provenance.candidate_directory);
    ensure_directory_shape(&inbox, "Renderer inbox")?;
    ensure_directory_shape(&expected_candidate, "Selected Renderer candidate directory")?;
    ensure_directory_shape(
        &recorded_candidate,
        "Renderer provenance candidate directory",
    )?;
    let canonical_inbox = fs::canonicalize(&inbox)
        .map_err(|error| format!("Could not canonicalize Renderer inbox: {error}"))?;
    let canonical_expected = fs::canonicalize(&expected_candidate)
        .map_err(|error| format!("Could not canonicalize selected Renderer candidate: {error}"))?;
    let canonical_recorded = fs::canonicalize(&recorded_candidate).map_err(|error| {
        format!("Could not canonicalize Renderer provenance candidate: {error}")
    })?;
    if canonical_recorded != canonical_expected
        || canonical_recorded.parent() != Some(canonical_inbox.as_path())
    {
        return Err(
            "Renderer release provenance candidate is not the selected direct inbox release."
                .into(),
        );
    }
    Ok(())
}

pub(super) fn verify_renderer_release_guard(
    update_root: &Path,
    release: &RendererReleaseRef,
    revision: &RendererStateRevision,
) -> Result<(), String> {
    ensure_directory_shape(update_root, "Renderer update storage")?;
    let coordination_root = update_root.join("coordination");
    ensure_directory_shape(
        &coordination_root,
        "Renderer release coordination directory",
    )?;
    let releases_root = coordination_root.join("releases");
    ensure_directory_shape(&releases_root, "Renderer release provenance directory")?;

    let lease: RendererActivationLease = read_record(
        &coordination_root.join("activation-lease.json"),
        "Renderer activation lease",
    )?;
    let provenance: RendererReleaseProvenance = read_record(
        &releases_root.join(format!("{}.json", release.release_id)),
        "Renderer release provenance",
    )?;

    validate_lease_identity(&lease)?;
    validate_lease_time_and_policy(&lease)?;
    if lease.target_release_id != release.release_id
        || lease.target_release_sequence != release.release_sequence
        || lease.manifest_sha256 != release.manifest_sha256
    {
        return Err("Renderer activation lease does not target the signed candidate.".into());
    }
    validate_state_baseline(&lease, release, revision)?;
    validate_provenance(update_root, &lease, &provenance, release)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::{json, Value};
    use tempfile::TempDir;

    use super::*;

    fn timestamp(unix_ms: u64) -> String {
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(unix_ms) * 1_000_000)
            .expect("test timestamp")
            .format(&Rfc3339)
            .expect("format test timestamp")
    }

    fn release() -> RendererReleaseRef {
        RendererReleaseRef {
            release_id: "renderer-guard-0002".into(),
            release_sequence: 2,
            version: "0.1.2".into(),
            channel: "development".into(),
            manifest_sha256: "b".repeat(64),
        }
    }

    fn revision(active: Option<RendererReleaseRef>) -> RendererStateRevision {
        RendererStateRevision {
            schema_version: "scr.renderer-state/v1".into(),
            storage_revision: 7,
            previous_state_sha256: None,
            highest_release_sequence: active
                .as_ref()
                .map_or(0, |release| release.release_sequence),
            active_release: active,
            last_known_good_release: None,
            last_failure: None,
            updated_at_unix_ms: now_unix_ms(),
        }
    }

    fn write_json(path: &Path, value: &Value) {
        fs::create_dir_all(path.parent().expect("record parent")).expect("create record parent");
        fs::write(
            path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(value).expect("serialize record")
            ),
        )
        .expect("write record");
    }

    fn records(
        root: &Path,
        release: &RendererReleaseRef,
        active: Option<&RendererReleaseRef>,
    ) -> (Value, Value) {
        let now = now_unix_ms();
        let acquired_at = timestamp(now.saturating_sub(1_000));
        let lease_id = "renderer-guard-lease-0002";
        let lease = json!({
            "schemaVersion": ACTIVATION_LEASE_SCHEMA,
            "leaseId": lease_id,
            "status": "held",
            "ownerPrincipal": "renderer-release-owner",
            "originTaskId": "task-renderer-release",
            "targetReleaseId": release.release_id,
            "targetReleaseSequence": release.release_sequence,
            "sourceCommit": "a".repeat(40),
            "manifestSha256": release.manifest_sha256,
            "previousActiveReleaseId": active.map(|value| value.release_id.as_str()),
            "previousActiveSequence": active.map(|value| value.release_sequence),
            "shellPid": std::process::id(),
            "acquiredAt": acquired_at,
            "expiresAt": timestamp(now.saturating_add(60_000)),
            "policy": {
                "allowShellRestart": false,
                "requireCommittedSnapshot": true,
                "requireMonotonicSequence": true,
                "requireOriginTask": true,
                "quarantineOlderCandidates": true
            }
        });
        let provenance = json!({
            "schemaVersion": RELEASE_PROVENANCE_SCHEMA,
            "releaseId": release.release_id,
            "releaseSequence": release.release_sequence,
            "version": release.version,
            "channel": release.channel,
            "sourceCommit": "a".repeat(40),
            "originTaskId": "task-renderer-release",
            "ownerPrincipal": "renderer-release-owner",
            "manifestSha256": release.manifest_sha256,
            "candidateDirectory": root.join("inbox").join(&release.release_id),
            "stagedAt": lease["acquiredAt"],
            "leaseId": lease_id
        });
        (lease, provenance)
    }

    fn fixture(
        active: Option<RendererReleaseRef>,
    ) -> (TempDir, RendererReleaseRef, RendererStateRevision) {
        let root = TempDir::new().expect("temporary Renderer root");
        let release = release();
        fs::create_dir_all(root.path().join("inbox").join(&release.release_id))
            .expect("create candidate directory");
        fs::create_dir_all(root.path().join("coordination").join("releases"))
            .expect("create coordination directories");
        let (lease, provenance) = records(root.path(), &release, active.as_ref());
        write_json(
            &root
                .path()
                .join("coordination")
                .join("activation-lease.json"),
            &lease,
        );
        write_json(
            &root
                .path()
                .join("coordination")
                .join("releases")
                .join(format!("{}.json", release.release_id)),
            &provenance,
        );
        let state = revision(active);
        (root, release, state)
    }

    #[test]
    fn accepts_held_guard_for_built_in_and_signed_active_baselines() {
        let (built_in, release, state) = fixture(None);
        verify_renderer_release_guard(built_in.path(), &release, &state)
            .expect("built-in baseline guard");

        let active = RendererReleaseRef {
            release_id: "renderer-active-0001".into(),
            release_sequence: 1,
            version: "0.1.1".into(),
            channel: "development".into(),
            manifest_sha256: "c".repeat(64),
        };
        let (signed, release, state) = fixture(Some(active));
        verify_renderer_release_guard(signed.path(), &release, &state)
            .expect("signed active baseline guard");
    }

    #[test]
    fn rejects_expired_or_other_process_guards() {
        let (root, release, state) = fixture(None);
        let lease_path = root
            .path()
            .join("coordination")
            .join("activation-lease.json");
        let mut lease: Value = serde_json::from_slice(&fs::read(&lease_path).expect("read lease"))
            .expect("parse lease");
        lease["shellPid"] = json!(u64::from(std::process::id()) + 1);
        write_json(&lease_path, &lease);
        assert!(verify_renderer_release_guard(root.path(), &release, &state)
            .expect_err("other process lease must fail")
            .contains("Sovereign Shell"));

        lease["shellPid"] = json!(std::process::id());
        let now = now_unix_ms();
        lease["acquiredAt"] = json!(timestamp(now.saturating_sub(120_000)));
        lease["expiresAt"] = json!(timestamp(now.saturating_sub(60_000)));
        write_json(&lease_path, &lease);
        assert!(verify_renderer_release_guard(root.path(), &release, &state)
            .expect_err("expired lease must fail")
            .contains("not currently live"));
    }

    #[test]
    fn rejects_baseline_and_provenance_drift() {
        let (root, release, mut state) = fixture(None);
        state.active_release = Some(RendererReleaseRef {
            release_id: "renderer-unexpected-0001".into(),
            release_sequence: 1,
            version: "0.1.1".into(),
            channel: "development".into(),
            manifest_sha256: "c".repeat(64),
        });
        state.highest_release_sequence = 1;
        assert!(verify_renderer_release_guard(root.path(), &release, &state)
            .expect_err("baseline drift must fail")
            .contains("baseline"));

        let (root, release, state) = fixture(None);
        let provenance_path = root
            .path()
            .join("coordination")
            .join("releases")
            .join(format!("{}.json", release.release_id));
        let mut provenance: Value =
            serde_json::from_slice(&fs::read(&provenance_path).expect("read provenance"))
                .expect("parse provenance");
        provenance["sourceCommit"] = json!("d".repeat(40));
        write_json(&provenance_path, &provenance);
        assert!(verify_renderer_release_guard(root.path(), &release, &state)
            .expect_err("provenance drift must fail")
            .contains("does not match"));
    }
}
