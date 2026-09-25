use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ring::signature;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tauri::{
    http::{header, Method, Request, Response, StatusCode},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder,
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime, UtcOffset};

#[path = "renderer_update/release_guard.rs"]
mod release_guard;
use release_guard::verify_renderer_release_guard;

const RENDERER_MANIFEST_SCHEMA_VERSION: &str = "scr.renderer-release/v1";
const RENDERER_SIGNATURE_SCHEMA_VERSION: &str = "scr.renderer-release-signature/v1";
const RENDERER_TRUSTED_KEYS_SCHEMA_VERSION: &str = "scr.renderer-trusted-keys/v1";
const RENDERER_READY_SCHEMA_VERSION: &str = "scr.renderer-slot-ready/v1";
const RENDERER_STATE_SCHEMA_VERSION: &str = "scr.renderer-state/v1";
const RENDERER_HANDOFF_SCHEMA_VERSION: &str = "scr.renderer-handoff/v1";
const RENDERER_STATUS_SCHEMA_VERSION: &str = "scr.renderer-update-status/v1";
pub const RENDERER_PROTOCOL_SCHEME: &str = "sovereign-ui";
const RENDERER_WINDOWS_PROTOCOL_HOST: &str = "sovereign-ui.localhost";
const RENDERER_ROOT_DIRECTORY: &str = "renderer-updates";
const RENDERER_METADATA_DIRECTORY: &str = ".scr-renderer";
const RENDERER_ENVELOPE_FILE: &str = "envelope.json";
const RENDERER_READY_FILE: &str = "ready.json";
const RENDERER_BUNDLE_DIRECTORY: &str = "bundle";
const RENDERER_TRUST_RESOURCE: &str = "renderer-trusted-keys.json";
const SHELL_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const RENDERER_BRIDGE_API_VERSION: u64 = 1;

