use std::{env, io::ErrorKind, path::Path};

use serde_json::{json, Value};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "Sovereign Code Runtime";
const AUTOSTART_ARGUMENT: &str = "--autostart";
const GUARDIAN_RESTART_ARGUMENT: &str = "--guardian-restart";

fn launch_kind(executable: &Path) -> &'static str {
    let parent = executable.parent();
    if parent.is_some_and(|value| value.join("portable-package.json").is_file()) {
        "portable"
    } else if parent.is_some_and(|value| value.join("uninstall.exe").is_file()) {
        "installed"
    } else if executable
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
        .contains("\\apps\\desktop-tauri\\src-tauri\\target\\")
    {
        "development"
    } else {
        "unknown"
    }
}

fn expected_command(executable: &Path) -> String {
    format!("\"{}\" {AUTOSTART_ARGUMENT}", executable.to_string_lossy())
}

fn warning_for(kind: &str, registered: Option<&str>, expected: &str) -> Option<String> {
    if registered.is_some_and(|value| value != expected) {
        return Some(
            "Windows has a stale Sovereign login-start command. Re-enable the setting to bind it to this executable."
                .into(),
        );
    }
    match kind {
        "portable" => Some(
            "This is a portable build. Moving or deleting this folder will break Windows login startup; use the installed build for deployment."
                .into(),
        ),
        "development" => Some(
            "This is a development executable. Windows login startup should be enabled from an installed or fixed portable build."
                .into(),
        ),
        "unknown" => Some(
            "Sovereign could not classify this executable as installed or portable. Keep its path stable before relying on login startup."
                .into(),
        ),
        _ => None,
    }
}

#[cfg(windows)]
fn read_registered_command() -> Result<Option<String>, String> {
    use winreg::{enums::{HKEY_CURRENT_USER, KEY_READ}, RegKey};

    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let key = match current_user.open_subkey_with_flags(RUN_KEY, KEY_READ) {
        Ok(key) => key,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read the Windows login-start registry key: {error}")),
    };
    match key.get_value::<String, _>(VALUE_NAME) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read the Sovereign login-start value: {error}")),
    }
}

#[cfg(not(windows))]
fn read_registered_command() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(windows)]
fn write_registered_command(command: Option<&str>) -> Result<(), String> {
    use winreg::{enums::{HKEY_CURRENT_USER, KEY_SET_VALUE}, RegKey};

    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    if let Some(command) = command {
        let (key, _) = current_user
            .create_subkey(RUN_KEY)
            .map_err(|error| format!("Could not create the Windows login-start registry key: {error}"))?;
        key.set_value(VALUE_NAME, &command)
            .map_err(|error| format!("Could not enable Sovereign at Windows login: {error}"))?;
        return Ok(());
    }

    let key = match current_user.open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE) {
        Ok(key) => key,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not open the Windows login-start registry key: {error}")),
    };
    match key.delete_value(VALUE_NAME) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not disable Sovereign at Windows login: {error}")),
    }
}

#[cfg(not(windows))]
fn write_registered_command(_command: Option<&str>) -> Result<(), String> {
    Err("Windows login startup is unavailable on this platform.".into())
}

pub fn state() -> Result<Value, String> {
    let executable = env::current_exe()
        .map_err(|error| format!("Could not resolve the current Sovereign executable: {error}"))?;
    let executable_path = executable.to_string_lossy().to_string();
    let kind = launch_kind(&executable);
    let expected = expected_command(&executable);
    let registered = read_registered_command()?;
    let supported = cfg!(windows);
    let enabled = supported && registered.as_deref() == Some(expected.as_str());
    let warning = if supported {
        warning_for(kind, registered.as_deref(), &expected)
    } else {
        Some("Windows login startup is only available on Windows.".into())
    };
    Ok(json!({
        "schemaVersion": "scr.host-startup/v1",
        "supported": supported,
        "enabled": enabled,
        "executablePath": executable_path,
        "launchKind": kind,
        "registeredCommand": registered,
        "warning": warning
    }))
}

pub fn set(enabled: bool) -> Result<Value, String> {
    let executable = env::current_exe()
        .map_err(|error| format!("Could not resolve the current Sovereign executable: {error}"))?;
    let command = expected_command(&executable);
    write_registered_command(enabled.then_some(command.as_str()))?;
    state()
}

pub fn is_background_launch() -> bool {
    env::args_os().any(|argument| {
        argument == AUTOSTART_ARGUMENT || argument == GUARDIAN_RESTART_ARGUMENT
    })
}
