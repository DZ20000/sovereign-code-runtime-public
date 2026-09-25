use crate::{
    runtime_candidate_update::{
        is_managed_preflight_failure, validate_committed_cutover_receipt,
        RuntimeCandidateActivationReceipt, RuntimeCandidateUpdateManager,
    },
    runtime_host_supervisor::{cutover_requires_restart, RuntimeHostSupervisor},
};

pub(crate) fn activate_verified_runtime_candidate(
    manager: &RuntimeCandidateUpdateManager,
    supervisor: &RuntimeHostSupervisor,
    release_id: &str,
) -> Result<RuntimeCandidateActivationReceipt, String> {
    let transition = manager.acquire_transition()?;
    if !manager.is_enabled() {
        return Err("No trusted Runtime candidate signing keys are provisioned.".into());
    }
    let verified = manager.prepare_activation(&transition, release_id)?;
    supervisor.cutover_verified_slot(
        verified.release_id().to_string(),
        verified.slot_root().to_path_buf(),
        verified.runtime_script_sha256().to_string(),
        |cutover| manager.commit_activation(&transition, &verified, cutover),
    )
}

pub(crate) fn restore_active_runtime_candidate(
    manager: &RuntimeCandidateUpdateManager,
    supervisor: &RuntimeHostSupervisor,
) -> Result<(), String> {
    let transition = manager.acquire_transition()?;
    let Some(verified) = manager.active_verified_release(&transition)? else {
        return Ok(());
    };
    let release_id = verified.release_id().to_string();
    supervisor.cutover_verified_slot(
        release_id.clone(),
        verified.slot_root().to_path_buf(),
        verified.runtime_script_sha256().to_string(),
        |cutover| validate_committed_cutover_receipt(cutover, &release_id),
    )
}

pub(crate) fn startup_restore_requires_abort(error: &str) -> bool {
    is_managed_preflight_failure(error) || cutover_requires_restart(error)
}