const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_COMPONENTS: usize = 256;
const MAX_COMPONENT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RENDERER_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_ENVELOPE_BYTES: usize = 512 * 1024;
const MAX_TRUST_REGISTRY_BYTES: usize = 256 * 1024;
const MAX_TRUSTED_KEYS: usize = 64;
const MAX_STATE_REVISIONS: usize = 4_096;
const MAX_QUARANTINED_STATE_JOURNALS: usize = 4;
const MAX_STATE_BYTES: usize = 64 * 1024;
const MAX_STATE_JOURNAL_BYTES: usize = 16 * 1024 * 1024;
const MAX_HANDOFF_BYTES: usize = 64 * 1024;
const MAX_INSTALLED_RELEASES: usize = 64;
const MAX_INBOX_RELEASES: usize = 64;
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(20);
const PREFLIGHT_RECEIPT_TTL: Duration = Duration::from_secs(10 * 60);
const ACTIVATION_READY_TIMEOUT: Duration = Duration::from_secs(20);
const FAILURE_PERSIST_INTERVAL: Duration = Duration::from_secs(5);
const CSP_HEADER_VALUE: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";
const ED25519_SPKI_PREFIX: &[u8] = &[
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererReleaseComponent {
    path: String,
    sha256: String,
    bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererReleaseCompatibility {
    minimum_shell_version: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    maximum_shell_version: Option<String>,
    bridge_api_version: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererReleaseManifest {
    schema_version: String,
    release_id: String,
    release_sequence: u64,
    version: String,
    channel: String,
    created_at: String,
    entrypoint: String,
    total_bytes: u64,
    components: Vec<RendererReleaseComponent>,
    compatibility: RendererReleaseCompatibility,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererReleaseEnvelope {
    schema_version: String,
    algorithm: String,
    key_id: String,
    manifest_sha256: String,
    signature: String,
    manifest: RendererReleaseManifest,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedRendererKeyRegistry {
    schema_version: String,
    keys: Vec<TrustedRendererKey>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedRendererKey {
    key_id: String,
    algorithm: String,
    public_key_pem: String,
    minimum_release_sequence: u64,
    #[serde(deserialize_with = "deserialize_required_option")]
    maximum_release_sequence: Option<u64>,
    allowed_channels: Vec<String>,
}

#[derive(Clone, Debug)]
struct ParsedTrustedRendererKey {
    key_id: String,
    public_key: [u8; 32],
    minimum_release_sequence: u64,
    maximum_release_sequence: Option<u64>,
    allowed_channels: HashSet<String>,
}

#[derive(Clone, Debug)]
struct VerifiedRendererEnvelope {
    envelope: RendererReleaseEnvelope,
    manifest_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererReleaseRef {
    release_id: String,
    release_sequence: u64,
    version: String,
    channel: String,
    manifest_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererReadyMarker {
    schema_version: String,
    release: RendererReleaseRef,
    installed_at_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererStateRevision {
    schema_version: String,
    storage_revision: u64,
    #[serde(deserialize_with = "deserialize_required_option")]
    previous_state_sha256: Option<String>,
    highest_release_sequence: u64,
    #[serde(deserialize_with = "deserialize_required_option")]
    active_release: Option<RendererReleaseRef>,
    #[serde(deserialize_with = "deserialize_required_option")]
    last_known_good_release: Option<RendererReleaseRef>,
    #[serde(deserialize_with = "deserialize_required_option")]
    last_failure: Option<String>,
    updated_at_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererHandoff {
    schema_version: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    view: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    settings_tab: Option<String>,
    scroll_top: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererReleaseView {
    release_id: String,
    release_sequence: u64,
    version: String,
    channel: String,
    manifest_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererActivationView {
    release_id: Option<String>,
    built_in: bool,
    phase: String,
    started_at_unix_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererUpdateStatus {
    schema_version: &'static str,
    enabled: bool,
    shell_version: &'static str,
    bridge_api_version: u64,
    trusted_key_count: usize,
    highest_release_sequence: u64,
    active_release: Option<RendererReleaseView>,
    built_in_active: bool,
    last_known_good_release: Option<RendererReleaseView>,
    installed_releases: Vec<RendererReleaseView>,
    inbox_release_ids: Vec<String>,
    preflighted_release_ids: Vec<String>,
    pending_activation: Option<RendererActivationView>,
    last_failure: Option<String>,
}

type RendererPayloadInventory = (Vec<(String, PathBuf)>, HashSet<String>);

#[derive(Clone, Debug)]
struct InstalledRendererRelease {
    release: RendererReleaseRef,
    manifest: RendererReleaseManifest,
    slot_root: PathBuf,
}

#[derive(Clone, Debug)]
struct PersistedState {
    revision: RendererStateRevision,
    sha256: Option<String>,
    journal_bytes: usize,
}

#[derive(Clone, Debug)]
struct PreflightWait {
    expected_release_id: String,
    result: Option<Result<(), String>>,
}

#[derive(Clone, Debug)]
struct PreflightReceipt {
    release: RendererReleaseRef,
    completed_at: Instant,
}

#[derive(Clone, Debug)]
struct ActivationGuard {
    activation_id: String,
    expected_release: Option<RendererReleaseRef>,
    rollback_active: Option<RendererReleaseRef>,
    rollback_last_known_good: Option<RendererReleaseRef>,
    phase: String,
    started_at: Instant,
    started_at_unix_ms: u64,
    show_after_ready: bool,
}

#[derive(Debug)]
struct ManagerState {
    persisted: PersistedState,
    installed: BTreeMap<String, InstalledRendererRelease>,
    preflight_waits: HashMap<String, PreflightWait>,
    preflight_receipts: HashMap<String, PreflightReceipt>,
    activation: Option<ActivationGuard>,
    handoff: Option<RendererHandoff>,
    last_failure_recorded_at: Option<Instant>,
}

#[derive(Debug)]
struct RendererUpdateInner {
    root: PathBuf,
    built_in_url: Url,
    trusted_keys: Vec<ParsedTrustedRendererKey>,
    release_guard_required: bool,
    operation_lock: Mutex<()>,
    state: Mutex<ManagerState>,
    readiness: Condvar,
}

#[derive(Clone, Debug)]
pub struct RendererUpdateManager {
    inner: Arc<RendererUpdateInner>,
}

#[derive(Clone, Debug)]
pub struct RendererPreflightTicket {
    label: String,
    release_id: String,
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn bounded_error(value: impl Into<String>) -> String {
    let value = value.into().replace(['\r', '\n', '\0'], " ");
    value.chars().take(1_024).collect()
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_valid_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn parse_strict_version(value: &str, label: &str) -> Result<[u64; 3], String> {
    if value.is_empty() || value.len() > 64 || value.contains(['\r', '\n', '\0']) {
        return Err(format!("{label} is invalid or exceeds its length limit."));
    }
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err(format!(
            "{label} must use canonical major.minor.patch form."
        ));
    }
    let mut parsed = [0_u64; 3];
    for (index, part) in parts.into_iter().enumerate() {
        if part.is_empty()
            || !part.bytes().all(|byte| byte.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return Err(format!(
                "{label} must use canonical major.minor.patch form."
            ));
        }
        parsed[index] = part
            .parse::<u64>()
            .map_err(|_| format!("{label} contains an unsafe numeric component."))?;
    }
    Ok(parsed)
}

fn compare_versions(left: [u64; 3], right: [u64; 3]) -> std::cmp::Ordering {
    left.cmp(&right)
}

fn validate_created_at(value: &str) -> Result<(), String> {
    if value.len() != 24
        || !value.ends_with('Z')
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(19) != Some(&b'.')
    {
        return Err("Renderer release createdAt must be canonical UTC ISO-8601.".into());
    }
    let parsed = OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| "Renderer release createdAt is not a real canonical timestamp.".to_string())?;
    if parsed.offset() != UtcOffset::UTC {
        return Err("Renderer release createdAt must be canonical UTC ISO-8601.".into());
    }
    Ok(())
}

fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_json).collect()),
        Value::Object(values) => {
            let sorted = values
                .into_iter()
                .collect::<BTreeMap<String, Value>>()
                .into_iter()
                .map(|(key, value)| (key, canonicalize_json(value)))
                .collect::<Map<String, Value>>();
            Value::Object(sorted)
        }
        other => other,
    }
}

fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let value = serde_json::to_value(value)
        .map_err(|error| format!("Could not serialize renderer metadata: {error}"))?;
    serde_json::to_vec(&canonicalize_json(value))
        .map_err(|error| format!("Could not canonicalize renderer metadata: {error}"))
}

fn read_bounded_file(path: &Path, maximum_bytes: usize, label: &str) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect {label}: {error}"))?;
    if !metadata.file_type().is_file()
        || metadata.len() == 0
        || metadata.len() > maximum_bytes as u64
    {
        return Err(format!(
            "{label} is missing, empty, or exceeds its size limit."
        ));
    }
    reject_reparse_point(&metadata, label)?;
    let file = File::open(path).map_err(|error| format!("Could not open {label}: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take((maximum_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {label}: {error}"))?;
    if bytes.len() > maximum_bytes {
        return Err(format!("{label} exceeds its size limit."));
    }
    Ok(bytes)
}

#[cfg(windows)]
fn reject_reparse_point(metadata: &fs::Metadata, label: &str) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT_VALUE: u32 = 0x400;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT_VALUE != 0 {
        return Err(format!("{label} may not be a Windows reparse point."));
    }
    Ok(())
}

#[cfg(not(windows))]
fn reject_reparse_point(metadata: &fs::Metadata, label: &str) -> Result<(), String> {
    if metadata.file_type().is_symlink() {
        return Err(format!("{label} may not be a symbolic link."));
    }
    Ok(())
}
fn is_windows_reserved_name(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn validate_component_path(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 512 {
        return Err("Renderer component path is empty or exceeds its length limit.".into());
    }
    if value.starts_with('/')
        || value.starts_with('\\')
        || value.contains('\\')
        || value.contains(':')
        || value.contains("//")
        || value.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
    {
        return Err(format!("Renderer component path is invalid: {value}"));
    }
    let segments = value.split('/').collect::<Vec<_>>();
    if segments.is_empty()
        || segments.iter().any(|segment| {
            segment.is_empty()
                || *segment == "."
                || *segment == ".."
                || segment.ends_with('.')
                || segment.ends_with(' ')
                || is_windows_reserved_name(segment)
        })
    {
        return Err(format!("Renderer component path is invalid: {value}"));
    }
    if segments[0].eq_ignore_ascii_case(RENDERER_METADATA_DIRECTORY) {
        return Err("Renderer component path uses the reserved .scr-renderer root.".into());
    }
    Ok(value.to_string())
}

fn validate_manifest(manifest: &RendererReleaseManifest) -> Result<(), String> {
    if manifest.schema_version != RENDERER_MANIFEST_SCHEMA_VERSION {
        return Err("Unsupported renderer release manifest schema version.".into());
    }
    if !is_valid_identifier(&manifest.release_id) {
        return Err("Renderer release ID has an invalid shape.".into());
    }
    if manifest.release_sequence == 0 || manifest.release_sequence > MAX_SAFE_JSON_INTEGER {
        return Err("Renderer release sequence must be a positive safe JSON integer.".into());
    }
    parse_strict_version(&manifest.version, "Renderer release version")?;
    if !matches!(manifest.channel.as_str(), "stable" | "beta" | "development") {
        return Err("Renderer release channel is invalid.".into());
    }
    validate_created_at(&manifest.created_at)?;
    if manifest.entrypoint != "index.html" {
        return Err("Renderer entrypoint must be index.html.".into());
    }
    if manifest.total_bytes == 0 || manifest.total_bytes > MAX_RENDERER_BYTES {
        return Err("Renderer release totalBytes exceeds its limit.".into());
    }
    if manifest.components.is_empty() || manifest.components.len() > MAX_COMPONENTS {
        return Err(format!(
            "Renderer release components must contain 1 through {MAX_COMPONENTS} entries."
        ));
    }
    let minimum_shell = parse_strict_version(
        &manifest.compatibility.minimum_shell_version,
        "Minimum renderer shell version",
    )?;
    if let Some(maximum) = manifest.compatibility.maximum_shell_version.as_deref() {
        let maximum_shell = parse_strict_version(maximum, "Maximum renderer shell version")?;
        if compare_versions(minimum_shell, maximum_shell).is_gt() {
            return Err("Renderer shell compatibility range is inverted.".into());
        }
    }
    if manifest.compatibility.bridge_api_version == 0 {
        return Err("Renderer bridge API version must be positive.".into());
    }

    let mut paths = HashSet::new();
    let mut total_bytes = 0_u64;
    for component in &manifest.components {
        let path = validate_component_path(&component.path)?;
        if !is_lower_sha256(&component.sha256) {
            return Err(format!(
                "Renderer component {path} SHA-256 must be a lowercase digest."
            ));
        }
        if component.bytes == 0 || component.bytes > MAX_COMPONENT_BYTES {
            return Err(format!(
                "Renderer component {path} byte length exceeds its limit."
            ));
        }
        let key = path.to_ascii_lowercase();
        if !paths.insert(key) {
            return Err(format!("Renderer component path is duplicated: {path}"));
        }
        total_bytes = total_bytes
            .checked_add(component.bytes)
            .ok_or_else(|| "Renderer component byte total overflowed.".to_string())?;
        if total_bytes > MAX_RENDERER_BYTES {
            return Err("Renderer component byte total exceeds its limit.".into());
        }
    }
    for path in &paths {
        let segments = path.split('/').collect::<Vec<_>>();
        for index in 1..segments.len() {
            let ancestor = segments[..index].join("/");
            if paths.contains(&ancestor) {
                return Err(format!(
                    "Renderer component path conflicts with a component used as a directory: {ancestor}"
                ));
            }
        }
    }
    if !paths.contains("index.html") {
        return Err("Renderer release does not contain its index.html entrypoint.".into());
    }
    if total_bytes != manifest.total_bytes {
        return Err("Renderer totalBytes does not match component bytes.".into());
    }
    let canonical = canonical_json(manifest)?;
    if canonical.len() > MAX_MANIFEST_BYTES {
        return Err("Renderer release manifest exceeds its canonical size limit.".into());
    }
    Ok(())
}

fn parse_public_key_pem(value: &str) -> Result<[u8; 32], String> {
    if value.is_empty() || value.len() > 16 * 1024 || value.contains('\0') {
        return Err("Trusted renderer public key is invalid or exceeds its limit.".into());
    }
    if value.contains("PRIVATE KEY") {
        return Err("Trusted renderer keys must contain public-key PEM only.".into());
    }
    let normalized = value.replace("\r\n", "\n");
    let trimmed = normalized.trim();
    let prefix = "-----BEGIN PUBLIC KEY-----\n";
    let suffix = "\n-----END PUBLIC KEY-----";
    let encoded = trimmed
        .strip_prefix(prefix)
        .and_then(|remaining| remaining.strip_suffix(suffix))
        .ok_or_else(|| {
            "Trusted renderer keys must contain canonical SPKI public-key PEM only.".to_string()
        })?;
    if encoded.is_empty()
        || encoded.contains(['\r', '\n', ' ', '\t'])
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err("Trusted renderer public key PEM is not canonical.".into());
    }
    let der = STANDARD
        .decode(encoded)
        .map_err(|_| "Trusted renderer public key PEM is not valid base64.".to_string())?;
    if STANDARD.encode(&der) != encoded {
        return Err("Trusted renderer public key PEM is not canonical.".into());
    }
    if der.len() != ED25519_SPKI_PREFIX.len() + 32 || !der.starts_with(ED25519_SPKI_PREFIX) {
        return Err("Trusted renderer public key is not canonical Ed25519 SPKI.".into());
    }
    let canonical = format!(
        "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----",
        STANDARD.encode(&der)
    );
    if trimmed != canonical {
        return Err(
            "Trusted renderer public key PEM must contain exactly one canonical SPKI key.".into(),
        );
    }
    let mut public_key = [0_u8; 32];
    public_key.copy_from_slice(&der[ED25519_SPKI_PREFIX.len()..]);
    Ok(public_key)
}

fn parse_trusted_key_registry(bytes: &[u8]) -> Result<Vec<ParsedTrustedRendererKey>, String> {
    let registry: TrustedRendererKeyRegistry = serde_json::from_slice(bytes)
        .map_err(|error| format!("Renderer trusted-key registry is invalid JSON: {error}"))?;
    if registry.schema_version != RENDERER_TRUSTED_KEYS_SCHEMA_VERSION {
        return Err("Unsupported renderer trusted-key registry schema version.".into());
    }
    if registry.keys.len() > MAX_TRUSTED_KEYS {
        return Err(format!(
            "Renderer trusted-key registry exceeds {MAX_TRUSTED_KEYS} keys."
        ));
    }
    let mut key_ids = HashSet::new();
    let mut parsed = Vec::with_capacity(registry.keys.len());
    for key in registry.keys {
        if !is_valid_identifier(&key.key_id) {
            return Err("Trusted renderer key ID has an invalid shape.".into());
        }
        if !key_ids.insert(key.key_id.to_ascii_lowercase()) {
            return Err(format!(
                "Trusted renderer key ID is duplicated: {}",
                key.key_id
            ));
        }
        if key.algorithm != "ed25519" {
            return Err("Only Ed25519 renderer keys are supported.".into());
        }
        if key.minimum_release_sequence == 0 || key.minimum_release_sequence > MAX_SAFE_JSON_INTEGER
        {
            return Err(
                "Trusted renderer key minimum sequence must be a positive safe JSON integer."
                    .into(),
            );
        }
        if let Some(maximum) = key.maximum_release_sequence {
            if maximum > MAX_SAFE_JSON_INTEGER {
                return Err(
                    "Trusted renderer key maximum sequence must be a safe JSON integer.".into(),
                );
            }
            if maximum < key.minimum_release_sequence {
                return Err("Trusted renderer key sequence range is inverted.".into());
            }
        }
        if key.allowed_channels.is_empty() || key.allowed_channels.len() > 3 {
            return Err("Trusted renderer key must allow one through three channels.".into());
        }
        let mut allowed_channels = HashSet::new();
        for channel in key.allowed_channels {
            if !matches!(channel.as_str(), "stable" | "beta" | "development") {
                return Err("Trusted renderer key channel policy is invalid.".into());
            }
            if !allowed_channels.insert(channel) {
                return Err("Trusted renderer key channel policy contains duplicates.".into());
            }
        }
        parsed.push(ParsedTrustedRendererKey {
            key_id: key.key_id,
            public_key: parse_public_key_pem(&key.public_key_pem)?,
            minimum_release_sequence: key.minimum_release_sequence,
            maximum_release_sequence: key.maximum_release_sequence,
            allowed_channels,
        });
    }
    Ok(parsed)
}

fn renderer_signature_payload(manifest_sha256: &str) -> Result<Vec<u8>, String> {
    if !is_lower_sha256(manifest_sha256) {
        return Err("Renderer manifest SHA-256 must be a lowercase digest.".into());
    }
    Ok(format!("SCR-RENDERER-MANIFEST-V1\n{manifest_sha256}").into_bytes())
}

fn verify_renderer_envelope(
    bytes: &[u8],
    trusted_keys: &[ParsedTrustedRendererKey],
) -> Result<VerifiedRendererEnvelope, String> {
    if bytes.is_empty() || bytes.len() > MAX_ENVELOPE_BYTES {
        return Err("Renderer signature envelope is empty or exceeds its limit.".into());
    }
    let envelope: RendererReleaseEnvelope = serde_json::from_slice(bytes)
        .map_err(|error| format!("Renderer signature envelope is invalid JSON: {error}"))?;
    if envelope.schema_version != RENDERER_SIGNATURE_SCHEMA_VERSION {
        return Err("Unsigned or unsupported renderer signature envelope.".into());
    }
    if envelope.algorithm != "ed25519" {
        return Err("Only Ed25519 renderer signatures are supported.".into());
    }
    if !is_valid_identifier(&envelope.key_id) {
        return Err("Renderer signing key ID has an invalid shape.".into());
    }
    if !is_lower_sha256(&envelope.manifest_sha256) {
        return Err("Renderer manifest SHA-256 must be a lowercase digest.".into());
    }
    validate_manifest(&envelope.manifest)?;
    let canonical_manifest = canonical_json(&envelope.manifest)?;
    let manifest_sha256 = sha256_bytes(&canonical_manifest);
    if manifest_sha256 != envelope.manifest_sha256 {
        return Err("Renderer manifest digest does not match the signed envelope.".into());
    }
    if trusted_keys.is_empty() {
        return Err("Renderer updates are disabled because no trusted keys are installed.".into());
    }
    let trusted_key = trusted_keys
        .iter()
        .find(|key| key.key_id == envelope.key_id)
        .ok_or_else(|| "Renderer signing key is unknown.".to_string())?;
    if envelope.manifest.release_sequence < trusted_key.minimum_release_sequence
        || trusted_key
            .maximum_release_sequence
            .is_some_and(|maximum| envelope.manifest.release_sequence > maximum)
    {
        return Err("Renderer sequence is outside the trusted key's allowed range.".into());
    }
    if !trusted_key
        .allowed_channels
        .contains(&envelope.manifest.channel)
    {
        return Err("Renderer channel is not allowed by the trusted signing key.".into());
    }
    if envelope.signature.is_empty()
        || envelope.signature.len() > 256
        || !envelope
            .signature
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("Renderer signature is not canonical base64url.".into());
    }
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(&envelope.signature)
        .map_err(|_| "Renderer signature is not canonical base64url.".to_string())?;
    if signature_bytes.len() != 64 || URL_SAFE_NO_PAD.encode(&signature_bytes) != envelope.signature
    {
        return Err(
            "Ed25519 renderer signature must use canonical 64-byte base64url encoding.".into(),
        );
    }
    signature::UnparsedPublicKey::new(&signature::ED25519, trusted_key.public_key)
        .verify(
            &renderer_signature_payload(&manifest_sha256)?,
            &signature_bytes,
        )
        .map_err(|_| "Renderer signature verification failed.".to_string())?;
    Ok(VerifiedRendererEnvelope {
        envelope,
        manifest_sha256,
    })
}

fn validate_shell_compatibility(manifest: &RendererReleaseManifest) -> Result<(), String> {
    let shell = parse_strict_version(SHELL_VERSION, "Host shell version")?;
    let minimum = parse_strict_version(
        &manifest.compatibility.minimum_shell_version,
        "Minimum renderer shell version",
    )?;
    if compare_versions(shell, minimum).is_lt() {
        return Err("Renderer release requires a newer stable shell.".into());
    }
    if let Some(maximum) = manifest.compatibility.maximum_shell_version.as_deref() {
        let maximum = parse_strict_version(maximum, "Maximum renderer shell version")?;
        if compare_versions(shell, maximum).is_gt() {
            return Err("Renderer release does not support this stable shell version.".into());
        }
    }
    if manifest.compatibility.bridge_api_version != RENDERER_BRIDGE_API_VERSION {
        return Err("Renderer bridge API version is incompatible with the stable shell.".into());
    }
    Ok(())
}

fn release_ref(verified: &VerifiedRendererEnvelope) -> RendererReleaseRef {
    RendererReleaseRef {
        release_id: verified.envelope.manifest.release_id.clone(),
        release_sequence: verified.envelope.manifest.release_sequence,
        version: verified.envelope.manifest.version.clone(),
        channel: verified.envelope.manifest.channel.clone(),
        manifest_sha256: verified.manifest_sha256.clone(),
    }
}

fn validate_release_ref(value: &RendererReleaseRef) -> Result<(), String> {
    if !is_valid_identifier(&value.release_id)
        || value.release_sequence == 0
        || value.release_sequence > MAX_SAFE_JSON_INTEGER
        || !is_lower_sha256(&value.manifest_sha256)
        || !matches!(value.channel.as_str(), "stable" | "beta" | "development")
    {
        return Err("Persisted renderer release reference is invalid.".into());
    }
    parse_strict_version(&value.version, "Persisted renderer release version")?;
    Ok(())
}
#[cfg(windows)]
fn reject_shared_file(file: &File, label: &str) -> Result<(), String> {
    use std::mem::zeroed;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION},
    };

    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    let handle = HANDLE(file.as_raw_handle());
    unsafe { GetFileInformationByHandle(handle, &mut information) }
        .map_err(|error| format!("Could not inspect {label} hard-link count: {error}"))?;
    if information.nNumberOfLinks != 1 {
        return Err(format!("{label} may not be shared through a hard link."));
    }
    Ok(())
}

#[cfg(unix)]
fn reject_shared_file(file: &File, label: &str) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect {label}: {error}"))?;
    if metadata.nlink() != 1 {
        return Err(format!("{label} may not be shared through a hard link."));
    }
    Ok(())
}

#[cfg(not(any(windows, unix)))]
fn reject_shared_file(_file: &File, _label: &str) -> Result<(), String> {
    Ok(())
}

fn relative_path_string(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Renderer file escaped its expected root.".to_string())?;
    let mut segments = Vec::new();
    for component in relative.components() {
        let segment = component
            .as_os_str()
            .to_str()
            .ok_or_else(|| "Renderer file path is not valid Unicode.".to_string())?;
        segments.push(segment);
    }
    validate_component_path(&segments.join("/"))
}

fn collect_payload_files(
    root: &Path,
    skip_metadata: bool,
) -> Result<RendererPayloadInventory, String> {
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Could not inspect renderer payload root: {error}"))?;
    if !root_metadata.is_dir() {
        return Err("Renderer payload root is not a directory.".into());
    }
    reject_reparse_point(&root_metadata, "Renderer payload root")?;

    let mut files = Vec::new();
    let mut directories = HashSet::new();
    let mut stack = vec![root.to_path_buf()];
    let mut visited_directories = 0_usize;
    while let Some(directory) = stack.pop() {
        visited_directories += 1;
        if visited_directories > MAX_COMPONENTS * 4 {
            return Err("Renderer payload contains too many directories.".into());
        }
        let mut entries = fs::read_dir(&directory)
            .map_err(|error| format!("Could not enumerate renderer payload: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not enumerate renderer payload: {error}"))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Could not inspect renderer payload entry: {error}"))?;
            reject_reparse_point(&metadata, "Renderer payload entry")?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "Renderer payload entry escaped its root.".to_string())?;
            let first = relative
                .components()
                .next()
                .and_then(|component| component.as_os_str().to_str());
            if skip_metadata
                && first.is_some_and(|segment| {
                    segment.eq_ignore_ascii_case(RENDERER_METADATA_DIRECTORY)
                })
            {
                if relative.components().count() == 1 && metadata.is_dir() {
                    continue;
                }
                return Err("Renderer payload metadata root has an invalid shape.".into());
            }
            if metadata.is_dir() {
                let relative_string = relative
                    .components()
                    .map(|component| {
                        component.as_os_str().to_str().ok_or_else(|| {
                            "Renderer directory path is not valid Unicode.".to_string()
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .join("/");
                validate_component_path(&format!("{relative_string}/placeholder"))?;
                directories.insert(relative_string.to_ascii_lowercase());
                stack.push(path);
            } else if metadata.file_type().is_file() {
                if files.len() >= MAX_COMPONENTS {
                    return Err("Renderer payload contains too many files.".into());
                }
                files.push((relative_path_string(root, &path)?, path));
            } else {
                return Err("Renderer payload contains a non-file, non-directory entry.".into());
            }
        }
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok((files, directories))
}

fn hash_component_file(path: &Path, expected_bytes: u64, label: &str) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect {label}: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() != expected_bytes {
        return Err(format!("{label} byte length does not match its manifest."));
    }
    reject_reparse_point(&metadata, label)?;
    let mut file = File::open(path).map_err(|error| format!("Could not open {label}: {error}"))?;
    reject_shared_file(&file, label)?;
    let mut digest = Sha256::new();
    let copied = std::io::copy(&mut file, &mut digest)
        .map_err(|error| format!("Could not hash {label}: {error}"))?;
    if copied != expected_bytes {
        return Err(format!("{label} changed while it was being hashed."));
    }
    Ok(hex::encode(digest.finalize()))
}

fn verify_payload_inventory(
    root: &Path,
    manifest: &RendererReleaseManifest,
    skip_metadata: bool,
) -> Result<(), String> {
    let (files, mut directories) = collect_payload_files(root, skip_metadata)?;
    if files.len() != manifest.components.len() {
        return Err("Renderer payload inventory has missing or extra components.".into());
    }
    let expected = manifest
        .components
        .iter()
        .map(|component| (component.path.to_ascii_lowercase(), component))
        .collect::<BTreeMap<_, _>>();
    let mut observed_keys = HashSet::new();
    for (relative, path) in files {
        let key = relative.to_ascii_lowercase();
        if !observed_keys.insert(key.clone()) {
            return Err(format!("Renderer payload path is duplicated: {relative}"));
        }
        let component = expected
            .get(&key)
            .ok_or_else(|| format!("Renderer payload contains an extra component: {relative}"))?;
        if component.path != relative {
            return Err(format!(
                "Renderer payload component path case does not match its manifest: {relative}"
            ));
        }
        let actual_sha256 = hash_component_file(
            &path,
            component.bytes,
            &format!("Renderer component {relative}"),
        )?;
        if actual_sha256 != component.sha256 {
            return Err(format!("Renderer component SHA-256 mismatch: {relative}"));
        }
    }
    for component in &manifest.components {
        if !observed_keys.contains(&component.path.to_ascii_lowercase()) {
            return Err(format!(
                "Renderer payload is missing component: {}",
                component.path
            ));
        }
        let segments = component.path.split('/').collect::<Vec<_>>();
        for index in 1..segments.len() {
            directories.remove(&segments[..index].join("/").to_ascii_lowercase());
        }
    }
    if !directories.is_empty() {
        let mut extras = directories.into_iter().collect::<Vec<_>>();
        extras.sort();
        return Err(format!(
            "Renderer payload contains an extra directory: {}",
            extras[0]
        ));
    }
    Ok(())
}

fn copy_component(
    source: &Path,
    destination: &Path,
    component: &RendererReleaseComponent,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create renderer slot directory: {error}"))?;
    }
    let source_metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Could not inspect renderer source component: {error}"))?;
    if !source_metadata.file_type().is_file() || source_metadata.len() != component.bytes {
        return Err(format!(
            "Renderer source component changed before copy: {}",
            component.path
        ));
    }
    reject_reparse_point(&source_metadata, "Renderer source component")?;
    let mut source_file = File::open(source)
        .map_err(|error| format!("Could not open renderer source component: {error}"))?;
    reject_shared_file(&source_file, "Renderer source component")?;
    let mut destination_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("Could not create renderer slot component: {error}"))?;
    let copied = std::io::copy(
        &mut std::io::Read::by_ref(&mut source_file).take(component.bytes + 1),
        &mut destination_file,
    )
    .map_err(|error| format!("Could not copy renderer component: {error}"))?;
    if copied != component.bytes {
        return Err(format!(
            "Renderer source component changed during copy: {}",
            component.path
        ));
    }
    destination_file
        .sync_all()
        .map_err(|error| format!("Could not flush renderer slot component: {error}"))?;
    Ok(())
}

fn cleanup_staged_renderer_slot(slot_root: &Path, manifest: &RendererReleaseManifest) {
    let metadata_root = slot_root.join(RENDERER_METADATA_DIRECTORY);
    let _ = fs::remove_file(metadata_root.join(RENDERER_READY_FILE));
    let _ = fs::remove_file(metadata_root.join(RENDERER_ENVELOPE_FILE));
    let _ = fs::remove_dir(&metadata_root);

    let mut directories = HashSet::new();
    for component in &manifest.components {
        let path = component_path(slot_root, &component.path);
        let _ = fs::remove_file(&path);
        let mut parent = path.parent();
        while let Some(value) = parent {
            if value == slot_root {
                break;
            }
            directories.insert(value.to_path_buf());
            parent = value.parent();
        }
    }
    let mut directories = directories.into_iter().collect::<Vec<_>>();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        let _ = fs::remove_dir(directory);
    }
    let _ = fs::remove_dir(slot_root);
}

fn random_suffix() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Could not generate renderer update nonce: {error}"))?;
    Ok(hex::encode(bytes))
}

