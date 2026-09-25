use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    env,
    fs::{self, File, Metadata, OpenOptions},
    io::{BufReader, BufWriter, ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

#[path = "runtime_managed_preflight.rs"]
mod runtime_managed_preflight;

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ring::signature;
use runtime_managed_preflight::{audit_managed_receipts, ManagedReceiptIdentity};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const UPDATE_STATUS_SCHEMA_VERSION: &str = "scr.runtime-candidate-update-status/v1";
const UPDATE_STATE_SCHEMA_VERSION: &str = "scr.runtime-candidate-update-state/v1";
const UPDATE_RECEIPT_SCHEMA_VERSION: &str = "scr.runtime-candidate-install-receipt/v1";
const UPDATE_ACTIVATION_RECEIPT_SCHEMA_VERSION: &str =
    "scr.runtime-candidate-activation-receipt/v1";
const RELEASE_ENVELOPE_SCHEMA_VERSION: &str = "scr.runtime-candidate-release-signature/v1";
const RELEASE_MANIFEST_SCHEMA_VERSION: &str = "scr.runtime-candidate-manifest/v1";
const TRUSTED_KEYS_SCHEMA_VERSION: &str = "scr.runtime-candidate-trusted-keys/v1";
const SIGNATURE_PAYLOAD_SCHEMA_VERSION: &str = "scr.runtime-candidate-signature/v1";
const ENVELOPE_FILE: &str = "envelope.json";
const RUNTIME_HOST_FILE: &str = "runtime-host.cjs";
const STATE_FILE: &str = "state.json";
const QUARANTINE_DIRECTORY: &str = "quarantine";
const TRUST_RESOURCE: &str = "runtime-candidate-trusted-keys.json";
const MAX_ENVELOPE_BYTES: u64 = 512 * 1024;
const MAX_TRUST_REGISTRY_BYTES: u64 = 256 * 1024;
const MAX_STATE_BYTES: u64 = 512 * 1024;
const MAX_RUNTIME_HOST_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TRUSTED_KEYS: usize = 64;
const MAX_INSTALLED_RELEASES: usize = 128;
const CURRENT_RUNTIME_PROTOCOL_VERSION: u64 = 1;
const COMMITTED_CUTOVER_OUTCOME: &str = "committed";
const MANAGED_PREFLIGHT_ERROR_PREFIX: &str = "RUNTIME_MANAGED_PREFLIGHT:";

pub(crate) fn is_managed_preflight_failure(error: &str) -> bool {
    error.contains(MANAGED_PREFLIGHT_ERROR_PREFIX)
}
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeCandidateComponent {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeCandidateManifest {
    schema_version: String,
    release_id: String,
    release_sequence: u64,
    created_at_unix_ms: u64,
    minimum_shell_version: String,
    runtime_protocol_version: u64,
    component: RuntimeCandidateComponent,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeCandidateEnvelope {
    schema_version: String,
    algorithm: String,
    key_id: String,
    manifest_sha256: String,
    manifest: RuntimeCandidateManifest,
    signature: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedRuntimeKeyRegistry {
    schema_version: String,
    keys: Vec<TrustedRuntimeKeyDocument>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedRuntimeKeyDocument {
    key_id: String,
    public_key_pem: String,
    minimum_release_sequence: u64,
    maximum_release_sequence: Option<u64>,
}

#[derive(Clone, Debug)]
struct ParsedTrustedRuntimeKey {
    key_id: String,
    public_key: [u8; 32],
    minimum_release_sequence: u64,
    maximum_release_sequence: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstalledRuntimeCandidate {
    release_id: String,
    release_sequence: u64,
    signing_key_id: String,
    manifest_sha256: String,
    runtime_host_sha256: String,
    runtime_host_size: u64,
    installed_at_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeCandidateState {
    schema_version: String,
    highest_release_sequence: u64,
    active_release_id: Option<String>,
    installed: Vec<InstalledRuntimeCandidate>,
    last_failure: Option<String>,
}

impl Default for RuntimeCandidateState {
    fn default() -> Self {
        Self {
            schema_version: UPDATE_STATE_SCHEMA_VERSION.into(),
            highest_release_sequence: 0,
            active_release_id: None,
            installed: Vec::new(),
            last_failure: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeCandidateUpdateStatus {
    schema_version: &'static str,
    enabled: bool,
    busy: bool,
    trusted_key_count: usize,
    highest_release_sequence: u64,
    active_release_id: Option<String>,
    installed_release_ids: Vec<String>,
    inbox_release_ids: Vec<String>,
    last_failure: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeCandidateInstallReceipt {
    schema_version: &'static str,
    receipt_id: String,
    release_id: String,
    release_sequence: u64,
    runtime_host_bytes: u64,
    installed_at_unix_ms: u64,
    idempotent: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeCandidateActivationReceipt {
    schema_version: &'static str,
    receipt_id: String,
    release_id: String,
    release_sequence: u64,
    outcome: &'static str,
    activated_at_unix_ms: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct VerifiedRuntimeCandidate {
    release_id: String,
    release_sequence: u64,
    slot_root: PathBuf,
    runtime_script_sha256: String,
}

impl VerifiedRuntimeCandidate {
    pub(crate) fn release_id(&self) -> &str {
        &self.release_id
    }

    pub(crate) fn release_sequence(&self) -> u64 {
        self.release_sequence
    }

    pub(crate) fn slot_root(&self) -> &Path {
        &self.slot_root
    }

    pub(crate) fn runtime_script_sha256(&self) -> &str {
        &self.runtime_script_sha256
    }
}

#[derive(Clone, Debug)]
struct VerifiedEnvelope {
    envelope: RuntimeCandidateEnvelope,
    canonical_envelope: Vec<u8>,
}

struct ManagedPreflightSnapshot {
    state: RuntimeCandidateState,
    target_inbox: Option<VerifiedEnvelope>,
    target_slot: Option<VerifiedEnvelope>,
}

struct RuntimeCandidateUpdateInner {
    root: PathBuf,
    inbox_root: PathBuf,
    slots_root: PathBuf,
    quarantine_root: PathBuf,
    state_path: PathBuf,
    trusted_keys: Vec<ParsedTrustedRuntimeKey>,
    shell_version: String,
    runtime_protocol_version: u64,
    require_managed_preflight: bool,
    state: Mutex<RuntimeCandidateState>,
    transition: AtomicBool,
}

#[derive(Clone)]
pub(crate) struct RuntimeCandidateUpdateManager {
    inner: Arc<RuntimeCandidateUpdateInner>,
}

#[must_use]
pub(crate) struct RuntimeCandidateTransitionGuard<'a> {
    transition: &'a AtomicBool,
}

impl Drop for RuntimeCandidateTransitionGuard<'_> {
    fn drop(&mut self) {
        self.transition.store(false, AtomicOrdering::Release);
    }
}

pub(crate) fn validate_committed_cutover_receipt<T: Serialize>(
    receipt: &T,
    expected_release_id: &str,
) -> Result<(), String> {
    validate_release_id(expected_release_id)?;
    let value = serde_json::to_value(receipt)
        .map_err(|error| format!("Could not inspect Runtime cutover receipt: {error}"))?;
    let outcome = value
        .get("outcome")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let active_release = value
        .get("candidateReleaseId")
        .or_else(|| value.get("candidate_release_id"))
        .and_then(Value::as_str);
    let failure_reason = value
        .get("failureReason")
        .or_else(|| value.get("failure_reason"));
    if outcome != COMMITTED_CUTOVER_OUTCOME
        || active_release != Some(expected_release_id)
        || failure_reason.is_some_and(|reason| !reason.is_null())
    {
        return Err("Runtime candidate cutover did not commit the requested release.".into());
    }
    Ok(())
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn random_suffix() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Could not generate Runtime candidate nonce: {error}"))?;
    Ok(hex::encode(bytes))
}

fn bounded_error(value: impl Into<String>) -> String {
    value
        .into()
        .replace(['\0', '\r', '\n'], " ")
        .chars()
        .take(1_024)
        .collect()
}

fn is_valid_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    value.len() <= 256
        && first.is_ascii_alphanumeric()
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
}

fn validate_release_id(value: &str) -> Result<(), String> {
    if !is_valid_identifier(value) {
        return Err("Runtime candidate release ID must be a bounded portable identifier.".into());
    }
    Ok(())
}

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_bytes(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn hash_file(path: &Path, maximum_bytes: u64) -> Result<(u64, String), String> {
    let metadata = direct_regular_file(path, maximum_bytes)?;
    let mut reader = BufReader::new(
        File::open(path)
            .map_err(|error| format!("Could not open Runtime candidate component: {error}"))?,
    );
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes_read = 0_u64;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not read Runtime candidate component: {error}"))?;
        if count == 0 {
            break;
        }
        bytes_read = bytes_read
            .checked_add(count as u64)
            .ok_or_else(|| "Runtime candidate component size overflowed.".to_string())?;
        if bytes_read > maximum_bytes || bytes_read > metadata.len() {
            return Err("Runtime candidate component changed while hashing.".into());
        }
        hash.update(&buffer[..count]);
    }
    if bytes_read != metadata.len() {
        return Err("Runtime candidate component size changed while hashing.".into());
    }
    Ok((bytes_read, format!("{:x}", hash.finalize())))
}

fn read_bounded_file(path: &Path, maximum_bytes: u64) -> Result<Vec<u8>, String> {
    let metadata = direct_regular_file(path, maximum_bytes)?;
    let capacity: usize = metadata
        .len()
        .try_into()
        .map_err(|_| "Bounded file size does not fit memory limits.".to_string())?;
    let mut bytes = Vec::with_capacity(capacity);
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|error| format!("Could not read bounded Runtime candidate file: {error}"))?;
    if bytes.len() as u64 != metadata.len() || bytes.len() as u64 > maximum_bytes {
        return Err("Bounded Runtime candidate file changed while reading.".into());
    }
    Ok(bytes)
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &Metadata) -> bool {
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn direct_file(path: &Path) -> Result<Metadata, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Runtime candidate file is unavailable: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("Runtime candidate component must be a direct regular file.".into());
    }
    if metadata_is_reparse(&metadata) {
        return Err("Runtime candidate component may not be a reparse point.".into());
    }
    Ok(metadata)
}

fn direct_regular_file(path: &Path, maximum_bytes: u64) -> Result<Metadata, String> {
    let metadata = direct_file(path)?;
    if metadata.len() == 0 || metadata.len() > maximum_bytes {
        return Err("Runtime candidate component is outside its size bound.".into());
    }
    Ok(metadata)
}

fn direct_directory(path: &Path) -> Result<Metadata, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Runtime candidate directory is unavailable: {error}"))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err("Runtime candidate directory must be a direct directory.".into());
    }
    if metadata_is_reparse(&metadata) {
        return Err("Runtime candidate directory may not be a reparse point.".into());
    }
    Ok(metadata)
}

fn ensure_contained(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("Could not canonicalize Runtime update root: {error}"))?;
    let canonical_candidate = fs::canonicalize(candidate)
        .map_err(|error| format!("Could not canonicalize Runtime candidate path: {error}"))?;
    if canonical_candidate == canonical_root || canonical_candidate.starts_with(&canonical_root) {
        return Ok(canonical_candidate);
    }
    Err("Runtime candidate path escapes the managed update root.".into())
}

fn strict_release_inventory(release_root: &Path) -> Result<(), String> {
    direct_directory(release_root)?;
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(release_root)
        .map_err(|error| format!("Could not enumerate Runtime candidate package: {error}"))?
    {
        let entry = entry.map_err(|error| {
            format!("Could not inspect Runtime candidate package entry: {error}")
        })?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Runtime candidate package entry name is not UTF-8.".to_string())?;
        names.insert(name);
    }
    let expected = BTreeSet::from([ENVELOPE_FILE.to_string(), RUNTIME_HOST_FILE.to_string()]);
    if names != expected {
        return Err(
            "Runtime candidate package must contain only envelope.json and runtime-host.cjs."
                .into(),
        );
    }
    Ok(())
}

fn canonical_json_value(value: &Value, output: &mut Vec<u8>) -> Result<(), String> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(value) => output.extend_from_slice(if *value { b"true" } else { b"false" }),
        Value::Number(value) => output.extend_from_slice(value.to_string().as_bytes()),
        Value::String(value) => output.extend_from_slice(
            serde_json::to_string(value)
                .map_err(|error| format!("Could not canonicalize JSON string: {error}"))?
                .as_bytes(),
        ),
        Value::Array(values) => {
            output.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                canonical_json_value(value, output)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            output.push(b'{');
            let ordered = values.iter().collect::<BTreeMap<_, _>>();
            for (index, (key, value)) in ordered.into_iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                output.extend_from_slice(
                    serde_json::to_string(key)
                        .map_err(|error| format!("Could not canonicalize JSON key: {error}"))?
                        .as_bytes(),
                );
                output.push(b':');
                canonical_json_value(value, output)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let value = serde_json::to_value(value)
        .map_err(|error| format!("Could not convert Runtime candidate JSON: {error}"))?;
    let mut output = Vec::new();
    canonical_json_value(&value, &mut output)?;
    Ok(output)
}

fn parse_public_key_pem(value: &str) -> Result<[u8; 32], String> {
    const BEGIN: &str = "-----BEGIN PUBLIC KEY-----";
    const END: &str = "-----END PUBLIC KEY-----";
    let normalized = value.replace("\r\n", "\n");
    let mut lines = normalized.lines();
    if lines.next() != Some(BEGIN) {
        return Err("Runtime candidate trusted key is not a public-key PEM.".into());
    }
    let mut encoded = String::new();
    let mut found_end = false;
    for line in lines.by_ref() {
        if line == END {
            found_end = true;
            break;
        }
        if line.is_empty()
            || line.len() > 64
            || !line
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        {
            return Err("Runtime candidate trusted key PEM is not canonical.".into());
        }
        encoded.push_str(line);
    }
    if !found_end || lines.any(|line| !line.is_empty()) {
        return Err("Runtime candidate trusted key PEM has trailing content.".into());
    }
    let der = STANDARD
        .decode(encoded.as_bytes())
        .map_err(|_| "Runtime candidate trusted key PEM is invalid base64.".to_string())?;
    if der.len() != ED25519_SPKI_PREFIX.len() + 32
        || der[..ED25519_SPKI_PREFIX.len()] != ED25519_SPKI_PREFIX
    {
        return Err("Runtime candidate trusted key is not canonical Ed25519 SPKI.".into());
    }
    let mut public_key = [0_u8; 32];
    public_key.copy_from_slice(&der[ED25519_SPKI_PREFIX.len()..]);
    Ok(public_key)
}

fn parse_version(value: &str) -> Result<Vec<u64>, String> {
    if value.is_empty()
        || value.len() > 64
        || value.contains(['-', '+'])
        || value.starts_with('.')
        || value.ends_with('.')
    {
        return Err("Runtime candidate version must be a stable numeric version.".into());
    }
    let parts = value
        .split('.')
        .map(|part| {
            if part.is_empty()
                || part.len() > 10
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
            {
                return Err("Runtime candidate version component is invalid.".to_string());
            }
            part.parse::<u64>()
                .map_err(|_| "Runtime candidate version component overflowed.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if parts.len() > 4 {
        return Err("Runtime candidate version has too many components.".into());
    }
    Ok(parts)
}

fn compare_versions(left: &str, right: &str) -> Result<Ordering, String> {
    let mut left = parse_version(left)?;
    let mut right = parse_version(right)?;
    let length = left.len().max(right.len());
    left.resize(length, 0);
    right.resize(length, 0);
    Ok(left.cmp(&right))
}

fn signature_payload(manifest_sha256: &str) -> Vec<u8> {
    format!("{SIGNATURE_PAYLOAD_SCHEMA_VERSION}\n{manifest_sha256}").into_bytes()
}

fn load_trusted_keys(path: &Path) -> Result<Vec<ParsedTrustedRuntimeKey>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = read_bounded_file(path, MAX_TRUST_REGISTRY_BYTES)?;
    let registry: TrustedRuntimeKeyRegistry = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Runtime candidate trusted key registry is invalid: {error}"))?;
    if registry.schema_version != TRUSTED_KEYS_SCHEMA_VERSION {
        return Err("Runtime candidate trusted key registry schema is unsupported.".into());
    }
    if registry.keys.len() > MAX_TRUSTED_KEYS {
        return Err("Runtime candidate trusted key registry is too large.".into());
    }
    let mut seen = BTreeSet::new();
    let mut parsed = Vec::with_capacity(registry.keys.len());
    for key in registry.keys {
        if !is_valid_identifier(&key.key_id) || !seen.insert(key.key_id.clone()) {
            return Err("Runtime candidate trusted key ID is invalid or duplicated.".into());
        }
        if key
            .maximum_release_sequence
            .is_some_and(|maximum| maximum < key.minimum_release_sequence)
        {
            return Err("Runtime candidate trusted key sequence bounds are invalid.".into());
        }
        parsed.push(ParsedTrustedRuntimeKey {
            key_id: key.key_id,
            public_key: parse_public_key_pem(&key.public_key_pem)?,
            minimum_release_sequence: key.minimum_release_sequence,
            maximum_release_sequence: key.maximum_release_sequence,
        });
    }
    Ok(parsed)
}

fn validate_manifest(
    manifest: &RuntimeCandidateManifest,
    shell_version: &str,
    runtime_protocol_version: u64,
) -> Result<(), String> {
    if manifest.schema_version != RELEASE_MANIFEST_SCHEMA_VERSION {
        return Err("Runtime candidate manifest schema is unsupported.".into());
    }
    validate_release_id(&manifest.release_id)?;
    if manifest.release_sequence == 0 || manifest.created_at_unix_ms == 0 {
        return Err("Runtime candidate manifest sequence or timestamp is invalid.".into());
    }
    if compare_versions(shell_version, &manifest.minimum_shell_version)? == Ordering::Less {
        return Err("Runtime candidate requires a newer signed shell.".into());
    }
    if manifest.runtime_protocol_version != runtime_protocol_version {
        return Err("Runtime candidate control protocol is incompatible.".into());
    }
    if manifest.component.path != RUNTIME_HOST_FILE
        || manifest.component.size == 0
        || manifest.component.size > MAX_RUNTIME_HOST_BYTES
        || !is_lower_sha256(&manifest.component.sha256)
    {
        return Err("Runtime candidate component declaration is invalid.".into());
    }
    Ok(())
}

fn verify_envelope(
    bytes: &[u8],
    trusted_keys: &[ParsedTrustedRuntimeKey],
    shell_version: &str,
    runtime_protocol_version: u64,
) -> Result<VerifiedEnvelope, String> {
    let envelope: RuntimeCandidateEnvelope = serde_json::from_slice(bytes)
        .map_err(|error| format!("Runtime candidate envelope is invalid: {error}"))?;
    if envelope.schema_version != RELEASE_ENVELOPE_SCHEMA_VERSION
        || envelope.algorithm != "ed25519"
        || !is_valid_identifier(&envelope.key_id)
        || !is_lower_sha256(&envelope.manifest_sha256)
    {
        return Err("Runtime candidate envelope metadata is invalid.".into());
    }
    validate_manifest(&envelope.manifest, shell_version, runtime_protocol_version)?;
    let manifest_sha256 = sha256_bytes(&canonical_json(&envelope.manifest)?);
    if manifest_sha256 != envelope.manifest_sha256 {
        return Err("Runtime candidate manifest digest does not match the envelope.".into());
    }
    let key = trusted_keys
        .iter()
        .find(|key| key.key_id == envelope.key_id)
        .ok_or_else(|| "Runtime candidate signing key is not trusted.".to_string())?;
    if envelope.manifest.release_sequence < key.minimum_release_sequence
        || key
            .maximum_release_sequence
            .is_some_and(|maximum| envelope.manifest.release_sequence > maximum)
    {
        return Err("Runtime candidate release sequence is outside the key trust window.".into());
    }
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(envelope.signature.as_bytes())
        .map_err(|_| "Runtime candidate signature is not canonical base64url.".to_string())?;
    if signature_bytes.len() != 64 || URL_SAFE_NO_PAD.encode(&signature_bytes) != envelope.signature
    {
        return Err("Runtime candidate signature encoding is invalid.".into());
    }
    signature::UnparsedPublicKey::new(&signature::ED25519, key.public_key)
        .verify(
            &signature_payload(&envelope.manifest_sha256),
            &signature_bytes,
        )
        .map_err(|_| "Runtime candidate Ed25519 signature is invalid.".to_string())?;
    let canonical_envelope = canonical_json(&envelope)?;
    Ok(VerifiedEnvelope {
        envelope,
        canonical_envelope,
    })
}

fn validate_package(
    release_root: &Path,
    expected_release_id: &str,
    trusted_keys: &[ParsedTrustedRuntimeKey],
    shell_version: &str,
    runtime_protocol_version: u64,
) -> Result<VerifiedEnvelope, String> {
    strict_release_inventory(release_root)?;
    let envelope = verify_envelope(
        &read_bounded_file(&release_root.join(ENVELOPE_FILE), MAX_ENVELOPE_BYTES)?,
        trusted_keys,
        shell_version,
        runtime_protocol_version,
    )?;
    if envelope.envelope.manifest.release_id != expected_release_id {
        return Err("Runtime candidate package release ID does not match its directory.".into());
    }
    let runtime_path = release_root.join(RUNTIME_HOST_FILE);
    let (size, digest) = hash_file(&runtime_path, MAX_RUNTIME_HOST_BYTES)?;
    if size != envelope.envelope.manifest.component.size
        || digest != envelope.envelope.manifest.component.sha256
    {
        return Err("Runtime candidate component size or SHA-256 does not match.".into());
    }
    Ok(envelope)
}

fn validate_state(state: RuntimeCandidateState) -> Result<RuntimeCandidateState, String> {
    if state.schema_version != UPDATE_STATE_SCHEMA_VERSION
        || state.installed.len() > MAX_INSTALLED_RELEASES
    {
        return Err("Runtime candidate state schema or size is invalid.".into());
    }
    let mut release_ids = BTreeSet::new();
    let mut previous_sequence = 0;
    for release in &state.installed {
        validate_release_id(&release.release_id)?;
        if !release_ids.insert(release.release_id.clone())
            || release.release_sequence == 0
            || release.release_sequence <= previous_sequence
            || !is_valid_identifier(&release.signing_key_id)
            || !is_lower_sha256(&release.manifest_sha256)
            || !is_lower_sha256(&release.runtime_host_sha256)
            || release.runtime_host_size == 0
            || release.runtime_host_size > MAX_RUNTIME_HOST_BYTES
            || release.installed_at_unix_ms == 0
        {
            return Err("Runtime candidate state entry is invalid.".into());
        }
        previous_sequence = release.release_sequence;
    }
    if state.highest_release_sequence < previous_sequence {
        return Err("Runtime candidate state sequence regressed.".into());
    }
    if state
        .active_release_id
        .as_ref()
        .is_some_and(|active| !release_ids.contains(active))
    {
        return Err("Runtime candidate active release is not installed.".into());
    }
    Ok(state)
}

fn read_state_file(path: &Path) -> Result<RuntimeCandidateState, String> {
    let state: RuntimeCandidateState =
        serde_json::from_slice(&read_bounded_file(path, MAX_STATE_BYTES)?)
            .map_err(|error| format!("Runtime candidate state is invalid: {error}"))?;
    validate_state(state)
}

fn recover_state_file(state_path: &Path) -> Result<Option<RuntimeCandidateState>, String> {
    let backup = state_path.with_extension("json.backup");
    match (state_path.exists(), backup.exists()) {
        (false, false) => Ok(None),
        (true, false) => read_state_file(state_path).map(Some),
        (false, true) => {
            let recovered = read_state_file(&backup)?;
            fs::rename(&backup, state_path)
                .map_err(|error| format!("Could not recover Runtime candidate state: {error}"))?;
            Ok(Some(recovered))
        }
        (true, true) => match read_state_file(state_path) {
            Ok(state) => {
                // The primary record is already authoritative. A stale backup cleanup
                // failure must not turn a valid durable state into a startup failure.
                let _ = fs::remove_file(&backup);
                Ok(Some(state))
            }
            Err(primary_error) => {
                let recovered = read_state_file(&backup).map_err(|backup_error| {
                    format!(
                        "Runtime candidate state and backup are invalid: primary={primary_error}; backup={backup_error}"
                    )
                })?;
                direct_file(state_path)?;
                let parent = state_path
                    .parent()
                    .ok_or_else(|| "Runtime candidate state path has no parent.".to_string())?;
                let quarantined =
                    parent.join(format!(".{STATE_FILE}.{}.invalid", random_suffix()?));
                fs::rename(state_path, &quarantined).map_err(|error| {
                    format!("Could not quarantine invalid Runtime candidate state: {error}")
                })?;
                if let Err(error) = fs::rename(&backup, state_path) {
                    let _ = fs::rename(&quarantined, state_path);
                    return Err(format!(
                        "Could not restore valid Runtime candidate state backup: {error}"
                    ));
                }
                Ok(Some(recovered))
            }
        },
    }
}

fn load_state(state_path: &Path) -> Result<RuntimeCandidateState, String> {
    Ok(recover_state_file(state_path)?.unwrap_or_default())
}

fn write_state(state_path: &Path, state: &RuntimeCandidateState) -> Result<(), String> {
    let parent = state_path
        .parent()
        .ok_or_else(|| "Runtime candidate state path has no parent.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Runtime candidate state directory: {error}"))?;
    direct_directory(parent)?;
    let bytes = canonical_json(state)?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("Runtime candidate state exceeds its size bound.".into());
    }
    let suffix = random_suffix()?;
    let temporary = parent.join(format!(".{STATE_FILE}.{suffix}.tmp"));
    let backup = state_path.with_extension("json.backup");
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| {
                format!("Could not create Runtime candidate state temp file: {error}")
            })?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not persist Runtime candidate state: {error}"))?;
        drop(file);
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| {
                format!("Could not remove previous Runtime candidate state backup: {error}")
            })?;
        }
        if state_path.exists() {
            fs::rename(state_path, &backup).map_err(|error| {
                format!("Could not stage previous Runtime candidate state: {error}")
            })?;
        }
        if let Err(error) = fs::rename(&temporary, state_path) {
            if backup.exists() {
                let _ = fs::rename(&backup, state_path);
            }
            return Err(format!(
                "Could not publish Runtime candidate state: {error}"
            ));
        }
        if backup.exists() {
            // Publication completed when the new primary was atomically renamed into
            // place. Backup cleanup is maintenance, not part of the commit outcome.
            let _ = fs::remove_file(&backup);
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn copy_direct_file(source: &Path, destination: &Path, maximum_bytes: u64) -> Result<(), String> {
    let metadata = direct_regular_file(source, maximum_bytes)?;
    let mut reader = BufReader::new(
        File::open(source)
            .map_err(|error| format!("Could not open Runtime candidate source file: {error}"))?,
    );
    let mut writer = BufWriter::new(
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .map_err(|error| format!("Could not create Runtime candidate slot file: {error}"))?,
    );
    let copied = std::io::copy(&mut reader, &mut writer)
        .map_err(|error| format!("Could not copy Runtime candidate slot file: {error}"))?;
    writer
        .flush()
        .and_then(|_| writer.get_ref().sync_all())
        .map_err(|error| format!("Could not persist Runtime candidate slot file: {error}"))?;
    if copied != metadata.len() {
        return Err("Runtime candidate source changed while copying.".into());
    }
    Ok(())
}

fn list_release_directories(root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut releases = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !is_valid_identifier(&name) {
                return None;
            }
            let metadata = fs::symlink_metadata(entry.path()).ok()?;
            if !metadata.file_type().is_dir()
                || metadata.file_type().is_symlink()
                || metadata_is_reparse(&metadata)
            {
                return None;
            }
            Some(name)
        })
        .collect::<Vec<_>>();
    releases.sort();
    releases
}

fn quarantine_managed_directory(
    managed_root: &Path,
    source: &Path,
    quarantine_root: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    direct_directory(source)?;
    direct_directory(quarantine_root)?;
    let source = ensure_contained(managed_root, source)?;
    let quarantine_root = ensure_contained(managed_root, quarantine_root)?;
    if source == managed_root || source == quarantine_root {
        return Err("Runtime candidate quarantine target is unsafe.".into());
    }
    let bounded_label = label
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(64)
        .collect::<String>();
    let bounded_label = if bounded_label.is_empty() {
        "entry".to_string()
    } else {
        bounded_label
    };
    let destination = quarantine_root.join(format!("{bounded_label}-{}", random_suffix()?));
    if destination.exists() {
        return Err("Runtime candidate quarantine destination already exists.".into());
    }
    fs::rename(&source, &destination)
        .map_err(|error| format!("Could not quarantine Runtime candidate directory: {error}"))?;
    Ok(destination)
}

fn quarantine_stale_staging_slots(
    managed_root: &Path,
    slots_root: &Path,
    quarantine_root: &Path,
) -> Result<(), String> {
    direct_directory(slots_root)?;
    for entry in fs::read_dir(slots_root)
        .map_err(|error| format!("Could not enumerate Runtime candidate slots: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not inspect Runtime candidate slot: {error}"))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Runtime candidate slot name is not Unicode.".to_string())?;
        if name.starts_with(".stage-") {
            quarantine_managed_directory(
                managed_root,
                &entry.path(),
                quarantine_root,
                "stale-stage",
            )?;
        }
    }
    Ok(())
}

