use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde_json::{json, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const LEGACY_DIRECTORY_NAME: &str = "Sovereign Code Runtime";
const MIGRATION_MARKER: &str = "migration-v1.json";
const STAGING_DIRECTORY: &str = ".migration-v1-staging";

pub fn migrate_legacy_electron_data_if_needed(
    node_executable: &Path,
    target_root: &Path,
) -> Result<(), String> {
    if target_root.join("settings.json").is_file() || target_root.join(MIGRATION_MARKER).is_file() {
        return Ok(());
    }
    let parent = target_root
        .parent()
        .ok_or_else(|| "Tauri data root has no parent directory.".to_string())?;
    let legacy_root = parent.join(LEGACY_DIRECTORY_NAME);
    let legacy_settings = legacy_root.join("settings.json");
    if !legacy_settings.is_file() {
        return Ok(());
    }

    let staging = target_root.join(STAGING_DIRECTORY);
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(staging.join("audit"))
        .map_err(|error| format!("Could not create migration staging directory: {error}"))?;

    let migration_result = (|| -> Result<(), String> {
        migrate_settings(&legacy_settings, &staging.join("settings.json"))?;

        let mut migrated_databases = Vec::<String>::new();
        for name in ["audit.sqlite", "runs.sqlite"] {
            let source = legacy_root.join("audit").join(name);
            if !source.is_file() {
                continue;
            }
            let target = staging.join("audit").join(name);
            backup_sqlite(node_executable, &source, &target)?;
            let size = std::fs::metadata(&target)
                .map_err(|error| format!("Could not verify migrated {name}: {error}"))?
                .len();
            if size == 0 {
                return Err(format!("Migrated {name} is unexpectedly empty."));
            }
            migrated_databases.push(name.to_string());
        }

        std::fs::create_dir_all(target_root)
            .map_err(|error| format!("Could not create Tauri data root: {error}"))?;
        std::fs::create_dir_all(target_root.join("audit"))
            .map_err(|error| format!("Could not create Tauri audit directory: {error}"))?;

        promote_file(&staging.join("settings.json"), &target_root.join("settings.json"))?;
        for name in &migrated_databases {
            promote_file(
                &staging.join("audit").join(name),
                &target_root.join("audit").join(name),
            )?;
        }

        let migrated_at = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|error| format!("Could not format migration timestamp: {error}"))?;
        let marker = json!({
            "schemaVersion": "scr.desktop-migration/v1",
            "migratedAt": migrated_at,
            "source": legacy_root.to_string_lossy(),
            "target": target_root.to_string_lossy(),
            "encryptedTunnelKeyCleared": true,
            "databases": migrated_databases,
            "legacySourcePreserved": true
        });
        write_json_atomic(&target_root.join(MIGRATION_MARKER), &marker)?;
        Ok(())
    })();

    let _ = std::fs::remove_dir_all(&staging);
    migration_result
}

fn migrate_settings(source: &Path, target: &Path) -> Result<(), String> {
    let bytes = std::fs::read(source)
        .map_err(|error| format!("Could not read legacy Electron settings: {error}"))?;
    let mut settings: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Legacy Electron settings JSON is invalid: {error}"))?;
    let record = settings
        .as_object_mut()
        .ok_or_else(|| "Legacy Electron settings must be a JSON object.".to_string())?;
    record.insert("secureTunnelRuntimeKeyEncrypted".into(), Value::Null);
    write_json_atomic(target, &settings)
}

fn backup_sqlite(node_executable: &Path, source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create SQLite migration directory: {error}"))?;
    }
    let _ = std::fs::remove_file(target);
    let script = r#"
const { backup, DatabaseSync } = require('node:sqlite');
const source = process.env.SCR_MIGRATE_SQLITE_SOURCE;
const target = process.env.SCR_MIGRATE_SQLITE_TARGET;
(async () => {
  const db = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
  try {
    await backup(db, target, { rate: 100 });
  } finally {
    db.close();
  }
})().catch((error) => {
  process.stderr.write(String(error && (error.stack || error.message) || error));
  process.exit(1);
});
"#;
    let mut command = Command::new(node_executable);
    command
        .arg("-e")
        .arg(script)
        .env("SCR_MIGRATE_SQLITE_SOURCE", source)
        .env("SCR_MIGRATE_SQLITE_TARGET", target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|error| format!("Could not start Node SQLite backup helper: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("SQLite backup helper failed with status {}.", output.status)
        } else {
            format!("SQLite backup helper failed: {stderr}")
        });
    }
    Ok(())
}

fn promote_file(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        return Err(format!(
            "Migration target unexpectedly appeared during migration: {}",
            target.display()
        ));
    }
    std::fs::rename(source, target)
        .map_err(|error| format!("Could not promote migrated file {}: {error}", target.display()))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create JSON parent directory: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not serialize migration JSON: {error}"))?;
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write migration JSON: {error}"))?;
    std::fs::rename(&temporary, path)
        .map_err(|error| format!("Could not finalize migration JSON: {error}"))?;
    Ok(())
}