fn state_revision_name(revision: u64) -> String {
    format!("revision-{revision:020}.json")
}

fn default_persisted_state() -> PersistedState {
    PersistedState {
        revision: RendererStateRevision {
            schema_version: RENDERER_STATE_SCHEMA_VERSION.to_string(),
            storage_revision: 0,
            previous_state_sha256: None,
            highest_release_sequence: 0,
            active_release: None,
            last_known_good_release: None,
            last_failure: None,
            updated_at_unix_ms: now_unix_ms(),
        },
        sha256: None,
        journal_bytes: 0,
    }
}

fn validate_state_revision(
    revision: &RendererStateRevision,
    expected_revision: u64,
    expected_previous_sha256: Option<&str>,
) -> Result<(), String> {
    if revision.schema_version != RENDERER_STATE_SCHEMA_VERSION {
        return Err("Unsupported persisted renderer state schema version.".into());
    }
    if revision.storage_revision != expected_revision {
        return Err("Persisted renderer state revision is not contiguous.".into());
    }
    if revision.previous_state_sha256.as_deref() != expected_previous_sha256 {
        return Err("Persisted renderer state hash chain is invalid.".into());
    }
    if let Some(value) = revision.active_release.as_ref() {
        validate_release_ref(value)?;
    }
    if let Some(value) = revision.last_known_good_release.as_ref() {
        validate_release_ref(value)?;
    }
    match (
        revision.active_release.as_ref(),
        revision.last_known_good_release.as_ref(),
    ) {
        (None, Some(_)) => {
            return Err(
                "Built-in active renderer state may not retain a custom rollback release.".into(),
            )
        }
        (Some(active), Some(last_known_good)) if active == last_known_good => {
            return Err("Active and last-known-good renderer releases must be distinct.".into())
        }
        _ => {}
    }
    let referenced_maximum = revision
        .active_release
        .as_ref()
        .into_iter()
        .chain(revision.last_known_good_release.as_ref())
        .map(|release| release.release_sequence)
        .max()
        .unwrap_or(0);
    if revision.highest_release_sequence > MAX_SAFE_JSON_INTEGER {
        return Err(
            "Persisted renderer highest release sequence is not a safe JSON integer.".into(),
        );
    }
    if revision.highest_release_sequence < referenced_maximum {
        return Err(
            "Persisted renderer highest release sequence is below a referenced release.".into(),
        );
    }
    if revision.updated_at_unix_ms == 0 || revision.updated_at_unix_ms > MAX_SAFE_JSON_INTEGER {
        return Err("Persisted renderer state timestamp is invalid.".into());
    }
    if revision.last_failure.as_ref().is_some_and(|value| {
        value.is_empty() || value.len() > 1_024 || value.contains(['\r', '\n', '\0'])
    }) {
        return Err("Persisted renderer failure reason is invalid.".into());
    }
    Ok(())
}