fn candidate_matches_receipt(
    expected_release_id: &str,
    candidate: &VerifiedEnvelope,
    receipt: &ManagedReceiptIdentity,
) -> bool {
    let manifest = &candidate.envelope.manifest;
    manifest.release_id == expected_release_id
        && manifest.release_sequence == receipt.release_sequence()
        && candidate.envelope.key_id == receipt.signing_key_id()
        && sha256_bytes(&candidate.canonical_envelope) == receipt.envelope_sha256()
        && manifest.component.sha256 == receipt.runtime_host_sha256()
}

fn candidate_matches_installed(
    candidate: &VerifiedEnvelope,
    installed: &InstalledRuntimeCandidate,
) -> bool {
    candidate.envelope.manifest_sha256 == installed.manifest_sha256
        && candidate.envelope.manifest.release_sequence == installed.release_sequence
        && candidate.envelope.manifest.component.sha256 == installed.runtime_host_sha256
        && candidate.envelope.manifest.component.size == installed.runtime_host_size
        && candidate.envelope.key_id == installed.signing_key_id
}

fn candidate_identities_match(left: &VerifiedEnvelope, right: &VerifiedEnvelope) -> bool {
    left.envelope.manifest_sha256 == right.envelope.manifest_sha256
        && left.envelope.manifest.release_sequence == right.envelope.manifest.release_sequence
        && left.envelope.manifest.component.sha256 == right.envelope.manifest.component.sha256
        && left.envelope.manifest.component.size == right.envelope.manifest.component.size
        && left.envelope.key_id == right.envelope.key_id
        && sha256_bytes(&left.canonical_envelope) == sha256_bytes(&right.canonical_envelope)
}

