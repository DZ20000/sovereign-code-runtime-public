use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt as _;

const IMPORT_RECEIPT_SCHEMA_VERSION: &str = "scr.runtime-host-release-index-import-receipt/v1";
const RECEIPT_DIRECTORY: &str = "import-receipts";
const IMPORT_LOCK_DIRECTORY: &str = ".import-lock";
const MAX_RECEIPT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RECEIPTS: usize = 1_024;
const MAX_RELEASES_PER_RECEIPT: usize = 128;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedReceiptIdentity {
    release_sequence: u64,
    signing_key_id: String,
    envelope_sha256: String,
    runtime_host_sha256: String,
}

impl ManagedReceiptIdentity {
    pub(crate) fn release_sequence(&self) -> u64 {
        self.release_sequence
    }

    pub(crate) fn signing_key_id(&self) -> &str {
        &self.signing_key_id
    }

    pub(crate) fn envelope_sha256(&self) -> &str {
        &self.envelope_sha256
    }

    pub(crate) fn runtime_host_sha256(&self) -> &str {
        &self.runtime_host_sha256
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedReceiptAudit {
    pub(crate) releases: BTreeMap<String, ManagedReceiptIdentity>,
    pub(crate) receipt_count: usize,
    pub(crate) latest_index_sequence: Option<u64>,
    pub(crate) latest_receipt_sha256: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum ReceiptOutcome {
    Staged,
    Adopted,
    Retained,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptRelease {
    envelope_sha256: String,
    outcome: ReceiptOutcome,
    release_id: String,
    release_sequence: u64,
    runtime_host_sha256: String,
    signing_key_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportReceipt {
    imported_at_unix_ms: u64,
    index_envelope_sha256: String,
    index_sequence: u64,
    index_sha256: String,
    index_signing_key_id: String,
    previous_receipt_sha256: Option<String>,
    receipt_id: String,
    releases: Vec<ReceiptRelease>,
    schema_version: String,
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectFileIdentity {
    volume_serial: u32,
    file_index: u64,
}

#[cfg(windows)]
fn direct_file_identity(file: &File, label: &str) -> Result<DirectFileIdentity, String> {
    use std::mem::zeroed;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION},
    };

    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    let handle = HANDLE(file.as_raw_handle());
    unsafe { GetFileInformationByHandle(handle, &mut information) }
        .map_err(|error| format!("Could not inspect {label} identity: {error}"))?;
    if information.nNumberOfLinks != 1 {
        return Err(format!("{label} may not be shared through a hard link."));
    }
    Ok(DirectFileIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
    })
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectFileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
fn direct_file_identity(file: &File, label: &str) -> Result<DirectFileIdentity, String> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect {label} identity: {error}"))?;
    if metadata.nlink() != 1 {
        return Err(format!("{label} may not be shared through a hard link."));
    }
    Ok(DirectFileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(any(windows, unix)))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectFileIdentity {
    length: u64,
}

#[cfg(not(any(windows, unix)))]
fn direct_file_identity(file: &File, label: &str) -> Result<DirectFileIdentity, String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect {label} identity: {error}"))?;
    Ok(DirectFileIdentity {
        length: metadata.len(),
    })
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_release_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 256
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn safe_integer(value: u64, label: &str) -> Result<u64, String> {
    if value == 0 || value > JAVASCRIPT_MAX_SAFE_INTEGER {
        return Err(format!(
            "{label} must be a positive JavaScript-safe integer."
        ));
    }
    Ok(value)
}

fn is_contained(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.strip_prefix(root).is_ok()
}

fn direct_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("{label} is unavailable: {error}"))?;
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse(&metadata)
    {
        return Err(format!("{label} must be a direct directory."));
    }
    fs::canonicalize(path).map_err(|error| format!("{label} could not be resolved: {error}"))
}

fn direct_file(path: &Path, label: &str, maximum_bytes: u64) -> Result<Vec<u8>, String> {
    let before =
        fs::symlink_metadata(path).map_err(|error| format!("{label} is unavailable: {error}"))?;
    if !before.file_type().is_file()
        || before.file_type().is_symlink()
        || metadata_is_reparse(&before)
    {
        return Err(format!("{label} must be a direct regular file."));
    }
    if before.len() == 0 || before.len() > maximum_bytes {
        return Err(format!("{label} is outside its size bound."));
    }
    let canonical_before = fs::canonicalize(path)
        .map_err(|error| format!("{label} could not be resolved: {error}"))?;
    let mut file =
        File::open(path).map_err(|error| format!("{label} could not be opened: {error}"))?;
    let opened_identity = direct_file_identity(&file, label)?;
    let opened = file
        .metadata()
        .map_err(|error| format!("{label} metadata could not be read: {error}"))?;
    if !opened.is_file() || opened.len() != before.len() {
        return Err(format!("{label} changed before reading."));
    }
    let capacity: usize = before
        .len()
        .try_into()
        .map_err(|_| format!("{label} size does not fit memory limits."))?;
    let mut bytes = Vec::with_capacity(capacity);
    file.by_ref()
        .take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{label} could not be read: {error}"))?;
    if bytes.len() as u64 != before.len() {
        return Err(format!("{label} changed while reading."));
    }
    let after = fs::symlink_metadata(path)
        .map_err(|error| format!("{label} changed while reading: {error}"))?;
    let canonical_after = fs::canonicalize(path)
        .map_err(|error| format!("{label} changed while resolving: {error}"))?;
    let reopened = File::open(path)
        .map_err(|error| format!("{label} changed before its final identity check: {error}"))?;
    let reopened_identity = direct_file_identity(&reopened, label)?;
    if canonical_after != canonical_before
        || reopened_identity != opened_identity
        || after.len() != before.len()
        || after.modified().ok() != before.modified().ok()
    {
        return Err(format!("{label} changed while reading."));
    }
    Ok(bytes)
}

fn append_canonical_json(value: &Value, output: &mut String) -> Result<(), String> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            if !(value.is_i64() || value.is_u64()) {
                return Err(
                    "Runtime release-index receipt may contain only integer numbers.".into(),
                );
            }
            output.push_str(&value.to_string());
        }
        Value::String(value) => output.push_str(
            &serde_json::to_string(value)
                .map_err(|error| format!("Receipt string could not be serialized: {error}"))?,
        ),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                append_canonical_json(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output
                    .push_str(&serde_json::to_string(key).map_err(|error| {
                        format!("Receipt key could not be serialized: {error}")
                    })?);
                output.push(':');
                append_canonical_json(&values[key], output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn canonical_json(value: &Value) -> Result<Vec<u8>, String> {
    let mut output = String::new();
    append_canonical_json(value, &mut output)?;
    Ok(output.into_bytes())
}

fn parse_receipt_filename(name: &str) -> Result<(u64, String), String> {
    let stem = name
        .strip_suffix(".json")
        .ok_or_else(|| "Runtime release-index receipt filename is invalid.".to_string())?;
    let (sequence, digest) = stem
        .split_once('-')
        .ok_or_else(|| "Runtime release-index receipt filename is invalid.".to_string())?;
    if sequence.len() != 16
        || !sequence.bytes().all(|byte| byte.is_ascii_digit())
        || !is_lower_sha256(digest)
    {
        return Err("Runtime release-index receipt filename is invalid.".into());
    }
    let sequence = sequence
        .parse::<u64>()
        .map_err(|_| "Runtime release-index receipt filename sequence is invalid.".to_string())?;
    safe_integer(sequence, "Runtime release-index receipt filename sequence")?;
    Ok((sequence, digest.into()))
}

fn parse_receipt(path: &Path, receipt_root: &Path) -> Result<(ImportReceipt, String), String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Runtime release-index receipt could not be resolved: {error}"))?;
    if !is_contained(receipt_root, &canonical) {
        return Err("Runtime release-index receipt escaped its managed directory.".into());
    }
    let raw = direct_file(path, "Runtime release-index receipt", MAX_RECEIPT_BYTES)?;
    let value: Value = serde_json::from_slice(&raw)
        .map_err(|error| format!("Runtime release-index receipt is invalid JSON: {error}"))?;
    if canonical_json(&value)? != raw {
        return Err("Runtime release-index receipt must use canonical JSON.".into());
    }
    let receipt: ImportReceipt = serde_json::from_value(value.clone())
        .map_err(|error| format!("Runtime release-index receipt schema is invalid: {error}"))?;
    if receipt.schema_version != IMPORT_RECEIPT_SCHEMA_VERSION {
        return Err("Runtime release-index receipt schema is unsupported.".into());
    }
    let (filename_sequence, filename_digest) = parse_receipt_filename(
        path.file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Runtime release-index receipt filename is not Unicode.".to_string())?,
    )?;
    safe_integer(
        receipt.index_sequence,
        "Runtime release-index receipt index sequence",
    )?;
    safe_integer(
        receipt.imported_at_unix_ms,
        "Runtime release-index receipt import time",
    )?;
    if filename_sequence != receipt.index_sequence
        || !is_lower_sha256(&receipt.receipt_id)
        || filename_digest != receipt.receipt_id
        || !is_lower_sha256(&receipt.index_envelope_sha256)
        || !is_lower_sha256(&receipt.index_sha256)
        || !valid_identifier(&receipt.index_signing_key_id)
        || receipt
            .previous_receipt_sha256
            .as_deref()
            .is_some_and(|value| !is_lower_sha256(value))
        || receipt.releases.is_empty()
        || receipt.releases.len() > MAX_RELEASES_PER_RECEIPT
    {
        return Err("Runtime release-index receipt metadata is invalid.".into());
    }
    let mut core = value;
    let object = core
        .as_object_mut()
        .ok_or_else(|| "Runtime release-index receipt must be an object.".to_string())?;
    if object.remove("receiptId").is_none() {
        return Err("Runtime release-index receipt ID is missing.".into());
    }
    if sha256_bytes(&canonical_json(&core)?) != receipt.receipt_id {
        return Err(
            "Runtime release-index receipt ID does not match its canonical content.".into(),
        );
    }
    Ok((receipt, sha256_bytes(&raw)))
}

fn strict_release_inventory(path: &Path, root: &Path) -> Result<BTreeSet<String>, String> {
    let mut releases = BTreeSet::new();
    let entries = fs::read_dir(path)
        .map_err(|error| format!("Managed Runtime candidate inbox could not be read: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!("Managed Runtime candidate inbox entry could not be read: {error}")
        })?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
            format!("Managed Runtime candidate inbox entry is unavailable: {error}")
        })?;
        if !metadata.file_type().is_dir()
            || metadata.file_type().is_symlink()
            || metadata_is_reparse(&metadata)
        {
            return Err("Managed Runtime candidate inbox contains an unexpected entry.".into());
        }
        let canonical = fs::canonicalize(entry.path()).map_err(|error| {
            format!("Managed Runtime candidate inbox entry could not be resolved: {error}")
        })?;
        if !is_contained(root, &canonical) {
            return Err("Managed Runtime candidate inbox entry escaped its root.".into());
        }
        let release_id = entry.file_name().into_string().map_err(|_| {
            "Managed Runtime candidate inbox release ID is not Unicode.".to_string()
        })?;
        if !valid_release_id(&release_id) || !releases.insert(release_id) {
            return Err(
                "Managed Runtime candidate inbox release ID is invalid or duplicated.".into(),
            );
        }
    }
    Ok(releases)
}