fn load_state_journal(root: &Path) -> Result<PersistedState, String> {
    let state_root = root.join("state");
    fs::create_dir_all(&state_root)
        .map_err(|error| format!("Could not create renderer state directory: {error}"))?;
    ensure_directory_shape(&state_root, "Renderer state directory")?;
    let mut entries = fs::read_dir(&state_root)
        .map_err(|error| format!("Could not enumerate renderer state directory: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not enumerate renderer state directory: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut revision_files = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(".pending-") && name.ends_with(".tmp") {
            let _ = fs::remove_file(entry.path());
            continue;
        }
        if !name.starts_with("revision-") || !name.ends_with(".json") {
            return Err(format!(
                "Renderer state directory contains an unexpected entry: {name}"
            ));
        }
        revision_files.push((name, entry.path()));
    }
    if revision_files.len() > MAX_STATE_REVISIONS {
        return Err("Renderer state journal contains too many revisions.".into());
    }
    let mut current = default_persisted_state();
    for (index, (name, path)) in revision_files.into_iter().enumerate() {
        let expected_revision = (index + 1) as u64;
        if name != state_revision_name(expected_revision) {
            return Err("Renderer state journal has a missing or malformed revision.".into());
        }
        let bytes = read_bounded_file(&path, MAX_STATE_BYTES, "Renderer state revision")?;
        let revision: RendererStateRevision = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Renderer state revision is invalid JSON: {error}"))?;
        validate_state_revision(&revision, expected_revision, current.sha256.as_deref())?;
        let journal_bytes = current
            .journal_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| "Renderer state journal byte total overflowed.".to_string())?;
        if journal_bytes > MAX_STATE_JOURNAL_BYTES {
            return Err("Renderer state journal exceeds its cumulative size limit.".into());
        }
        current = PersistedState {
            revision,
            sha256: Some(sha256_bytes(&bytes)),
            journal_bytes,
        };
    }
    Ok(current)
}

fn quarantine_corrupt_state_journal(
    root: &Path,
    reason: impl Into<String>,
) -> Result<PersistedState, String> {
    let reason = bounded_error(reason);
    ensure_directory_shape(root, "Renderer update storage")?;
    let state_root = root.join("state");
    match fs::symlink_metadata(&state_root) {
        Ok(_) => {
            ensure_directory_shape(&state_root, "Renderer state directory")?;
            let quarantine = root.join(format!(
                "state-corrupt-{}-{}",
                now_unix_ms(),
                random_suffix()?
            ));
            fs::rename(&state_root, &quarantine).map_err(|error| {
                format!("Could not quarantine the corrupt renderer state journal: {error}")
            })?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Could not inspect the corrupt renderer state journal: {error}"
            ))
        }
    }
    fs::create_dir_all(&state_root)
        .map_err(|error| format!("Could not recreate the renderer state directory: {error}"))?;
    ensure_directory_shape(&state_root, "Renderer state directory")?;

    let entries = fs::read_dir(root)
        .map_err(|error| format!("Could not enumerate renderer update storage: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not enumerate renderer update storage: {error}"))?;
    let mut quarantines = Vec::new();
    for entry in entries {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with("state-corrupt-")
        {
            continue;
        }
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if metadata.is_dir() && reject_reparse_point(&metadata, "Renderer state quarantine").is_ok()
        {
            quarantines.push(entry);
        }
    }
    quarantines.sort_by_key(|entry| entry.file_name());
    let remove_count = quarantines
        .len()
        .saturating_sub(MAX_QUARANTINED_STATE_JOURNALS);
    for entry in quarantines.into_iter().take(remove_count) {
        let _ = fs::remove_dir_all(entry.path());
    }

    persist_state_journal(
        root,
        &default_persisted_state(),
        None,
        None,
        Some(format!(
            "Renderer state journal was corrupt and the built-in renderer was restored: {reason}"
        )),
    )
}

fn persist_state_journal(
    root: &Path,
    current: &PersistedState,
    active_release: Option<RendererReleaseRef>,
    last_known_good_release: Option<RendererReleaseRef>,
    last_failure: Option<String>,
) -> Result<PersistedState, String> {
    persist_state_journal_with_floor(
        root,
        current,
        active_release,
        last_known_good_release,
        last_failure,
        0,
    )
}

fn persist_state_journal_with_floor(
    root: &Path,
    current: &PersistedState,
    active_release: Option<RendererReleaseRef>,
    last_known_good_release: Option<RendererReleaseRef>,
    last_failure: Option<String>,
    minimum_highest_release_sequence: u64,
) -> Result<PersistedState, String> {
    let next_revision = current
        .revision
        .storage_revision
        .checked_add(1)
        .ok_or_else(|| "Renderer state revision overflowed.".to_string())?;
    if next_revision as usize > MAX_STATE_REVISIONS {
        return Err("Renderer state journal reached its revision limit.".into());
    }
    match (active_release.as_ref(), last_known_good_release.as_ref()) {
        (None, Some(_)) => {
            return Err(
                "Built-in active renderer state may not retain a custom rollback release.".into(),
            )
        }
        (Some(active), Some(last_known_good)) if active == last_known_good => {
            return Err("Active and last-known-good renderer releases must be distinct.".into())
        }
        _ => {}
    }
    let referenced_maximum = active_release
        .as_ref()
        .into_iter()
        .chain(last_known_good_release.as_ref())
        .map(|release| release.release_sequence)
        .max()
        .unwrap_or(0);
    let highest_release_sequence = current
        .revision
        .highest_release_sequence
        .max(referenced_maximum)
        .max(minimum_highest_release_sequence);
    let next = RendererStateRevision {
        schema_version: RENDERER_STATE_SCHEMA_VERSION.to_string(),
        storage_revision: next_revision,
        previous_state_sha256: current.sha256.clone(),
        highest_release_sequence,
        active_release,
        last_known_good_release,
        last_failure: last_failure.map(bounded_error),
        updated_at_unix_ms: now_unix_ms(),
    };
    validate_state_revision(&next, next_revision, current.sha256.as_deref())?;
    let mut bytes = canonical_json(&next)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_STATE_BYTES {
        return Err("Renderer state revision exceeds its size limit.".into());
    }
    let journal_bytes = current
        .journal_bytes
        .checked_add(bytes.len())
        .ok_or_else(|| "Renderer state journal byte total overflowed.".to_string())?;
    if journal_bytes > MAX_STATE_JOURNAL_BYTES {
        return Err("Renderer state journal exceeds its cumulative size limit.".into());
    }
    let state_root = root.join("state");
    fs::create_dir_all(&state_root)
        .map_err(|error| format!("Could not create renderer state directory: {error}"))?;
    ensure_directory_shape(&state_root, "Renderer state directory")?;
    let temporary = state_root.join(format!(
        ".pending-{next_revision:020}-{}.tmp",
        random_suffix()?
    ));
    let final_path = state_root.join(state_revision_name(next_revision));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create renderer state revision: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("Could not write renderer state revision: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not flush renderer state revision: {error}"))?;
    drop(file);
    fs::hard_link(&temporary, &final_path)
        .map_err(|error| format!("Could not publish renderer state revision: {error}"))?;
    let published = read_bounded_file(
        &final_path,
        MAX_STATE_BYTES,
        "Published renderer state revision",
    )?;
    if published != bytes {
        return Err("Published renderer state revision changed after publication.".into());
    }
    let _ = fs::remove_file(&temporary);
    Ok(PersistedState {
        revision: next,
        sha256: Some(sha256_bytes(&published)),
        journal_bytes,
    })
}
fn ensure_directory_shape(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect {label}: {error}"))?;
    if !metadata.is_dir() {
        return Err(format!("{label} is not a directory."));
    }
    reject_reparse_point(&metadata, label)
}

fn verify_inbox_shape(inbox_root: &Path) -> Result<(), String> {
    ensure_directory_shape(inbox_root, "Renderer inbox release")?;
    let mut names = fs::read_dir(inbox_root)
        .map_err(|error| format!("Could not enumerate renderer inbox release: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not enumerate renderer inbox release: {error}"))?
        .into_iter()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    names.sort();
    let mut expected = vec![
        RENDERER_BUNDLE_DIRECTORY.to_string(),
        RENDERER_ENVELOPE_FILE.to_string(),
    ];
    expected.sort();
    if names != expected {
        return Err("Renderer inbox release must contain only bundle/ and envelope.json.".into());
    }
    ensure_directory_shape(
        &inbox_root.join(RENDERER_BUNDLE_DIRECTORY),
        "Renderer inbox bundle",
    )?;
    Ok(())
}

fn verify_slot_metadata_shape(slot_root: &Path) -> Result<(), String> {
    let metadata_root = slot_root.join(RENDERER_METADATA_DIRECTORY);
    ensure_directory_shape(&metadata_root, "Renderer slot metadata")?;
    let mut names = fs::read_dir(&metadata_root)
        .map_err(|error| format!("Could not enumerate renderer slot metadata: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not enumerate renderer slot metadata: {error}"))?
        .into_iter()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    names.sort();
    let mut expected = vec![
        RENDERER_ENVELOPE_FILE.to_string(),
        RENDERER_READY_FILE.to_string(),
    ];
    expected.sort();
    if names != expected {
        return Err("Renderer slot metadata contains missing or extra files.".into());
    }
    Ok(())
}

fn verify_inbox_release(
    root: &Path,
    release_id: &str,
    trusted_keys: &[ParsedTrustedRendererKey],
) -> Result<(VerifiedRendererEnvelope, PathBuf, Vec<u8>), String> {
    if !is_valid_identifier(release_id) {
        return Err("Renderer release ID has an invalid shape.".into());
    }
    let inbox_root = root.join("inbox").join(release_id);
    verify_inbox_shape(&inbox_root)?;
    let envelope_path = inbox_root.join(RENDERER_ENVELOPE_FILE);
    let envelope_bytes = read_bounded_file(
        &envelope_path,
        MAX_ENVELOPE_BYTES,
        "Renderer inbox signature envelope",
    )?;
    let verified = verify_renderer_envelope(&envelope_bytes, trusted_keys)?;
    if verified.envelope.manifest.release_id != release_id {
        return Err("Renderer inbox directory does not match the signed release ID.".into());
    }
    validate_shell_compatibility(&verified.envelope.manifest)?;
    let bundle_root = inbox_root.join(RENDERER_BUNDLE_DIRECTORY);
    verify_payload_inventory(&bundle_root, &verified.envelope.manifest, false)?;
    Ok((verified, bundle_root, envelope_bytes))
}

fn verify_slot_release(
    slot_root: &Path,
    expected_release_id: &str,
    trusted_keys: &[ParsedTrustedRendererKey],
) -> Result<InstalledRendererRelease, String> {
    if !is_valid_identifier(expected_release_id) {
        return Err("Renderer slot release ID has an invalid shape.".into());
    }
    ensure_directory_shape(slot_root, "Renderer slot")?;
    verify_slot_metadata_shape(slot_root)?;
    let metadata_root = slot_root.join(RENDERER_METADATA_DIRECTORY);
    let envelope_bytes = read_bounded_file(
        &metadata_root.join(RENDERER_ENVELOPE_FILE),
        MAX_ENVELOPE_BYTES,
        "Renderer slot signature envelope",
    )?;
    let verified = verify_renderer_envelope(&envelope_bytes, trusted_keys)?;
    if verified.envelope.manifest.release_id != expected_release_id {
        return Err("Renderer slot directory does not match the signed release ID.".into());
    }
    validate_shell_compatibility(&verified.envelope.manifest)?;
    let ready_bytes = read_bounded_file(
        &metadata_root.join(RENDERER_READY_FILE),
        MAX_STATE_BYTES,
        "Renderer slot ready marker",
    )?;
    let ready: RendererReadyMarker = serde_json::from_slice(&ready_bytes)
        .map_err(|error| format!("Renderer slot ready marker is invalid JSON: {error}"))?;
    if ready.schema_version != RENDERER_READY_SCHEMA_VERSION {
        return Err("Unsupported renderer slot ready marker schema version.".into());
    }
    let release = release_ref(&verified);
    if ready.release != release
        || ready.installed_at_unix_ms == 0
        || ready.installed_at_unix_ms > MAX_SAFE_JSON_INTEGER
    {
        return Err("Renderer slot ready marker does not match its signed release.".into());
    }
    verify_payload_inventory(slot_root, &verified.envelope.manifest, true)?;
    Ok(InstalledRendererRelease {
        release,
        manifest: verified.envelope.manifest,
        slot_root: slot_root.to_path_buf(),
    })
}