fn read_state_for_preflight(state_path: &Path) -> Result<RuntimeCandidateState, String> {
    match fs::symlink_metadata(state_path) {
        Ok(_) => read_state_file(state_path),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let backup = state_path.with_extension("json.backup");
            match fs::symlink_metadata(&backup) {
                Ok(_) => {
                    Err("Runtime candidate primary state is missing while a backup exists.".into())
                }
                Err(backup_error) if backup_error.kind() == ErrorKind::NotFound => {
                    Ok(RuntimeCandidateState::default())
                }
                Err(backup_error) => Err(format!(
                    "Could not inspect Runtime candidate state backup: {backup_error}"
                )),
            }
        }
        Err(error) => Err(format!(
            "Could not inspect Runtime candidate durable state: {error}"
        )),
    }
}

fn managed_preflight_error(error: impl Into<String>) -> String {
    let error = error.into();
    if error.starts_with(MANAGED_PREFLIGHT_ERROR_PREFIX) {
        error
    } else {
        format!("{MANAGED_PREFLIGHT_ERROR_PREFIX}{error}")
    }
}

fn validate_slot_inventory(slots_root: &Path, state: &RuntimeCandidateState) -> Result<(), String> {
    direct_directory(slots_root)?;
    let expected = state
        .installed
        .iter()
        .map(|release| release.release_id.clone())
        .collect::<BTreeSet<_>>();
    let mut actual = BTreeSet::new();
    for entry in fs::read_dir(slots_root)
        .map_err(|error| format!("Could not enumerate Runtime candidate slots: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not inspect Runtime candidate slot: {error}"))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Runtime candidate slot name is not Unicode.".to_string())?;
        validate_release_id(&name).map_err(|_| {
            "Runtime candidate slot inventory contains an invalid entry.".to_string()
        })?;
        direct_directory(&entry.path())?;
        actual.insert(name);
    }
    if actual != expected {
        return Err("Runtime candidate slot inventory does not match trusted state.".into());
    }
    Ok(())
}