pub(crate) fn audit_managed_receipts(
    managed_root: &Path,
    inbox_root: &Path,
) -> Result<ManagedReceiptAudit, String> {
    let managed_canonical = direct_directory(managed_root, "Managed Runtime update root")?;
    let inbox_canonical = direct_directory(inbox_root, "Managed Runtime candidate inbox")?;
    if !is_contained(&managed_canonical, &inbox_canonical) {
        return Err("Managed Runtime candidate inbox escaped the update root.".into());
    }
    let inbox_releases = strict_release_inventory(inbox_root, &inbox_canonical)?;
    let receipt_path = managed_root.join(RECEIPT_DIRECTORY);
    let receipt_root = match direct_directory(
        &receipt_path,
        "Managed Runtime release-index receipt directory",
    ) {
        Ok(path) => path,
        Err(_error)
            if fs::symlink_metadata(&receipt_path)
                .is_err_and(|value| value.kind() == ErrorKind::NotFound) =>
        {
            if inbox_releases.is_empty() {
                return Ok(ManagedReceiptAudit {
                    releases: BTreeMap::new(),
                    receipt_count: 0,
                    latest_index_sequence: None,
                    latest_receipt_sha256: None,
                });
            }
            return Err(
                "Managed Runtime candidate inbox has no release-index receipt chain.".into(),
            );
        }
        Err(error) => return Err(error),
    };
    if !is_contained(&managed_canonical, &receipt_root) {
        return Err(
            "Managed Runtime release-index receipt directory escaped the update root.".into(),
        );
    }
    match fs::symlink_metadata(receipt_path.join(IMPORT_LOCK_DIRECTORY)) {
        Ok(_) => return Err(
            "Managed Runtime preflight is unavailable while a release-index import lock exists."
                .into(),
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Managed Runtime release-index import lock could not be inspected: {error}"
            ))
        }
    }

    let mut receipt_paths = Vec::new();
    for entry in fs::read_dir(&receipt_path).map_err(|error| {
        format!("Managed Runtime release-index receipts could not be read: {error}")
    })? {
        let entry = entry.map_err(|error| {
            format!("Managed Runtime release-index receipt entry failed: {error}")
        })?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Runtime release-index receipt filename is not Unicode.".to_string())?;
        parse_receipt_filename(&name)?;
        receipt_paths.push(entry.path());
    }
    receipt_paths.sort();
    if receipt_paths.len() > MAX_RECEIPTS {
        return Err("Managed Runtime release-index receipt history exceeds its bound.".into());
    }

    let mut releases = BTreeMap::new();
    let mut previous_raw_sha256: Option<String> = None;
    let mut previous_index_sequence = 0_u64;
    let mut highest_release_sequence = 0_u64;
    for path in &receipt_paths {
        let (receipt, raw_sha256) = parse_receipt(path, &receipt_root)?;
        if receipt.index_sequence <= previous_index_sequence {
            return Err("Runtime release-index receipt sequence did not increase strictly.".into());
        }
        if receipt.previous_receipt_sha256 != previous_raw_sha256 {
            return Err("Runtime release-index receipt chain is broken.".into());
        }
        let previous_highest = highest_release_sequence;
        let mut new_highest = previous_highest;
        let mut receipt_release_ids = BTreeSet::new();
        for release in receipt.releases {
            safe_integer(
                release.release_sequence,
                "Runtime release-index receipt release sequence",
            )?;
            if !valid_release_id(&release.release_id)
                || !valid_identifier(&release.signing_key_id)
                || !is_lower_sha256(&release.envelope_sha256)
                || !is_lower_sha256(&release.runtime_host_sha256)
                || !receipt_release_ids.insert(release.release_id.clone())
            {
                return Err("Runtime release-index receipt release metadata is invalid.".into());
            }
            let identity = ManagedReceiptIdentity {
                release_sequence: release.release_sequence,
                signing_key_id: release.signing_key_id,
                envelope_sha256: release.envelope_sha256,
                runtime_host_sha256: release.runtime_host_sha256,
            };
            match releases.get(&release.release_id) {
                Some(existing) => {
                    if release.outcome != ReceiptOutcome::Retained || existing != &identity {
                        return Err(
                            "Runtime release-index receipt changes a previously recorded release."
                                .into(),
                        );
                    }
                }
                None => {
                    if release.outcome == ReceiptOutcome::Retained
                        || release.release_sequence <= new_highest
                    {
                        return Err(
                            "Runtime release-index receipt release sequence did not advance monotonically."
                                .into(),
                        );
                    }
                    new_highest = release.release_sequence;
                    releases.insert(release.release_id, identity);
                }
            }
        }
        highest_release_sequence = highest_release_sequence.max(new_highest);
        previous_index_sequence = receipt.index_sequence;
        previous_raw_sha256 = Some(raw_sha256);
    }

    let expected = releases.keys().cloned().collect::<BTreeSet<_>>();
    if expected != inbox_releases {
        return Err("Managed Runtime release-index receipts and inbox inventory disagree.".into());
    }
    Ok(ManagedReceiptAudit {
        releases,
        receipt_count: receipt_paths.len(),
        latest_index_sequence: (previous_index_sequence > 0).then_some(previous_index_sequence),
        latest_receipt_sha256: previous_raw_sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn write_receipt(
        root: &Path,
        index_sequence: u64,
        previous_receipt_sha256: Option<String>,
        releases: Value,
    ) -> String {
        let core = json!({
            "importedAtUnixMs": 1_787_911_200_000_u64 + index_sequence,
            "indexEnvelopeSha256": "1".repeat(64),
            "indexSequence": index_sequence,
            "indexSha256": "2".repeat(64),
            "indexSigningKeyId": "index-key-1",
            "previousReceiptSha256": previous_receipt_sha256,
            "releases": releases,
            "schemaVersion": IMPORT_RECEIPT_SCHEMA_VERSION,
        });
        let receipt_id = sha256_bytes(&canonical_json(&core).unwrap());
        let mut receipt = core;
        receipt
            .as_object_mut()
            .unwrap()
            .insert("receiptId".into(), Value::String(receipt_id.clone()));
        let bytes = canonical_json(&receipt).unwrap();
        fs::write(
            root.join(format!("{index_sequence:016}-{receipt_id}.json")),
            &bytes,
        )
        .unwrap();
        sha256_bytes(&bytes)
    }

    fn release(id: &str, sequence: u64, outcome: &str) -> Value {
        json!({
            "envelopeSha256": format!("{:064x}", sequence + 10),
            "outcome": outcome,
            "releaseId": id,
            "releaseSequence": sequence,
            "runtimeHostSha256": format!("{:064x}", sequence + 20),
            "signingKeyId": "runtime-key-1",
        })
    }

    fn roots() -> (TempDir, PathBuf, PathBuf, PathBuf) {
        let temp = TempDir::new().unwrap();
        let managed = temp.path().join("managed");
        let inbox = managed.join("inbox");
        let receipts = managed.join(RECEIPT_DIRECTORY);
        fs::create_dir_all(&inbox).unwrap();
        fs::create_dir(&receipts).unwrap();
        (temp, managed, inbox, receipts)
    }

    #[test]
    fn validates_a_hash_chained_receipt_inventory() {
        let (_temp, managed, inbox, receipts) = roots();
        fs::create_dir(inbox.join("runtime-1")).unwrap();
        fs::create_dir(inbox.join("runtime-2")).unwrap();
        let first = write_receipt(
            &receipts,
            1,
            None,
            json!([release("runtime-1", 1, "staged")]),
        );
        write_receipt(
            &receipts,
            2,
            Some(first),
            json!([
                release("runtime-1", 1, "retained"),
                release("runtime-2", 2, "staged")
            ]),
        );

        let audit = audit_managed_receipts(&managed, &inbox).unwrap();
        assert_eq!(audit.receipt_count, 2);
        assert_eq!(audit.latest_index_sequence, Some(2));
        assert!(audit
            .latest_receipt_sha256
            .as_deref()
            .is_some_and(is_lower_sha256));
        assert_eq!(audit.releases.len(), 2);
        assert_eq!(audit.releases["runtime-2"].release_sequence(), 2);
    }

    #[test]
    fn rejects_broken_chains_and_receipt_identity_drift() {
        let (_temp, managed, inbox, receipts) = roots();
        fs::create_dir(inbox.join("runtime-1")).unwrap();
        write_receipt(
            &receipts,
            1,
            None,
            json!([release("runtime-1", 1, "staged")]),
        );
        write_receipt(
            &receipts,
            2,
            Some("f".repeat(64)),
            json!([release("runtime-1", 1, "retained")]),
        );
        assert!(audit_managed_receipts(&managed, &inbox)
            .unwrap_err()
            .contains("chain is broken"));
    }

    #[test]
    fn rejects_unreceipted_inbox_content_and_active_imports() {
        let (_temp, managed, inbox, receipts) = roots();
        fs::create_dir(inbox.join("runtime-orphan")).unwrap();
        assert!(audit_managed_receipts(&managed, &inbox)
            .unwrap_err()
            .contains("receipts and inbox inventory disagree"));

        fs::create_dir(receipts.join(IMPORT_LOCK_DIRECTORY)).unwrap();
        assert!(audit_managed_receipts(&managed, &inbox)
            .unwrap_err()
            .contains("import lock exists"));
    }

    #[test]
    fn rejects_hard_linked_receipt_files() {
        let (temp, managed, inbox, receipts) = roots();
        fs::create_dir(inbox.join("runtime-1")).unwrap();
        write_receipt(
            &receipts,
            1,
            None,
            json!([release("runtime-1", 1, "staged")]),
        );
        let receipt = fs::read_dir(&receipts)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::hard_link(&receipt, temp.path().join("receipt-hard-link.json")).unwrap();

        assert!(audit_managed_receipts(&managed, &inbox)
            .unwrap_err()
            .contains("hard link"));
    }
}