fn load_installed_releases(
    root: &Path,
    trusted_keys: &[ParsedTrustedRendererKey],
) -> Result<(BTreeMap<String, InstalledRendererRelease>, Vec<String>), String> {
    let slots_root = root.join("slots");
    fs::create_dir_all(&slots_root)
        .map_err(|error| format!("Could not create renderer slots directory: {error}"))?;
    ensure_directory_shape(&slots_root, "Renderer slots directory")?;
    let mut entries = fs::read_dir(&slots_root)
        .map_err(|error| format!("Could not enumerate renderer slots: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not enumerate renderer slots: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut installed = BTreeMap::new();
    let mut problems = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(".install-") {
            problems.push(format!(
                "Ignored incomplete renderer staging directory: {name}"
            ));
            continue;
        }
        if installed.len() >= MAX_INSTALLED_RELEASES {
            return Err("Renderer slot count exceeds its limit.".into());
        }
        if !is_valid_identifier(&name) {
            problems.push(format!("Ignored renderer slot with invalid name: {name}"));
            continue;
        }
        match verify_slot_release(&entry.path(), &name, trusted_keys) {
            Ok(release) => {
                installed.insert(name, release);
            }
            Err(error) => {
                problems.push(format!("Ignored invalid renderer slot {name}: {error}"));
            }
        }
    }
    Ok((installed, problems))
}

fn release_matches_installed(
    value: &RendererReleaseRef,
    installed: &BTreeMap<String, InstalledRendererRelease>,
) -> bool {
    installed
        .get(&value.release_id)
        .is_some_and(|candidate| candidate.release == *value)
}

fn recover_persisted_state(
    root: &Path,
    persisted: PersistedState,
    installed: &BTreeMap<String, InstalledRendererRelease>,
    initial_problem: Option<String>,
    recovered_from_corrupt_journal: bool,
) -> Result<PersistedState, String> {
    let active_valid = persisted
        .revision
        .active_release
        .as_ref()
        .is_none_or(|value| release_matches_installed(value, installed));
    let last_known_good_valid = persisted
        .revision
        .last_known_good_release
        .as_ref()
        .is_none_or(|value| release_matches_installed(value, installed));
    let installed_highest_release_sequence = installed
        .values()
        .map(|release| release.release.release_sequence)
        .max()
        .unwrap_or(0);
    let sequence_floor_missing = recovered_from_corrupt_journal
        && persisted.revision.highest_release_sequence < installed_highest_release_sequence;
    if active_valid && last_known_good_valid && initial_problem.is_none() && !sequence_floor_missing
    {
        return Ok(persisted);
    }
    let valid_last_known_good = persisted
        .revision
        .last_known_good_release
        .clone()
        .filter(|value| release_matches_installed(value, installed));
    let (active, last_known_good) = if active_valid {
        (
            persisted.revision.active_release.clone(),
            valid_last_known_good,
        )
    } else {
        (valid_last_known_good, None)
    };
    let reason = match initial_problem {
        Some(value) => Some(value),
        None if !active_valid => Some(
            "Active renderer slot was invalid; restored the last-known-good renderer.".to_string(),
        ),
        None if !last_known_good_valid => {
            Some("Last-known-good renderer slot was invalid and was cleared.".to_string())
        }
        None => persisted.revision.last_failure.clone(),
    };
    persist_state_journal_with_floor(
        root,
        &persisted,
        active,
        last_known_good,
        reason,
        installed_highest_release_sequence,
    )
}

fn release_view(value: &RendererReleaseRef) -> RendererReleaseView {
    RendererReleaseView {
        release_id: value.release_id.clone(),
        release_sequence: value.release_sequence,
        version: value.version.clone(),
        channel: value.channel.clone(),
        manifest_sha256: value.manifest_sha256.clone(),
    }
}

fn renderer_root(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        if let Some(value) = std::env::var_os("SCR_RENDERER_UPDATE_ROOT") {
            return Ok(PathBuf::from(value));
        }
    }
    app.path()
        .app_data_dir()
        .map(|path| path.join(RENDERER_ROOT_DIRECTORY))
        .map_err(|error| format!("Could not resolve renderer update storage: {error}"))
}

fn renderer_trust_path(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        if let Some(value) = std::env::var_os("SCR_RENDERER_TRUSTED_KEYS_PATH") {
            return Ok(PathBuf::from(value));
        }
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(RENDERER_TRUST_RESOURCE));
    }
    app.path()
        .resource_dir()
        .map(|path| path.join(RENDERER_TRUST_RESOURCE))
        .map_err(|error| format!("Could not resolve renderer trust registry: {error}"))
}

impl RendererUpdateManager {
    pub fn isolated(app: &AppHandle) -> Result<Self, String> {
        let root = std::env::temp_dir().join(format!(
            "sovereign-renderer-isolated-{}-{}",
            std::process::id(),
            random_suffix()?
        ));
        let built_in_url = app
            .get_webview_window("main")
            .ok_or_else(|| "Main webview is unavailable for renderer updates.".to_string())?
            .url()
            .map_err(|error| format!("Could not capture the built-in renderer URL: {error}"))?;
        Self::from_parts(root, built_in_url, Vec::new(), false)
    }
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let root = renderer_root(app)?;
        fs::create_dir_all(root.join("inbox"))
            .map_err(|error| format!("Could not create renderer inbox: {error}"))?;
        fs::create_dir_all(root.join("slots"))
            .map_err(|error| format!("Could not create renderer slots: {error}"))?;
        let trust_bytes = read_bounded_file(
            &renderer_trust_path(app)?,
            MAX_TRUST_REGISTRY_BYTES,
            "Renderer trusted-key registry",
        )?;
        let trusted_keys = parse_trusted_key_registry(&trust_bytes)?;
        let built_in_url = app
            .get_webview_window("main")
            .ok_or_else(|| "Main webview is unavailable for renderer updates.".to_string())?
            .url()
            .map_err(|error| format!("Could not capture the built-in renderer URL: {error}"))?;
        Self::from_parts(root, built_in_url, trusted_keys, true)
    }

    fn from_parts(
        root: PathBuf,
        built_in_url: Url,
        trusted_keys: Vec<ParsedTrustedRendererKey>,
        release_guard_required: bool,
    ) -> Result<Self, String> {
        fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create renderer update storage: {error}"))?;
        ensure_directory_shape(&root, "Renderer update storage")?;
        let inbox_root = root.join("inbox");
        let slots_root = root.join("slots");
        fs::create_dir_all(&inbox_root)
            .map_err(|error| format!("Could not create renderer inbox: {error}"))?;
        fs::create_dir_all(&slots_root)
            .map_err(|error| format!("Could not create renderer slots: {error}"))?;
        ensure_directory_shape(&inbox_root, "Renderer inbox")?;
        ensure_directory_shape(&slots_root, "Renderer slots directory")?;
        let (persisted, recovered_from_corrupt_journal) = match load_state_journal(&root) {
            Ok(value) => (value, false),
            Err(error) => (quarantine_corrupt_state_journal(&root, error)?, true),
        };
        let (installed, problems) = load_installed_releases(&root, &trusted_keys)?;
        let problem = if problems.is_empty() {
            None
        } else {
            Some(bounded_error(problems.join("; ")))
        };
        let persisted = recover_persisted_state(
            &root,
            persisted,
            &installed,
            problem,
            recovered_from_corrupt_journal,
        )?;
        Ok(Self {
            inner: Arc::new(RendererUpdateInner {
                root,
                built_in_url,
                trusted_keys,
                release_guard_required,
                operation_lock: Mutex::new(()),
                state: Mutex::new(ManagerState {
                    persisted,
                    installed,
                    preflight_waits: HashMap::new(),
                    preflight_receipts: HashMap::new(),
                    activation: None,
                    handoff: None,
                    last_failure_recorded_at: None,
                }),
                readiness: Condvar::new(),
            }),
        })
    }

    fn verify_release_guard_against(
        &self,
        release: &RendererReleaseRef,
        revision: &RendererStateRevision,
    ) -> Result<(), String> {
        if !self.inner.release_guard_required || release.channel != "development" {
            return Ok(());
        }
        verify_renderer_release_guard(&self.inner.root, release, revision)
    }

    fn require_release_guard(&self, release: &RendererReleaseRef) -> Result<(), String> {
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
        self.verify_release_guard_against(release, &state.persisted.revision)
    }

    pub fn status(&self) -> RendererUpdateStatus {
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let active_release = state
            .persisted
            .revision
            .active_release
            .as_ref()
            .map(release_view);
        let last_known_good_release = state
            .persisted
            .revision
            .last_known_good_release
            .as_ref()
            .map(release_view);
        let installed_releases = state
            .installed
            .values()
            .map(|release| release_view(&release.release))
            .collect::<Vec<_>>();
        let mut preflighted_release_ids = state
            .preflight_receipts
            .iter()
            .filter(|(_, receipt)| {
                receipt.completed_at.elapsed() <= PREFLIGHT_RECEIPT_TTL
                    && state
                        .installed
                        .get(&receipt.release.release_id)
                        .is_some_and(|installed| installed.release == receipt.release)
            })
            .map(|(release_id, _)| release_id.clone())
            .collect::<Vec<_>>();
        preflighted_release_ids.sort();
        let pending_activation =
            state
                .activation
                .as_ref()
                .map(|activation| RendererActivationView {
                    release_id: activation
                        .expected_release
                        .as_ref()
                        .map(|release| release.release_id.clone()),
                    built_in: activation.expected_release.is_none(),
                    phase: activation.phase.clone(),
                    started_at_unix_ms: activation.started_at_unix_ms,
                });
        let last_failure = state.persisted.revision.last_failure.clone();
        let state_highest_release_sequence = state.persisted.revision.highest_release_sequence;
        drop(state);
        RendererUpdateStatus {
            schema_version: RENDERER_STATUS_SCHEMA_VERSION,
            enabled: !self.inner.trusted_keys.is_empty(),
            shell_version: SHELL_VERSION,
            bridge_api_version: RENDERER_BRIDGE_API_VERSION,
            trusted_key_count: self.inner.trusted_keys.len(),
            highest_release_sequence: state_highest_release_sequence,
            built_in_active: active_release.is_none(),
            active_release,
            last_known_good_release,
            installed_releases,
            inbox_release_ids: self.inbox_release_ids(),
            preflighted_release_ids,
            pending_activation,
            last_failure,
        }
    }

    fn inbox_release_ids(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.inner.root.join("inbox")) else {
            return Vec::new();
        };
        let mut values = entries
            .take(MAX_INBOX_RELEASES * 4)
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                let metadata = fs::symlink_metadata(entry.path()).ok()?;
                if is_valid_identifier(&name)
                    && metadata.is_dir()
                    && reject_reparse_point(&metadata, "Renderer inbox release").is_ok()
                {
                    Some(name)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        values.sort();
        values.truncate(MAX_INBOX_RELEASES);
        values
    }

    pub fn install(&self, release_id: &str) -> Result<RendererUpdateStatus, String> {
        let _operation = self
            .inner
            .operation_lock
            .lock()
            .map_err(|_| "Renderer update operation lock is poisoned.".to_string())?;
        ensure_directory_shape(&self.inner.root, "Renderer update storage")?;
        ensure_directory_shape(&self.inner.root.join("inbox"), "Renderer inbox")?;
        ensure_directory_shape(&self.inner.root.join("slots"), "Renderer slots directory")?;
        let (verified, bundle_root, envelope_bytes) =
            verify_inbox_release(&self.inner.root, release_id, &self.inner.trusted_keys)?;
        let candidate_ref = release_ref(&verified);
        let already_installed = {
            let state = self
                .inner
                .state
                .lock()
                .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
            match state.installed.get(release_id) {
                Some(existing) if existing.release == candidate_ref => true,
                Some(_) => {
                    return Err(
                        "Renderer release ID is already installed with different content.".into(),
                    );
                }
                None => {
                    if candidate_ref.release_sequence
                        <= state.persisted.revision.highest_release_sequence
                    {
                        return Err(
                            "Renderer release sequence must be newer than every previously accepted renderer."
                                .into(),
                        );
                    }
                    false
                }
            }
        };
        if already_installed {
            return Ok(self.status());
        }
        self.require_release_guard(&candidate_ref)?;

        let slots_root = self.inner.root.join("slots");
        let staging_root = slots_root.join(format!(".install-{release_id}-{}", random_suffix()?));
        fs::create_dir(&staging_root)
            .map_err(|error| format!("Could not create renderer staging slot: {error}"))?;
        let install_result = (|| {
            for component in &verified.envelope.manifest.components {
                let relative =
                    PathBuf::from(component.path.replace('/', std::path::MAIN_SEPARATOR_STR));
                copy_component(
                    &bundle_root.join(&relative),
                    &staging_root.join(&relative),
                    component,
                )?;
            }
            let metadata_root = staging_root.join(RENDERER_METADATA_DIRECTORY);
            fs::create_dir(&metadata_root)
                .map_err(|error| format!("Could not create renderer slot metadata: {error}"))?;
            let mut envelope_file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(metadata_root.join(RENDERER_ENVELOPE_FILE))
                .map_err(|error| format!("Could not create renderer slot envelope: {error}"))?;
            envelope_file
                .write_all(&envelope_bytes)
                .map_err(|error| format!("Could not write renderer slot envelope: {error}"))?;
            envelope_file
                .sync_all()
                .map_err(|error| format!("Could not flush renderer slot envelope: {error}"))?;
            let ready = RendererReadyMarker {
                schema_version: RENDERER_READY_SCHEMA_VERSION.to_string(),
                release: candidate_ref.clone(),
                installed_at_unix_ms: now_unix_ms(),
            };
            let mut ready_bytes = canonical_json(&ready)?;
            ready_bytes.push(b'\n');
            let mut ready_file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(metadata_root.join(RENDERER_READY_FILE))
                .map_err(|error| format!("Could not create renderer ready marker: {error}"))?;
            ready_file
                .write_all(&ready_bytes)
                .map_err(|error| format!("Could not write renderer ready marker: {error}"))?;
            ready_file
                .sync_all()
                .map_err(|error| format!("Could not flush renderer ready marker: {error}"))?;
            drop(envelope_file);
            drop(ready_file);
            verify_slot_release(&staging_root, release_id, &self.inner.trusted_keys)?;
            let final_root = slots_root.join(release_id);
            fs::rename(&staging_root, &final_root)
                .map_err(|error| format!("Could not publish renderer slot: {error}"))?;
            match verify_slot_release(&final_root, release_id, &self.inner.trusted_keys) {
                Ok(value) => Ok(value),
                Err(error) => {
                    cleanup_staged_renderer_slot(&final_root, &verified.envelope.manifest);
                    Err(error)
                }
            }
        })();
        let installed = match install_result {
            Ok(value) => value,
            Err(error) => {
                cleanup_staged_renderer_slot(&staging_root, &verified.envelope.manifest);
                return Err(error);
            }
        };
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
        state.installed.insert(release_id.to_string(), installed);
        drop(state);
        Ok(self.status())
    }
}
fn component_path(root: &Path, relative: &str) -> PathBuf {
    root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
}