impl RuntimeCandidateUpdateManager {
    pub(crate) fn acquire_transition(&self) -> Result<RuntimeCandidateTransitionGuard<'_>, String> {
        self.inner
            .transition
            .compare_exchange(false, true, AtomicOrdering::AcqRel, AtomicOrdering::Acquire)
            .map_err(|_| "Another Runtime candidate operation is already active.".to_string())?;
        Ok(RuntimeCandidateTransitionGuard {
            transition: &self.inner.transition,
        })
    }

    fn assert_transition_guard(
        &self,
        guard: &RuntimeCandidateTransitionGuard<'_>,
    ) -> Result<(), String> {
        if !std::ptr::eq(guard.transition, &self.inner.transition)
            || !guard.transition.load(AtomicOrdering::Acquire)
        {
            return Err(
                "Runtime candidate transition guard does not belong to this manager.".into(),
            );
        }
        Ok(())
    }

    pub(crate) fn new(app: &AppHandle) -> Result<Self, String> {
        let root = match env::var_os("SCR_RUNTIME_CANDIDATE_UPDATE_ROOT") {
            Some(value) => PathBuf::from(value),
            None => app
                .path()
                .app_data_dir()
                .map_err(|error| format!("Could not resolve app data directory: {error}"))?
                .join("runtime-updates"),
        };
        let trusted_keys_path = match env::var_os("SCR_RUNTIME_CANDIDATE_TRUSTED_KEYS_PATH") {
            Some(value) => PathBuf::from(value),
            None => app
                .path()
                .resource_dir()
                .map_err(|error| format!("Could not resolve resource directory: {error}"))?
                .join(TRUST_RESOURCE),
        };
        Self::from_parts_with_policy(
            root,
            load_trusted_keys(&trusted_keys_path)?,
            env!("CARGO_PKG_VERSION").to_string(),
            CURRENT_RUNTIME_PROTOCOL_VERSION,
            true,
        )
    }

    #[cfg(test)]
    fn from_parts(
        root: PathBuf,
        trusted_keys: Vec<ParsedTrustedRuntimeKey>,
        shell_version: String,
        runtime_protocol_version: u64,
    ) -> Result<Self, String> {
        Self::from_parts_with_policy(
            root,
            trusted_keys,
            shell_version,
            runtime_protocol_version,
            false,
        )
    }

    fn from_parts_with_policy(
        root: PathBuf,
        trusted_keys: Vec<ParsedTrustedRuntimeKey>,
        shell_version: String,
        runtime_protocol_version: u64,
        require_managed_preflight: bool,
    ) -> Result<Self, String> {
        if root.as_os_str().is_empty() || runtime_protocol_version == 0 {
            return Err("Runtime candidate manager configuration is invalid.".into());
        }
        parse_version(&shell_version)?;
        fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create Runtime update root: {error}"))?;
        direct_directory(&root)?;
        let root = fs::canonicalize(&root)
            .map_err(|error| format!("Could not canonicalize Runtime update root: {error}"))?;
        if root.parent().is_none() {
            return Err(
                "Runtime candidate update root may not be a filesystem volume root.".into(),
            );
        }
        let inbox_root = root.join("inbox");
        let slots_root = root.join("slots");
        let quarantine_root = root.join(QUARANTINE_DIRECTORY);
        fs::create_dir_all(&inbox_root)
            .and_then(|_| fs::create_dir_all(&slots_root))
            .and_then(|_| fs::create_dir_all(&quarantine_root))
            .map_err(|error| format!("Could not create Runtime update directories: {error}"))?;
        direct_directory(&inbox_root)?;
        direct_directory(&slots_root)?;
        direct_directory(&quarantine_root)?;
        quarantine_stale_staging_slots(&root, &slots_root, &quarantine_root)?;
        let state_path = root.join(STATE_FILE);
        let state = load_state(&state_path)?;
        validate_slot_inventory(&slots_root, &state)?;
        Ok(Self {
            inner: Arc::new(RuntimeCandidateUpdateInner {
                root,
                inbox_root,
                slots_root,
                quarantine_root,
                state_path,
                trusted_keys,
                shell_version,
                runtime_protocol_version,
                require_managed_preflight,
                state: Mutex::new(state),
                transition: AtomicBool::new(false),
            }),
        })
    }

    pub(crate) fn is_enabled(&self) -> bool {
        !self.inner.trusted_keys.is_empty()
    }

    pub(crate) fn active_verified_release(
        &self,
        transition: &RuntimeCandidateTransitionGuard<'_>,
    ) -> Result<Option<VerifiedRuntimeCandidate>, String> {
        self.assert_transition_guard(transition)?;
        let active_release_id = {
            let state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.active_release_id.clone()
        };
        let Some(release_id) = active_release_id else {
            return Ok(None);
        };
        let snapshot = self
            .preflight_snapshot(&release_id)
            .map_err(managed_preflight_error)?;
        if snapshot.state.active_release_id.as_deref() != Some(release_id.as_str()) {
            return Err(managed_preflight_error(
                "Runtime candidate active authority changed during startup restore.",
            ));
        }
        self.verified_from_snapshot(&release_id, &snapshot)
            .map(Some)
            .map_err(managed_preflight_error)
    }

    pub(crate) fn status(&self) -> RuntimeCandidateUpdateStatus {
        let busy = self.inner.transition.load(AtomicOrdering::Acquire);
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let mut installed_release_ids = state
            .installed
            .iter()
            .map(|release| release.release_id.clone())
            .collect::<Vec<_>>();
        installed_release_ids.sort();
        RuntimeCandidateUpdateStatus {
            schema_version: UPDATE_STATUS_SCHEMA_VERSION,
            enabled: self.is_enabled(),
            busy,
            trusted_key_count: self.inner.trusted_keys.len(),
            highest_release_sequence: state.highest_release_sequence,
            active_release_id: state.active_release_id,
            installed_release_ids,
            inbox_release_ids: list_release_directories(&self.inner.inbox_root),
            last_failure: state.last_failure,
        }
    }

    fn preflight_snapshot(&self, release_id: &str) -> Result<ManagedPreflightSnapshot, String> {
        validate_release_id(release_id)?;
        let state = read_state_for_preflight(&self.inner.state_path)?;
        let memory_state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if state != memory_state {
            return Err("Runtime candidate durable state changed outside the shell owner.".into());
        }
        validate_slot_inventory(&self.inner.slots_root, &state)?;

        let receipt_audit = self
            .inner
            .require_managed_preflight
            .then(|| audit_managed_receipts(&self.inner.root, &self.inner.inbox_root))
            .transpose()?;
        if receipt_audit
            .as_ref()
            .is_some_and(|audit| !audit.releases.is_empty())
            && self.inner.trusted_keys.is_empty()
        {
            return Err("No trusted Runtime candidate signing keys are provisioned.".into());
        }

        let mut target_inbox = None;
        if let Some(audit) = receipt_audit.as_ref() {
            for (id, receipt) in &audit.releases {
                let candidate = validate_package(
                    &self.inner.inbox_root.join(id),
                    id,
                    &self.inner.trusted_keys,
                    &self.inner.shell_version,
                    self.inner.runtime_protocol_version,
                )?;
                if !candidate_matches_receipt(id, &candidate, receipt) {
                    return Err(
                        "Runtime candidate inbox package no longer matches its import receipt."
                            .into(),
                    );
                }
                if let Some(installed) = state
                    .installed
                    .iter()
                    .find(|installed| installed.release_id == *id)
                {
                    if !candidate_matches_installed(&candidate, installed) {
                        return Err(
                            "Runtime candidate inbox and installed state identities disagree."
                                .into(),
                        );
                    }
                }
                if id == release_id {
                    target_inbox = Some(candidate);
                }
            }
        } else {
            let target = self.inner.inbox_root.join(release_id);
            match fs::symlink_metadata(&target) {
                Ok(_) => {
                    target_inbox = Some(validate_package(
                        &target,
                        release_id,
                        &self.inner.trusted_keys,
                        &self.inner.shell_version,
                        self.inner.runtime_protocol_version,
                    )?);
                }
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Could not inspect Runtime candidate inbox target: {error}"
                    ));
                }
            }
        }

        let mut target_slot = None;
        for installed in &state.installed {
            let candidate = validate_package(
                &self.inner.slots_root.join(&installed.release_id),
                &installed.release_id,
                &self.inner.trusted_keys,
                &self.inner.shell_version,
                self.inner.runtime_protocol_version,
            )?;
            if !candidate_matches_installed(&candidate, installed) {
                return Err(
                    "Runtime candidate slot no longer matches trusted installed state.".into(),
                );
            }
            if let Some(audit) = receipt_audit.as_ref() {
                let receipt = audit.releases.get(&installed.release_id).ok_or_else(|| {
                    "Installed Runtime candidate has no release-index receipt.".to_string()
                })?;
                if !candidate_matches_receipt(&installed.release_id, &candidate, receipt) {
                    return Err(
                        "Runtime candidate slot no longer matches its import receipt.".into(),
                    );
                }
            }
            if installed.release_id == release_id {
                target_slot = Some(candidate);
            }
        }

        Ok(ManagedPreflightSnapshot {
            state,
            target_inbox,
            target_slot,
        })
    }

    fn verified_from_snapshot(
        &self,
        release_id: &str,
        snapshot: &ManagedPreflightSnapshot,
    ) -> Result<VerifiedRuntimeCandidate, String> {
        if snapshot.target_slot.is_none() {
            return Err("Runtime candidate release is not installed.".into());
        }
        let installed = snapshot
            .state
            .installed
            .iter()
            .find(|installed| installed.release_id == release_id)
            .ok_or_else(|| "Runtime candidate release is not installed.".to_string())?;
        Ok(VerifiedRuntimeCandidate {
            release_id: release_id.into(),
            release_sequence: installed.release_sequence,
            slot_root: self.inner.slots_root.join(release_id),
            runtime_script_sha256: installed.runtime_host_sha256.clone(),
        })
    }

    fn preflight_install(
        &self,
        release_id: &str,
    ) -> Result<(RuntimeCandidateState, VerifiedEnvelope), String> {
        let snapshot = self
            .preflight_snapshot(release_id)
            .map_err(managed_preflight_error)?;
        let candidate = snapshot.target_inbox.ok_or_else(|| {
            managed_preflight_error(
                "Runtime candidate release is absent from the receipted managed inbox.",
            )
        })?;
        Ok((snapshot.state, candidate))
    }

    fn assert_install_precommit(
        &self,
        release_id: &str,
        expected_state: &RuntimeCandidateState,
        staged: &VerifiedEnvelope,
    ) -> Result<(), String> {
        let snapshot = self
            .preflight_snapshot(release_id)
            .map_err(managed_preflight_error)?;
        if &snapshot.state != expected_state {
            return Err(managed_preflight_error(
                "Runtime candidate durable state changed during installation.",
            ));
        }
        let inbox = snapshot.target_inbox.ok_or_else(|| {
            managed_preflight_error(
                "Runtime candidate release disappeared from the receipted managed inbox.",
            )
        })?;
        if !candidate_identities_match(&inbox, staged) {
            return Err(managed_preflight_error(
                "Runtime candidate staged identity changed before publication.",
            ));
        }
        Ok(())
    }

    pub(crate) fn prepare_activation(
        &self,
        transition: &RuntimeCandidateTransitionGuard<'_>,
        release_id: &str,
    ) -> Result<VerifiedRuntimeCandidate, String> {
        self.assert_transition_guard(transition)?;
        if self.inner.trusted_keys.is_empty() {
            return Err("No trusted Runtime candidate signing keys are provisioned.".into());
        }
        let snapshot = self
            .preflight_snapshot(release_id)
            .map_err(managed_preflight_error)?;
        if snapshot.state.active_release_id.as_deref() == Some(release_id) {
            return Err(managed_preflight_error(
                "Runtime candidate release is already active.",
            ));
        }
        self.verified_from_snapshot(release_id, &snapshot)
            .map_err(managed_preflight_error)
    }

    pub(crate) fn install_release(
        &self,
        release_id: &str,
    ) -> Result<RuntimeCandidateInstallReceipt, String> {
        validate_release_id(release_id)?;
        let _transition = self.acquire_transition()?;
        if self.inner.trusted_keys.is_empty() {
            return Err("No trusted Runtime candidate signing keys are provisioned.".into());
        }
        let (preflight_state, verified) = self.preflight_install(release_id)?;
        let manifest = &verified.envelope.manifest;
        if let Some(existing) = preflight_state
            .installed
            .iter()
            .find(|installed| installed.release_id == release_id)
            .cloned()
        {
            if !candidate_matches_installed(&verified, &existing) {
                return Err(managed_preflight_error(
                    "Installed Runtime candidate release ID has different content.",
                ));
            }
            return Ok(RuntimeCandidateInstallReceipt {
                schema_version: UPDATE_RECEIPT_SCHEMA_VERSION,
                receipt_id: random_suffix()?,
                release_id: release_id.into(),
                release_sequence: existing.release_sequence,
                runtime_host_bytes: existing.runtime_host_size,
                installed_at_unix_ms: existing.installed_at_unix_ms,
                idempotent: true,
            });
        }
        if manifest.release_sequence <= preflight_state.highest_release_sequence {
            return Err(
                "Runtime candidate release sequence does not advance monotonically.".into(),
            );
        }
        if preflight_state.installed.len() >= MAX_INSTALLED_RELEASES {
            return Err("Runtime candidate installed-release limit has been reached.".into());
        }

        let receipt_id = random_suffix()?;
        let previous_state = preflight_state;
        let final_slot = self.inner.slots_root.join(release_id);
        if final_slot.exists() {
            return Err("Runtime candidate slot exists without matching trusted state.".into());
        }
        let staging = self
            .inner
            .quarantine_root
            .join(format!(".stage-{release_id}-{}", random_suffix()?));
        fs::create_dir(&staging)
            .map_err(|error| format!("Could not create Runtime candidate staging slot: {error}"))?;
        let install_result = (|| {
            copy_direct_file(
                &self
                    .inner
                    .inbox_root
                    .join(release_id)
                    .join(RUNTIME_HOST_FILE),
                &staging.join(RUNTIME_HOST_FILE),
                MAX_RUNTIME_HOST_BYTES,
            )?;
            let mut envelope_file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(staging.join(ENVELOPE_FILE))
                .map_err(|error| format!("Could not create Runtime candidate envelope: {error}"))?;
            envelope_file
                .write_all(&verified.canonical_envelope)
                .and_then(|_| envelope_file.sync_all())
                .map_err(|error| {
                    format!("Could not persist Runtime candidate envelope: {error}")
                })?;
            drop(envelope_file);
            let staged = validate_package(
                &staging,
                release_id,
                &self.inner.trusted_keys,
                &self.inner.shell_version,
                self.inner.runtime_protocol_version,
            )?;
            self.assert_install_precommit(release_id, &previous_state, &staged)?;

            let installed_at_unix_ms = now_unix_ms();
            let mut next_state = previous_state.clone();
            next_state.installed.push(InstalledRuntimeCandidate {
                release_id: release_id.into(),
                release_sequence: manifest.release_sequence,
                signing_key_id: verified.envelope.key_id.clone(),
                manifest_sha256: verified.envelope.manifest_sha256.clone(),
                runtime_host_sha256: manifest.component.sha256.clone(),
                runtime_host_size: manifest.component.size,
                installed_at_unix_ms,
            });
            next_state
                .installed
                .sort_by_key(|release| release.release_sequence);
            next_state.highest_release_sequence = manifest.release_sequence;
            next_state.last_failure = None;

            let mut state_guard = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *state_guard != previous_state {
                return Err(managed_preflight_error(
                    "Runtime candidate in-memory state changed during installation.",
                ));
            }
            fs::rename(&staging, &final_slot)
                .map_err(|error| format!("Could not publish Runtime candidate slot: {error}"))?;
            if let Err(error) = write_state(&self.inner.state_path, &next_state) {
                let cleanup = quarantine_managed_directory(
                    &self.inner.root,
                    &final_slot,
                    &self.inner.quarantine_root,
                    "uncommitted-slot",
                );
                return Err(match cleanup {
                    Ok(_) => error,
                    Err(cleanup_error) => format!(
                        "{error}; could not quarantine the uncommitted Runtime candidate slot: {cleanup_error}"
                    ),
                });
            }
            *state_guard = next_state;
            Ok(RuntimeCandidateInstallReceipt {
                schema_version: UPDATE_RECEIPT_SCHEMA_VERSION,
                receipt_id,
                release_id: release_id.into(),
                release_sequence: manifest.release_sequence,
                runtime_host_bytes: manifest.component.size,
                installed_at_unix_ms,
                idempotent: false,
            })
        })();
        match install_result {
            Ok(receipt) => Ok(receipt),
            Err(error) => {
                if staging.exists() {
                    if let Err(cleanup_error) = quarantine_managed_directory(
                        &self.inner.root,
                        &staging,
                        &self.inner.quarantine_root,
                        "failed-stage",
                    ) {
                        return Err(format!(
                            "{error}; could not quarantine the failed Runtime candidate stage: {cleanup_error}"
                        ));
                    }
                }
                Err(error)
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn verified_release(
        &self,
        release_id: &str,
    ) -> Result<VerifiedRuntimeCandidate, String> {
        let snapshot = self
            .preflight_snapshot(release_id)
            .map_err(managed_preflight_error)?;
        self.verified_from_snapshot(release_id, &snapshot)
            .map_err(managed_preflight_error)
    }

    pub(crate) fn commit_activation<T: Serialize>(
        &self,
        transition: &RuntimeCandidateTransitionGuard<'_>,
        verified: &VerifiedRuntimeCandidate,
        cutover_receipt: &T,
    ) -> Result<RuntimeCandidateActivationReceipt, String> {
        self.assert_transition_guard(transition)?;
        validate_committed_cutover_receipt(cutover_receipt, verified.release_id())?;
        let snapshot = self
            .preflight_snapshot(verified.release_id())
            .map_err(managed_preflight_error)?;
        let observed = self
            .verified_from_snapshot(verified.release_id(), &snapshot)
            .map_err(managed_preflight_error)?;
        if observed.release_sequence != verified.release_sequence
            || observed.slot_root != verified.slot_root
            || observed.runtime_script_sha256 != verified.runtime_script_sha256
        {
            return Err(managed_preflight_error(
                "Runtime candidate activation identity changed during cutover.",
            ));
        }

        let activated_at_unix_ms = now_unix_ms();
        let cutover_bytes = serde_json::to_vec(cutover_receipt)
            .map_err(|error| format!("Could not serialize Runtime cutover receipt: {error}"))?;
        let receipt_material = format!(
            "{UPDATE_ACTIVATION_RECEIPT_SCHEMA_VERSION}\n{}\n{}\n{activated_at_unix_ms}\n{}",
            verified.release_id(),
            verified.release_sequence(),
            sha256_bytes(&cutover_bytes),
        );
        let receipt_id = sha256_bytes(receipt_material.as_bytes());
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *state != snapshot.state {
            return Err(managed_preflight_error(
                "Runtime candidate state changed during activation cutover.",
            ));
        }
        let previous = state.clone();
        state.active_release_id = Some(verified.release_id().into());
        state.last_failure = None;
        if let Err(error) = write_state(&self.inner.state_path, &state) {
            *state = previous;
            return Err(error);
        }
        Ok(RuntimeCandidateActivationReceipt {
            schema_version: UPDATE_ACTIVATION_RECEIPT_SCHEMA_VERSION,
            receipt_id,
            release_id: verified.release_id().into(),
            release_sequence: verified.release_sequence(),
            outcome: "activated",
            activated_at_unix_ms,
        })
    }

    pub(crate) fn recover_to_built_in(&self, error: impl Into<String>) -> Result<String, String> {
        let bounded = bounded_error(error);
        let code = format!(
            "RUNTIME_CANDIDATE_STARTUP_RECOVERY:{}",
            &sha256_bytes(bounded.as_bytes())[..16],
        );
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = state.clone();
        state.active_release_id = None;
        state.last_failure = Some(code.clone());
        if let Err(error) = write_state(&self.inner.state_path, &state) {
            *state = previous;
            return Err(error);
        }
        Ok(code)
    }

    pub(crate) fn record_failure(&self, error: impl Into<String>) -> String {
        let bounded = bounded_error(error);
        let code = format!(
            "RUNTIME_CANDIDATE_OPERATION_FAILED:{}",
            &sha256_bytes(bounded.as_bytes())[..16],
        );
        if !is_managed_preflight_failure(&bounded) {
            let mut state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.last_failure = Some(code.clone());
            let _ = write_state(&self.inner.state_path, &state);
        }
        code
    }
}

#[cfg(test)]
#[path = "runtime_candidate_update/tests.rs"]
mod tests;
