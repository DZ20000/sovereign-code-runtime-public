use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

const DISABLED_RENDERER_TRUST: &str = "{\n  \"schemaVersion\": \"scr.renderer-trusted-keys/v1\",\n  \"keys\": []\n}\n";

fn ensure_renderer_trust_resource() {
    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR")
            .expect("CARGO_MANIFEST_DIR is required for renderer trust preparation"),
    );
    let target = manifest_dir
        .parent()
        .expect("desktop-tauri src-tauri directory must have a parent")
        .join("runtime-resources")
        .join("renderer-trusted-keys.json");
    if target.exists() {
        println!("cargo:rerun-if-changed={}", target.display());
        return;
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .expect("could not create generated renderer trust resource directory");
    }
    match OpenOptions::new().write(true).create_new(true).open(&target) {
        Ok(mut file) => {
            file.write_all(DISABLED_RENDERER_TRUST.as_bytes())
                .expect("could not write disabled renderer trust registry");
            file.sync_all()
                .expect("could not flush disabled renderer trust registry");
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => panic!("could not create disabled renderer trust registry: {error}"),
    }
    println!("cargo:rerun-if-changed={}", target.display());
}
fn main() {
    ensure_renderer_trust_resource();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "ui_ready",
            "control_call",
            "renderer_preflight_control_call",
            "renderer_update_status",
            "runtime_candidate_update_status",
            "install_runtime_candidate_update",
            "activate_runtime_candidate_update",
            "renderer_update_install",
            "renderer_update_preflight",
            "renderer_update_activate",
            "renderer_update_rollback",
            "renderer_update_take_handoff",
            "resource_snapshot",
            "host_startup_state",
            "host_startup_set",
            "copy_connection_bundle",
            "approval_current",
            "approval_resolve",
        ]),
    ))
    .expect("failed to build Sovereign Tauri command permissions");
}