fn read_verified_component(
    installed: &InstalledRendererRelease,
    component: &RendererReleaseComponent,
) -> Result<Vec<u8>, String> {
    let path = component_path(&installed.slot_root, &component.path);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Could not inspect renderer component: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() != component.bytes {
        return Err("Renderer component byte length does not match its manifest.".into());
    }
    reject_reparse_point(&metadata, "Renderer component")?;
    let mut file =
        File::open(&path).map_err(|error| format!("Could not open renderer component: {error}"))?;
    reject_shared_file(&file, "Renderer component")?;
    let mut bytes = Vec::with_capacity(component.bytes as usize);
    std::io::Read::by_ref(&mut file)
        .take(component.bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read renderer component: {error}"))?;
    if bytes.len() as u64 != component.bytes {
        return Err("Renderer component changed while it was being read.".into());
    }
    if sha256_bytes(&bytes) != component.sha256 {
        return Err("Renderer component failed its signed SHA-256 check.".into());
    }
    let after = file
        .metadata()
        .map_err(|error| format!("Could not re-check renderer component: {error}"))?;
    if after.len() != component.bytes {
        return Err("Renderer component changed after it was read.".into());
    }
    Ok(bytes)
}

fn content_type(path: &str) -> &'static str {
    let extension = path
        .rsplit_once('.')
        .map(|(_, value)| value.to_ascii_lowercase());
    match extension.as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn valid_activation_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn renderer_navigation_query_allowed(webview_label: &str, url: &Url) -> bool {
    let pairs = url
        .query_pairs()
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    if pairs.is_empty() {
        return true;
    }
    if webview_label == "main" {
        return pairs.len() == 1
            && pairs[0].0 == "rendererActivation"
            && valid_activation_id(&pairs[0].1);
    }
    if webview_label.starts_with("renderer-preflight-") && webview_label.len() <= 128 {
        return pairs.len() == 2
            && pairs
                .iter()
                .any(|(name, value)| name == "rendererPreflight" && value == "1")
            && pairs
                .iter()
                .any(|(name, value)| name == "preflightLabel" && value == webview_label);
    }
    false
}

fn is_builtin_renderer_navigation(webview_label: &str, url: &Url) -> bool {
    let production_local = (url.scheme() == "http" || url.scheme() == "https")
        && url.host_str() == Some("tauri.localhost")
        && url.port().is_none();
    let custom_protocol_local =
        url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none();
    let development_local = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1430);
    (production_local || custom_protocol_local || development_local)
        && matches!(url.path(), "/" | "/index.html")
        && renderer_navigation_query_allowed(webview_label, url)
}

fn is_custom_renderer_navigation(webview_label: &str, url: &Url) -> bool {
    let native_protocol = url.scheme() == RENDERER_PROTOCOL_SCHEME
        && url.host_str() == Some("localhost")
        && url.port().is_none();
    let windows_protocol = url.scheme() == "http"
        && url.host_str() == Some(RENDERER_WINDOWS_PROTOCOL_HOST)
        && url.port().is_none();
    (native_protocol || windows_protocol)
        && parse_protocol_path(url.path()).is_ok_and(|(_, component)| component == "index.html")
        && renderer_navigation_query_allowed(webview_label, url)
}

pub fn navigation_allowed(webview_label: &str, url: &Url) -> bool {
    if webview_label == "main" {
        return is_builtin_renderer_navigation(webview_label, url)
            || is_custom_renderer_navigation(webview_label, url);
    }
    if webview_label.starts_with("renderer-preflight-") && webview_label.len() <= 128 {
        return is_custom_renderer_navigation(webview_label, url);
    }
    true
}

fn webview_navigation_url(url: Url) -> Result<Url, String> {
    #[cfg(windows)]
    if url.scheme() == RENDERER_PROTOCOL_SCHEME {
        if url.host_str() != Some("localhost") || url.port().is_some() {
            return Err("Renderer navigation URL is not canonical.".into());
        }
        let mut translated = Url::parse(&format!("http://{RENDERER_WINDOWS_PROTOCOL_HOST}/"))
            .map_err(|error| format!("Could not construct renderer WebView URL: {error}"))?;
        translated.set_path(url.path());
        translated.set_query(url.query());
        translated.set_fragment(url.fragment());
        return Ok(translated);
    }
    Ok(url)
}

fn navigate_webview_window(window: &tauri::WebviewWindow, url: Url) -> Result<(), String> {
    window
        .navigate(webview_navigation_url(url)?)
        .map_err(|error| error.to_string())
}

fn protocol_error(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(bounded_error(message).into_bytes())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn parse_protocol_path(path: &str) -> Result<(String, String), String> {
    if path.contains('%') || path.contains('\\') || path.contains('\0') {
        return Err("Renderer protocol path contains unsupported encoding.".into());
    }
    let remaining = path
        .strip_prefix("/release/")
        .ok_or_else(|| "Renderer protocol path is outside the release namespace.".to_string())?;
    let (release_id, component) = remaining
        .split_once('/')
        .ok_or_else(|| "Renderer protocol path is incomplete.".to_string())?;
    if !is_valid_identifier(release_id) {
        return Err("Renderer protocol release ID is invalid.".into());
    }
    Ok((release_id.to_string(), validate_component_path(component)?))
}

impl RendererUpdateManager {
    fn renderer_url(&self, release_id: &str) -> Result<Url, String> {
        if !is_valid_identifier(release_id) {
            return Err("Renderer release ID has an invalid shape.".into());
        }
        Url::parse(&format!(
            "{RENDERER_PROTOCOL_SCHEME}://localhost/release/{release_id}/index.html"
        ))
        .map_err(|error| format!("Could not construct renderer release URL: {error}"))
    }

    fn target_url(&self, release: Option<&RendererReleaseRef>) -> Result<Url, String> {
        match release {
            Some(value) => self.renderer_url(&value.release_id),
            None => Ok(self.inner.built_in_url.clone()),
        }
    }

    fn activation_url(
        &self,
        release: Option<&RendererReleaseRef>,
        activation_id: &str,
    ) -> Result<Url, String> {
        if !valid_activation_id(activation_id) {
            return Err("Renderer activation ID is invalid.".into());
        }
        let mut url = self.target_url(release)?;
        url.query_pairs_mut()
            .append_pair("rendererActivation", activation_id);
        Ok(url)
    }

    pub fn navigation_authorized(&self, webview_label: &str, url: &Url) -> bool {
        if !navigation_allowed(webview_label, url) {
            return false;
        }
        if webview_label != "main"
            && !(webview_label.starts_with("renderer-preflight-") && webview_label.len() <= 128)
        {
            return true;
        }
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let activation_query = url
            .query_pairs()
            .find(|(name, _)| name == "rendererActivation")
            .map(|(_, value)| value.into_owned());
        if webview_label == "main" && is_builtin_renderer_navigation(webview_label, url) {
            return match activation_query.as_deref() {
                Some(activation_id) => state.activation.as_ref().is_some_and(|activation| {
                    activation.activation_id == activation_id
                        && activation.expected_release.is_none()
                }),
                None => {
                    state.activation.is_none() && state.persisted.revision.active_release.is_none()
                }
            };
        }
        let Ok((release_id, component)) = parse_protocol_path(url.path()) else {
            return false;
        };
        if component != "index.html" {
            return false;
        }
        if webview_label == "main" {
            return match activation_query.as_deref() {
                Some(activation_id) => state.activation.as_ref().is_some_and(|activation| {
                    activation.activation_id == activation_id
                        && activation
                            .expected_release
                            .as_ref()
                            .is_some_and(|release| release.release_id == release_id)
                }),
                None => {
                    state.activation.is_none()
                        && state
                            .persisted
                            .revision
                            .active_release
                            .as_ref()
                            .is_some_and(|release| release.release_id == release_id)
                }
            };
        }
        state
            .preflight_waits
            .get(webview_label)
            .is_some_and(|wait| wait.expected_release_id == release_id)
    }

    pub fn protocol_response(
        &self,
        webview_label: &str,
        request: Request<Vec<u8>>,
    ) -> Response<Vec<u8>> {
        if request.method() != Method::GET && request.method() != Method::HEAD {
            return protocol_error(
                StatusCode::METHOD_NOT_ALLOWED,
                "Renderer protocol accepts GET and HEAD only.",
            );
        }
        let (release_id, component_path) = match parse_protocol_path(request.uri().path()) {
            Ok(value) => value,
            Err(error) => return protocol_error(StatusCode::NOT_FOUND, &error),
        };
        let installed = {
            let state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let authorized = if webview_label == "main" {
                state
                    .persisted
                    .revision
                    .active_release
                    .as_ref()
                    .is_some_and(|release| release.release_id == release_id)
            } else {
                state
                    .preflight_waits
                    .get(webview_label)
                    .is_some_and(|wait| wait.expected_release_id == release_id)
            };
            if !authorized {
                return protocol_error(
                    StatusCode::FORBIDDEN,
                    "Renderer release is not authorized for this webview.",
                );
            }
            state.installed.get(&release_id).cloned()
        };
        let Some(installed) = installed else {
            return protocol_error(StatusCode::NOT_FOUND, "Renderer release is not installed.");
        };
        let component = installed
            .manifest
            .components
            .iter()
            .find(|candidate| candidate.path == component_path)
            .cloned();
        let Some(component) = component else {
            return protocol_error(
                StatusCode::NOT_FOUND,
                "Renderer component is not in the signed manifest.",
            );
        };
        let bytes = match read_verified_component(&installed, &component) {
            Ok(bytes) => bytes,
            Err(error) => {
                self.record_failure(format!(
                    "Blocked renderer component {} from {}: {error}",
                    component.path, installed.release.release_id
                ));
                return protocol_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Renderer component integrity check failed.",
                );
            }
        };
        let mut builder = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type(&component.path))
            .header("x-content-type-options", "nosniff")
            .header("referrer-policy", "no-referrer")
            .header("cross-origin-resource-policy", "same-origin")
            .header(header::CONTENT_LENGTH, bytes.len().to_string());
        if component.path.ends_with(".html") {
            builder = builder
                .header(header::CACHE_CONTROL, "no-store")
                .header("content-security-policy", CSP_HEADER_VALUE);
        } else {
            builder = builder.header(header::CACHE_CONTROL, "public, max-age=31536000, immutable");
        }
        builder
            .body(if request.method() == Method::HEAD {
                Vec::new()
            } else {
                bytes
            })
            .unwrap_or_else(|_| {
                protocol_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not build renderer response.",
                )
            })
    }

    fn record_failure(&self, reason: impl Into<String>) {
        let reason = bounded_error(reason);
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.persisted.revision.last_failure.as_deref() == Some(reason.as_str())
            || state
                .last_failure_recorded_at
                .is_some_and(|recorded| recorded.elapsed() < FAILURE_PERSIST_INTERVAL)
        {
            return;
        }
        if let Ok(persisted) = persist_state_journal(
            &self.inner.root,
            &state.persisted,
            state.persisted.revision.active_release.clone(),
            state.persisted.revision.last_known_good_release.clone(),
            Some(reason),
        ) {
            state.persisted = persisted;
            state.last_failure_recorded_at = Some(Instant::now());
        }
    }
}
fn validate_handoff(value: &RendererHandoff) -> Result<(), String> {
    if value.schema_version != RENDERER_HANDOFF_SCHEMA_VERSION {
        return Err("Unsupported renderer handoff schema version.".into());
    }
    if value.view.as_ref().is_some_and(|view| {
        !matches!(
            view.as_str(),
            "overview"
                | "tasks"
                | "agent"
                | "runs"
                | "settings"
                | "terminal"
                | "python"
                | "browser"
                | "computer"
                | "workflows"
        )
    }) {
        return Err("Renderer handoff view is invalid.".into());
    }
    if value.settings_tab.as_ref().is_some_and(|tab| {
        !matches!(
            tab.as_str(),
            "appearance" | "host" | "security" | "diagnostics"
        )
    }) {
        return Err("Renderer handoff settings tab is invalid.".into());
    }
    if value.scroll_top > 10_000_000 {
        return Err("Renderer handoff scroll position exceeds its limit.".into());
    }
    if canonical_json(value)?.len() > MAX_HANDOFF_BYTES {
        return Err("Renderer handoff exceeds its size limit.".into());
    }
    Ok(())
}

