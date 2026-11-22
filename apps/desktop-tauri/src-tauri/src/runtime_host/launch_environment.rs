use std::{
    ffi::OsString,
    process::{Command, Stdio},
};

use super::RuntimeHostLaunchOptions;

const REGISTERED_CONNECTION_OWNER_ENV: &str = "SCR_RUNTIME_REGISTERED_CONNECTION_OWNER";

pub(super) fn registered_connection_owner_eligible(
    debug_build: bool,
    mut environment_names: impl Iterator<Item = OsString>,
) -> bool {
    !debug_build
        && !environment_names.any(|name| {
            let name = name.to_string_lossy().to_ascii_uppercase();
            matches!(
                name.as_str(),
                "SCR_USER_DATA_PATH"
                    | "SCR_SMOKE_REPORT_PATH"
                    | "SCR_APPROVAL_SMOKE_REPORT_PATH"
                    | "SCR_HOST_GUARDIAN_INTEGRATION_DIR"
            ) || name.starts_with("SCR_RESOURCE_BENCHMARK_")
                || name.starts_with("SCR_UPDATE_PREFLIGHT")
        })
}

pub(super) fn command(options: &RuntimeHostLaunchOptions) -> Command {
    let mut command = Command::new(&options.node_executable);
    command
        .arg(&options.runtime_script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("SCR_CONTROL_SESSION_SECRET", &options.session)
        .env("SCR_CONTROL_USER_DATA_PATH", &options.user_data)
        .env("SCR_CONTROL_NATIVE_AGENT_PATH", &options.native_agent)
        .env("SCR_CONTROL_PARENT_PID", std::process::id().to_string())
        .env(
            "SCR_RUNTIME_GATEWAY_BEARER_TOKEN",
            &options.gateway_bearer_token,
        )
        .env("SCR_RUNTIME_INSTANCE_ID", &options.instance_id)
        .env("SCR_RUNTIME_RELEASE_ID", &options.release_id)
        .env("SCR_RUNTIME_CUTOVER_ROLE", options.role);
    command.env_remove(REGISTERED_CONNECTION_OWNER_ENV);
    if options.publish_registered_connection {
        command.env(REGISTERED_CONNECTION_OWNER_ENV, "1");
    }
    if let Some(promotion_fencing_token) = options.promotion_fencing_token.as_ref() {
        command.env(
            "SCR_RUNTIME_PROMOTION_FENCING_TOKEN",
            promotion_fencing_token,
        );
    }
    if let Some(environment_workspace_root) = options.environment_workspace_root.as_ref() {
        command.env("SCR_WORKSPACE_ROOT", environment_workspace_root);
    }
    #[cfg(debug_assertions)]
    if options.environment_workspace_root.is_none() {
        command.env("SCR_WORKSPACE_ROOT", &options.workspace_root);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{ffi::OsStr, path::PathBuf};

    fn eligible(debug_build: bool, names: &[&str]) -> bool {
        registered_connection_owner_eligible(debug_build, names.iter().map(OsString::from))
    }

    fn options() -> RuntimeHostLaunchOptions {
        RuntimeHostLaunchOptions {
            session: "fixture-session".into(),
            gateway_bearer_token: "fixture-gateway-token".into(),
            instance_id: "fixture-instance".into(),
            release_id: "fixture-release".into(),
            role: "active",
            promotion_fencing_token: None,
            user_data: PathBuf::from("fixture-data"),
            #[cfg(debug_assertions)]
            workspace_root: PathBuf::from("fixture-workspace"),
            environment_workspace_root: None,
            node_executable: PathBuf::from("never-executed-node"),
            runtime_script: PathBuf::from("fixture-runtime.cjs"),
            runtime_script_sha256: "a".repeat(64),
            native_agent: PathBuf::from("fixture-agent.exe"),
            migrate_legacy_data: false,
            publish_registered_connection: false,
        }
    }

    #[test]
    fn registered_connection_owner_requires_an_unisolated_release_product() {
        assert!(eligible(false, &[]));
        assert!(eligible(
            false,
            &["SystemRoot", REGISTERED_CONNECTION_OWNER_ENV]
        ));
        assert!(!eligible(true, &[]));
        for name in [
            "SCR_USER_DATA_PATH",
            "SCR_SMOKE_REPORT_PATH",
            "SCR_APPROVAL_SMOKE_REPORT_PATH",
            "SCR_HOST_GUARDIAN_INTEGRATION_DIR",
            "SCR_RESOURCE_BENCHMARK_SCENARIO",
            "SCR_RESOURCE_BENCHMARK_USER_DATA",
            "SCR_RESOURCE_BENCHMARK_OUTPUT",
            "SCR_UPDATE_PREFLIGHT",
            "SCR_UPDATE_PREFLIGHT_RELEASE_ID",
            "SCR_UPDATE_PREFLIGHT_RELEASE_SEQUENCE",
            "SCR_UPDATE_PREFLIGHT_MANIFEST_SHA256",
        ] {
            assert!(!eligible(false, &[name]), "{name}");
            assert!(!eligible(false, &[&name.to_ascii_lowercase()]), "{name}");
        }
    }

    #[test]
    fn child_environment_removes_inherited_owner_opt_in_for_isolated_launches() {
        let command = command(&options());
        let owner = command
            .get_envs()
            .find(|(name, _)| *name == OsStr::new(REGISTERED_CONNECTION_OWNER_ENV));
        assert_eq!(
            owner,
            Some((OsStr::new(REGISTERED_CONNECTION_OWNER_ENV), None))
        );
    }

    #[test]
    fn child_environment_explicitly_opts_in_eligible_active_and_candidate_launches() {
        let mut options = options();
        options.publish_registered_connection = true;
        for role in ["active", "candidate"] {
            options.role = role;
            let command = command(&options);
            let owner = command
                .get_envs()
                .find(|(name, _)| *name == OsStr::new(REGISTERED_CONNECTION_OWNER_ENV));
            assert_eq!(
                owner,
                Some((
                    OsStr::new(REGISTERED_CONNECTION_OWNER_ENV),
                    Some(OsStr::new("1"))
                )),
            );
        }
    }
}