fn parse_ready_payload(payload: &Value) -> Result<(Option<String>, u64), String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "Renderer readiness payload must be an object.".to_string())?;
    let release_id = match object.get("rendererReleaseId") {
        Some(Value::String(value)) if is_valid_identifier(value) => Some(value.clone()),
        Some(Value::Null) => None,
        _ => return Err("Renderer readiness release ID is invalid.".into()),
    };
    let bridge_api_version = object
        .get("rendererBridgeApiVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Renderer readiness bridge API version is invalid.".to_string())?;
    if bridge_api_version != RENDERER_BRIDGE_API_VERSION {
        return Err("Renderer readiness bridge API version is incompatible.".into());
    }
    let app_child_count = object
        .get("appChildCount")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Renderer readiness app child count is invalid.".to_string())?;
    if app_child_count == 0 || app_child_count > 100_000 {
        return Err("Renderer readiness did not render an application surface.".into());
    }
    for field in ["href", "title"] {
        let value = object
            .get(field)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Renderer readiness {field} is invalid."))?;
        if value.is_empty() || value.len() > 2_048 || value.contains(['\r', '\n', '\0']) {
            return Err(format!("Renderer readiness {field} is invalid."));
        }
    }
    Ok((release_id, bridge_api_version))
}

impl RendererUpdateManager {
    fn installed_release(&self, release_id: &str) -> Result<InstalledRendererRelease, String> {
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
        state
            .installed
            .get(release_id)
            .cloned()
            .ok_or_else(|| "Renderer release is not installed.".to_string())
    }

    pub fn assert_active_preflight_window(&self, window_label: &str) -> Result<(), String> {
        if !window_label.starts_with("renderer-preflight-") || window_label.len() > 128 {
            return Err(
                "Renderer preflight command is restricted to a managed hidden preflight webview."
                    .into(),
            );
        }
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
        if state.preflight_waits.contains_key(window_label) {
            Ok(())
        } else {
            Err("Renderer preflight webview is no longer active.".into())
        }
    }

    pub fn begin_preflight(
        &self,
        app: &AppHandle,
        release_id: &str,
    ) -> Result<RendererPreflightTicket, String> {
        let _operation = self
            .inner
            .operation_lock
            .lock()
            .map_err(|_| "Renderer update operation lock is poisoned.".to_string())?;
        let installed = self.installed_release(release_id)?;
        let verified =
            verify_slot_release(&installed.slot_root, release_id, &self.inner.trusted_keys)?;
        if verified.release != installed.release {
            return Err("Renderer slot changed before preflight.".into());
        }
        self.require_release_guard(&installed.release)?;
        let label = format!("renderer-preflight-{}", random_suffix()?);
        {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
            state.preflight_waits.insert(
                label.clone(),
                PreflightWait {
                    expected_release_id: release_id.to_string(),
                    result: None,
                },
            );
        }
        let mut url = self.renderer_url(release_id)?;
        url.query_pairs_mut()
            .append_pair("rendererPreflight", "1")
            .append_pair("preflightLabel", &label);
        let build = WebviewWindowBuilder::new(app, &label, WebviewUrl::CustomProtocol(url))
            .title("Sovereign renderer preflight")
            .visible(false)
            .skip_taskbar(true)
            .focused(false)
            .build();
        if let Err(error) = build {
            let mut state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.preflight_waits.remove(&label);
            return Err(format!(
                "Could not create renderer preflight webview: {error}"
            ));
        }
        Ok(RendererPreflightTicket {
            label,
            release_id: release_id.to_string(),
        })
    }

    pub fn await_preflight(
        &self,
        app: &AppHandle,
        ticket: RendererPreflightTicket,
    ) -> Result<RendererUpdateStatus, String> {
        let deadline = Instant::now() + PREFLIGHT_TIMEOUT;
        let result = {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
            loop {
                let current = state
                    .preflight_waits
                    .get(&ticket.label)
                    .ok_or_else(|| "Renderer preflight ticket is no longer active.".to_string())?;
                if let Some(result) = current.result.clone() {
                    state.preflight_waits.remove(&ticket.label);
                    break result;
                }
                let now = Instant::now();
                if now >= deadline {
                    state.preflight_waits.remove(&ticket.label);
                    break Err("Renderer preflight timed out before readiness.".into());
                }
                let wait = deadline.saturating_duration_since(now);
                let (next_state, timeout) = self
                    .inner
                    .readiness
                    .wait_timeout(state, wait)
                    .map_err(|_| "Renderer preflight wait lock is poisoned.".to_string())?;
                state = next_state;
                if timeout.timed_out() {
                    state.preflight_waits.remove(&ticket.label);
                    break Err("Renderer preflight timed out before readiness.".into());
                }
            }
        };
        if let Some(window) = app.get_webview_window(&ticket.label) {
            let _ = window.close();
        }
        match result {
            Ok(()) => {
                let installed = self.installed_release(&ticket.release_id)?;
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
                state.preflight_receipts.insert(
                    ticket.release_id,
                    PreflightReceipt {
                        release: installed.release,
                        completed_at: Instant::now(),
                    },
                );
                drop(state);
                Ok(self.status())
            }
            Err(error) => {
                self.record_failure(format!(
                    "Renderer preflight failed for {}: {error}",
                    ticket.release_id
                ));
                Err(error)
            }
        }
    }

    pub fn record_ui_ready(
        &self,
        window: &tauri::WebviewWindow,
        payload: &Value,
    ) -> Result<(), String> {
        let label = window.label().to_string();
        let record = payload
            .as_object()
            .ok_or_else(|| "Renderer readiness payload must be an object.".to_string())?;
        let payload_label = record
            .get("windowLabel")
            .and_then(Value::as_str)
            .ok_or_else(|| "Renderer readiness window label is invalid.".to_string())?;
        if payload_label != label {
            return Err("Renderer readiness window label does not match its sender.".into());
        }
        let release_id = match record.get("rendererReleaseId") {
            Some(Value::String(value)) if is_valid_identifier(value) => Some(value.clone()),
            Some(Value::Null) => None,
            _ => return Err("Renderer readiness release ID is invalid.".into()),
        };
        let activation_id = match record.get("rendererActivationId") {
            Some(Value::String(value)) if valid_activation_id(value) => Some(value.clone()),
            Some(Value::Null) => None,
            _ => return Err("Renderer readiness activation ID is invalid.".into()),
        };
        let bridge_api_version = record
            .get("rendererBridgeApiVersion")
            .and_then(Value::as_u64)
            .ok_or_else(|| "Renderer readiness bridge API version is invalid.".to_string())?;
        if bridge_api_version != RENDERER_BRIDGE_API_VERSION {
            return Err("Renderer readiness bridge API version is incompatible.".into());
        }
        let startup_error = match record.get("startupError") {
            Some(Value::Null) | None => None,
            Some(Value::String(value))
                if !value.is_empty()
                    && value.len() <= 1_024
                    && !value.contains(['\r', '\n', '\0']) =>
            {
                Some(value.clone())
            }
            _ => return Err("Renderer readiness startup error is invalid.".into()),
        };

        if let Some(startup_error) = startup_error {
            let reason = bounded_error(format!("Renderer startup failed: {startup_error}"));
            let rollback_target = {
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
                if let Some(wait) = state.preflight_waits.get_mut(&label) {
                    wait.result = Some(Err(if activation_id.is_some() {
                        "Renderer preflight reported an unexpected activation ID.".into()
                    } else if release_id.as_deref() == Some(wait.expected_release_id.as_str()) {
                        reason
                    } else {
                        "Renderer preflight failed and loaded a different release than requested."
                            .into()
                    }));
                    self.inner.readiness.notify_all();
                    return Ok(());
                }
                if label != "main" {
                    return Err(reason);
                }
                let activation = state.activation.clone().ok_or_else(|| reason.clone())?;
                if activation_id.as_deref() != Some(activation.activation_id.as_str()) {
                    return Err(
                        "Renderer readiness activation ID does not match the pending activation."
                            .into(),
                    );
                }
                let expected_release_id = activation
                    .expected_release
                    .as_ref()
                    .map(|release| release.release_id.as_str());
                let activation_reason = if release_id.as_deref() == expected_release_id {
                    reason
                } else {
                    "Pending renderer activation failed and reported a different release ID.".into()
                };
                let rollback_target = activation.rollback_active.clone();
                let persisted = persist_state_journal(
                    &self.inner.root,
                    &state.persisted,
                    rollback_target.clone(),
                    activation.rollback_last_known_good.clone(),
                    Some(activation_reason.clone()),
                )?;
                state.persisted = persisted;
                state.activation = None;
                (rollback_target, activation_reason)
            };
            let url = self.target_url(rollback_target.0.as_ref())?;
            navigate_webview_window(window, url)
                .map_err(|error| format!("Could not navigate to renderer rollback: {error}"))?;
            let _ = window.show();
            return Err(rollback_target.1);
        }

        let (parsed_release_id, _) = parse_ready_payload(payload)?;
        if parsed_release_id != release_id {
            return Err("Renderer readiness identity changed during validation.".into());
        }
        let mut show_window = false;
        {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
            if let Some(wait) = state.preflight_waits.get_mut(&label) {
                wait.result = Some(if activation_id.is_some() {
                    Err("Renderer preflight reported an unexpected activation ID.".into())
                } else if release_id.as_deref() == Some(wait.expected_release_id.as_str()) {
                    Ok(())
                } else {
                    Err("Renderer preflight loaded a different release than requested.".into())
                });
                self.inner.readiness.notify_all();
                return Ok(());
            }
            if label != "main" {
                return Err("Renderer preflight webview is no longer active.".into());
            }
            if label == "main" {
                if let Some(activation) = state.activation.as_ref() {
                    if activation_id.as_deref() != Some(activation.activation_id.as_str()) {
                        return Err(
                            "Renderer readiness activation ID does not match the pending activation."
                                .into(),
                        );
                    }
                    let expected_release_id = activation
                        .expected_release
                        .as_ref()
                        .map(|release| release.release_id.as_str());
                    if release_id.as_deref() != expected_release_id {
                        return Err(
                            "Main renderer readiness does not match the pending activation.".into(),
                        );
                    }
                    show_window = activation.show_after_ready;
                    state.activation = None;
                    state.handoff = None;
                } else {
                    if activation_id.is_some() {
                        return Err(
                            "Renderer readiness reported an activation ID without a pending activation."
                                .into(),
                        );
                    }
                    let expected = state
                        .persisted
                        .revision
                        .active_release
                        .as_ref()
                        .map(|value| value.release_id.as_str());
                    if release_id.as_deref() != expected {
                        return Err(
                            "Main renderer readiness does not match persisted state.".into()
                        );
                    }
                    state.handoff = None;
                }
            }
        }
        if show_window {
            window
                .show()
                .map_err(|error| format!("Could not show the activated renderer: {error}"))?;
        }
        Ok(())
    }
    fn begin_activation_guard(
        &self,
        expected_release: Option<RendererReleaseRef>,
        rollback_active: Option<RendererReleaseRef>,
        rollback_last_known_good: Option<RendererReleaseRef>,
        phase: &str,
        show_after_ready: bool,
    ) -> Result<String, String> {
        let activation_id = random_suffix()?;
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
        if state.activation.is_some() {
            return Err("Another renderer activation is already pending.".into());
        }
        state.activation = Some(ActivationGuard {
            activation_id: activation_id.clone(),
            expected_release,
            rollback_active,
            rollback_last_known_good,
            phase: phase.to_string(),
            started_at: Instant::now(),
            started_at_unix_ms: now_unix_ms(),
            show_after_ready,
        });
        Ok(activation_id)
    }

    fn spawn_activation_timeout(&self, app: AppHandle, activation_id: String) {
        let manager = self.clone();
        thread::spawn(move || {
            thread::sleep(ACTIVATION_READY_TIMEOUT);
            manager.handle_activation_timeout(&app, &activation_id);
        });
    }

    fn handle_activation_timeout(&self, app: &AppHandle, activation_id: &str) {
        let rollback = {
            let _operation = match self.inner.operation_lock.lock() {
                Ok(value) => value,
                Err(_) => return,
            };
            let mut state = match self.inner.state.lock() {
                Ok(value) => value,
                Err(poisoned) => poisoned.into_inner(),
            };
            let Some(activation) = state.activation.as_ref() else {
                return;
            };
            if activation.activation_id != activation_id
                || activation.started_at.elapsed() < ACTIVATION_READY_TIMEOUT
            {
                return;
            }
            let expected_label = activation
                .expected_release
                .as_ref()
                .map(|release| release.release_id.clone())
                .unwrap_or_else(|| "built-in".to_string());
            let rollback_active = activation.rollback_active.clone();
            let rollback_last_known_good = activation.rollback_last_known_good.clone();
            let persisted = match persist_state_journal(
                &self.inner.root,
                &state.persisted,
                rollback_active.clone(),
                rollback_last_known_good,
                Some(format!(
                    "Renderer activation for {expected_label} timed out and was rolled back."
                )),
            ) {
                Ok(value) => value,
                Err(_) => return,
            };
            state.persisted = persisted;
            state.activation = None;
            rollback_active
        };
        if let Ok(url) = self.target_url(rollback.as_ref()) {
            if let Some(window) = app.get_webview_window("main") {
                let _ = navigate_webview_window(&window, url);
                let _ = window.show();
            }
        }
    }

    fn restore_pending_activation(
        &self,
        activation_id: &str,
        reason: impl Into<String>,
        clear_handoff: bool,
    ) -> Result<Option<RendererReleaseRef>, String> {
        let reason = bounded_error(reason);
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
        let activation = state
            .activation
            .as_ref()
            .filter(|activation| activation.activation_id == activation_id)
            .cloned()
            .ok_or_else(|| "Renderer activation is no longer pending.".to_string())?;
        let rollback_active = activation.rollback_active.clone();
        let persisted = persist_state_journal(
            &self.inner.root,
            &state.persisted,
            rollback_active.clone(),
            activation.rollback_last_known_good,
            Some(reason),
        )?;
        state.persisted = persisted;
        state.activation = None;
        if clear_handoff {
            state.handoff = None;
        }
        Ok(rollback_active)
    }

    pub fn activate(
        &self,
        app: &AppHandle,
        release_id: &str,
        handoff: Option<RendererHandoff>,
    ) -> Result<RendererUpdateStatus, String> {
        if let Some(value) = handoff.as_ref() {
            validate_handoff(value)?;
        }
        let _operation = self
            .inner
            .operation_lock
            .lock()
            .map_err(|_| "Renderer update operation lock is poisoned.".to_string())?;
        let installed = self.installed_release(release_id)?;
        let reverified =
            verify_slot_release(&installed.slot_root, release_id, &self.inner.trusted_keys)?;
        if reverified.release != installed.release {
            return Err("Renderer slot changed before activation.".into());
        }
        let already_active = {
            let state = self
                .inner
                .state
                .lock()
                .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
            if state.activation.is_some() {
                return Err("Another renderer activation is already pending.".into());
            }
            state.persisted.revision.active_release.as_ref() == Some(&installed.release)
        };
        if already_active {
            return Ok(self.status());
        }

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main webview is unavailable for renderer activation.".to_string())?;
        let activation_id = random_suffix()?;
        let url = self.activation_url(Some(&installed.release), &activation_id)?;
        {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
            if state.activation.is_some() {
                return Err("Another renderer activation is already pending.".into());
            }
            state
                .preflight_receipts
                .retain(|_, receipt| receipt.completed_at.elapsed() <= PREFLIGHT_RECEIPT_TTL);
            let receipt_release = state
                .preflight_receipts
                .get(release_id)
                .map(|receipt| receipt.release.clone())
                .ok_or_else(|| {
                    "Renderer release requires a fresh successful preflight.".to_string()
                })?;
            if receipt_release != installed.release {
                return Err(
                    "Renderer preflight receipt no longer matches the installed slot.".into(),
                );
            }
            self.verify_release_guard_against(&installed.release, &state.persisted.revision)?;
            if installed.release.release_sequence
                <= state.persisted.revision.highest_release_sequence
            {
                return Err(
                    "Renderer release sequence must be newer than every previously accepted renderer."
                        .into(),
                );
            }
            let rollback_active = state.persisted.revision.active_release.clone();
            let rollback_last_known_good = state.persisted.revision.last_known_good_release.clone();
            let persisted = persist_state_journal(
                &self.inner.root,
                &state.persisted,
                Some(installed.release.clone()),
                rollback_active.clone(),
                None,
            )?;
            state.persisted = persisted;
            state.preflight_receipts.remove(release_id);
            state.handoff = handoff;
            state.activation = Some(ActivationGuard {
                activation_id: activation_id.clone(),
                expected_release: Some(installed.release.clone()),
                rollback_active: rollback_active.clone(),
                rollback_last_known_good: rollback_last_known_good.clone(),
                phase: "activating".to_string(),
                started_at: Instant::now(),
                started_at_unix_ms: now_unix_ms(),
                show_after_ready: false,
            });
        }

        if let Err(error) = navigate_webview_window(&window, url) {
            let reason = format!("Renderer navigation failed and was rolled back: {error}");
            let restored = self.restore_pending_activation(&activation_id, &reason, true);
            if let Ok(target) = restored.as_ref() {
                if let Ok(rollback_url) = self.target_url(target.as_ref()) {
                    let _ = navigate_webview_window(&window, rollback_url);
                    let _ = window.show();
                }
            }
            return match restored {
                Ok(_) => Err(format!("Could not navigate to renderer release: {error}")),
                Err(rollback_error) => Err(format!(
                    "Could not navigate to renderer release: {error}; renderer state rollback failed: {rollback_error}"
                )),
            };
        }
        self.spawn_activation_timeout(app.clone(), activation_id);
        Ok(self.status())
    }

    pub fn rollback(
        &self,
        app: &AppHandle,
        handoff: Option<RendererHandoff>,
    ) -> Result<RendererUpdateStatus, String> {
        if let Some(value) = handoff.as_ref() {
            validate_handoff(value)?;
        }
        let _operation = self
            .inner
            .operation_lock
            .lock()
            .map_err(|_| "Renderer update operation lock is poisoned.".to_string())?;
        let (previous_active, previous_last_known_good, target) = {
            let state = self
                .inner
                .state
                .lock()
                .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
            if state.activation.is_some() {
                return Err("Another renderer activation is already pending.".into());
            }
            let previous_active = state
                .persisted
                .revision
                .active_release
                .clone()
                .ok_or_else(|| "The built-in renderer is already active.".to_string())?;
            let previous_last_known_good = state.persisted.revision.last_known_good_release.clone();
            let target = previous_last_known_good.clone();
            if target.as_ref() == Some(&previous_active) {
                return Err("No distinct last-known-good renderer is available.".into());
            }
            if let Some(value) = target.as_ref() {
                if !release_matches_installed(value, &state.installed) {
                    return Err("Last-known-good renderer slot is unavailable.".into());
                }
            }
            (previous_active, previous_last_known_good, target)
        };

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main webview is unavailable for renderer rollback.".to_string())?;
        let activation_id = random_suffix()?;
        let url = self.activation_url(target.as_ref(), &activation_id)?;
        {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
            if state.activation.is_some()
                || state.persisted.revision.active_release.as_ref() != Some(&previous_active)
                || state.persisted.revision.last_known_good_release != previous_last_known_good
            {
                return Err("Renderer state changed before rollback publication.".into());
            }
            let persisted = persist_state_journal(
                &self.inner.root,
                &state.persisted,
                target.clone(),
                None,
                Some("Renderer rollback was requested locally.".into()),
            )?;
            state.persisted = persisted;
            state.handoff = handoff;
            state.activation = Some(ActivationGuard {
                activation_id: activation_id.clone(),
                expected_release: target.clone(),
                rollback_active: Some(previous_active.clone()),
                rollback_last_known_good: previous_last_known_good.clone(),
                phase: "rollback".to_string(),
                started_at: Instant::now(),
                started_at_unix_ms: now_unix_ms(),
                show_after_ready: false,
            });
        }

        let navigation_result = navigate_webview_window(&window, url)
            .and_then(|_| window.show().map_err(|error| error.to_string()));
        if let Err(error) = navigation_result {
            let reason = format!("Renderer rollback navigation failed: {error}");
            let restored = self.restore_pending_activation(&activation_id, &reason, true);
            if let Ok(previous) = restored.as_ref() {
                if let Ok(previous_url) = self.target_url(previous.as_ref()) {
                    let _ = navigate_webview_window(&window, previous_url);
                    let _ = window.show();
                }
            }
            return match restored {
                Ok(_) => Err(format!("Could not navigate to the rollback renderer: {error}")),
                Err(restore_error) => Err(format!(
                    "Could not navigate to the rollback renderer: {error}; previous renderer state restoration failed: {restore_error}"
                )),
            };
        }
        self.spawn_activation_timeout(app.clone(), activation_id);
        Ok(self.status())
    }

    pub fn take_handoff(&self, window_label: &str) -> Result<Option<RendererHandoff>, String> {
        if window_label != "main" {
            return Err("Renderer handoff is available to the main webview only.".into());
        }
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
        Ok(state.handoff.clone())
    }

    pub fn start_active_renderer(
        &self,
        app: &AppHandle,
        show_after_ready: bool,
    ) -> Result<(), String> {
        let (active, rollback) = {
            let state = self
                .inner
                .state
                .lock()
                .map_err(|_| "Renderer update state lock is poisoned.".to_string())?;
            if state.activation.is_some() {
                return Err("Another renderer activation is already pending.".into());
            }
            (
                state.persisted.revision.active_release.clone(),
                state.persisted.revision.last_known_good_release.clone(),
            )
        };
        let Some(active) = active else {
            return Ok(());
        };
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main webview is unavailable for renderer startup.".to_string())?;
        let activation_id = self.begin_activation_guard(
            Some(active.clone()),
            rollback.clone(),
            None,
            "startup",
            show_after_ready,
        )?;
        let url = self.activation_url(Some(&active), &activation_id)?;
        if show_after_ready {
            let _ = window.hide();
        }
        if let Err(error) = navigate_webview_window(&window, url) {
            let reason =
                format!("Active renderer startup navigation failed and was rolled back: {error}");
            let restored = self.restore_pending_activation(&activation_id, &reason, false);
            match restored {
                Ok(target) => {
                    let fallback_url = self.target_url(target.as_ref())?;
                    navigate_webview_window(&window, fallback_url).map_err(|fallback_error| {
                        format!(
                            "Could not navigate to the active renderer: {error}; fallback renderer navigation also failed: {fallback_error}"
                        )
                    })?;
                    let _ = window.show();
                    return Ok(());
                }
                Err(restore_error) => {
                    return Err(format!(
                        "Could not navigate to the active renderer: {error}; renderer state rollback failed: {restore_error}"
                    ));
                }
            }
        }
        self.spawn_activation_timeout(app.clone(), activation_id);
        Ok(())
    }
}
#[cfg(test)]
#[path = "renderer_update/tests.rs"]
mod tests;
