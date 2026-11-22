import type { BrowserWindow } from "electron";

export async function verifyProjectWorkspace(window: BrowserWindow): Promise<Readonly<Record<string, unknown>>> {
  const result = await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return await predicate();
    };
    const projectChooser=document.querySelector('.v2-task-project-chooser');
    if(projectChooser instanceof HTMLDetailsElement) projectChooser.open=true;
    const project = document.querySelector('#task-project-select');
    const directory = document.querySelector('#task-project-workspace-select');
    const permission = document.querySelector('#task-project-workspace-permissions');
    const permissionSummary = document.querySelector('#task-project-workspace-permission-summary');
    const choose = document.querySelector('#task-project-workspace-choose');
    const section = document.querySelector('#task-project-workspace');
    const status = document.querySelector('#task-project-workspace-status');
    if (!(project instanceof HTMLSelectElement) || !(directory instanceof HTMLSelectElement) ||
      !(permission instanceof HTMLButtonElement) || !(permissionSummary instanceof HTMLElement) || !(choose instanceof HTMLButtonElement) ||
      !(section instanceof HTMLElement) || !(status instanceof HTMLElement)) {
      return { ok: false, reason: 'project working directory controls missing' };
    }
    const change = (element, value) => {
      element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const baseline = await window.sovereign.getState();
    const ready = (workspaceId, profile) => !directory.disabled && directory.value === workspaceId &&
      permission.dataset.workspaceId === workspaceId && !permission.disabled &&
      permissionSummary.textContent?.includes(({observe:'L1',workspace:'L2',consequential:'L3',bypass:'L4'})[profile]) && section.getAttribute('aria-busy') === 'false' &&
      status.getAttribute('role') === 'status';

    change(project, 'project-visual-sovereign');
    const initialDirectory = await waitFor(() => ready('workspace-visual-sovereign', 'consequential'));
    choose.click();
    const chosenDirectory = await waitFor(() => ready('workspace-visual-sovereign-chosen', 'observe') && directory.options.length === 2);
    permission.click();
    const directoryPermissionsAccessible = await waitFor(() => document.querySelector('#view-settings')?.classList.contains('is-active') &&
      document.querySelector('#settings-tab-security')?.getAttribute('aria-selected') === 'true' &&
      document.querySelectorAll('#settings-permission-profiles').length === 1 &&
      document.querySelector('#settings-permission-profiles').dataset.workspaceScope === 'workspace-visual-sovereign-chosen' &&
      !document.querySelector('#settings-permission-profiles [data-permission-profile="workspace"]').disabled &&
      document.querySelector('#task-project-workspace-permission') === null);
    document.querySelector('#settings-permission-profiles [data-permission-profile="workspace"]')?.click();
    const beforeApply = await window.sovereign.readProjectWorkspaces('project-visual-sovereign');
    const permissionIsDraft = beforeApply.workspaces.find(workspace => workspace.id === 'workspace-visual-sovereign-chosen')?.permissionProfile === 'observe';
    const permissionDraftReady = await waitFor(() => !document.querySelector('#v2-save-workspace')?.disabled);
    document.querySelector('#v2-save-workspace')?.click();
    const permissionSaved = await waitFor(async () =>
      (await window.sovereign.readProjectWorkspaces('project-visual-sovereign')).workspaces.find(
        workspace => workspace.id === 'workspace-visual-sovereign-chosen')?.permissionProfile === 'workspace');
    document.querySelector('.navigation-item[data-view="tasks"]')?.click();
    await waitFor(() => ready('workspace-visual-sovereign-chosen', 'workspace'));

    change(project, 'project-visual-sample-clipboard');
    const otherProject = await waitFor(() => ready('workspace-visual-sample-clipboard', 'observe'));
    const otherState = await window.sovereign.getState();
    const separatePermissions = otherState.activeDesktopWorkspace?.id === 'workspace-visual-sample-clipboard' &&
      otherState.activeDesktopWorkspace?.permissionProfile === 'observe';

    change(project, 'project-visual-sovereign');
    const rememberedSelection = await waitFor(() => ready('workspace-visual-sovereign-chosen', 'workspace'));
    const restoredState = await window.sovereign.getState();
    const restoredDirectory = restoredState.activeDesktopWorkspace?.id === 'workspace-visual-sovereign-chosen' &&
      restoredState.activeDesktopWorkspace?.root.endsWith('sovereign-task-workspace') &&
      restoredState.activeDesktopWorkspace?.permissionProfile === 'workspace';
    const baseUnchanged = restoredState.workspaceRoot === baseline.workspaceRoot &&
      restoredState.permissionProfile === baseline.permissionProfile &&
      restoredState.rememberedPermissionProfile === baseline.rememberedPermissionProfile;

    const openTask = async () => {
      document.querySelector('#task-board-lane-current').click();
      const row = () => document.querySelector('#task-project-grid [data-task-id="task-visual-agent-hub"]');
      if (!await waitFor(() => row()?.checkVisibility())) return false;
      row().click();
      return waitFor(() => document.querySelector('#task-detail-title')?.textContent?.trim() === 'Build task and Agent hub' &&
        !document.querySelector('#task-detail-pane').hidden && document.querySelector('#task-detail-pane').getAttribute('aria-busy') !== 'true' &&
        !document.querySelector('#task-detail-open-terminal').disabled);
    };
    const taskDetailOpened = await openTask();
    const technical = document.querySelector('#task-info-popover');
    if (!technical?.matches(':popover-open')) document.querySelector('#task-info-toggle')?.click();
    const technicalDetails = document.querySelector('.task-technical-details');
    if (technicalDetails instanceof HTMLDetailsElement) technicalDetails.open = true;
    const terminalActionVisible = document.querySelector('#task-detail-open-terminal')?.checkVisibility();
    document.querySelector('#task-detail-open-terminal')?.click();
    const terminalOpened = await waitFor(() => document.querySelector('#view-terminal')?.classList.contains('is-active'));
    const terminalSessions = await window.sovereign.invokeTool('terminal.session.list', {});
    const terminalUsesSelectedDirectory = terminalSessions.some((session) => session.id === 'terminal-visual-project' &&
      session.workspaceId === 'workspace-visual-sovereign-chosen' && session.relativeCwd === '') &&
      terminalSessions.some((session) => session.id === 'terminal-visual-session' && session.workspaceId === 'desktop-workspace');
    document.querySelector('.navigation-item[data-view="overview"]')?.click();
    const summaryShowsSelectedDirectory = await waitFor(() => document.querySelector('#home-workspace-name')?.textContent?.includes('sovereign-task-workspace'));
    document.querySelector('.navigation-item[data-view="tasks"]')?.click();
    document.querySelector('#task-show-all-runs')?.click();
    document.querySelector('#task-history-back')?.click();
    const returningToTasksKeepsProject = await waitFor(() => document.querySelector('#view-tasks')?.classList.contains('is-active') &&
      project.value === 'project-visual-sovereign' && ready('workspace-visual-sovereign-chosen', 'workspace'));

    change(directory, 'workspace-visual-sovereign');
    const savedDirectorySelectable = await waitFor(() => ready('workspace-visual-sovereign', 'consequential'));
    change(project, 'project-visual-sample-clipboard');
    await waitFor(() => ready('workspace-visual-sample-clipboard', 'observe'));
    change(directory, 'workspace-visual-sovereign');
    const sharedDirectorySelected = await waitFor(() => ready('workspace-visual-sovereign', 'consequential'));
    change(project, 'project-visual-sovereign');
    const sameDirectorySwitchRestoresProject = await waitFor(async () => ready('workspace-visual-sovereign', 'consequential') &&
      (await window.sovereign.getState()).activeDesktopWorkspace?.projectId === 'project-visual-sovereign');
    change(directory, 'workspace-visual-sovereign-chosen');
    await waitFor(() => ready('workspace-visual-sovereign-chosen', 'workspace'));
    change(project, 'project-visual-sample-clipboard');
    await waitFor(() => ready('workspace-visual-sovereign', 'consequential'));
    await window.sovereign.invokeTool('visual.fixture.fail-project-activation', { workspaceId: 'workspace-visual-sovereign-chosen' });
    change(project, 'project-visual-sovereign');
    const failedActivationRetainsDirectories = await waitFor(() => status.getAttribute('role') === 'alert' &&
      status.textContent?.includes('unavailable') && !directory.disabled && directory.options.length === 2 &&
      Array.from(directory.options).some((option) => option.value === 'workspace-visual-sovereign'));
    await window.sovereign.invokeTool('visual.fixture.fail-project-activation', { workspaceId: 'workspace-visual-sovereign-chosen' });
    const taskDetailReopened = await openTask();
    if (!technical?.matches(':popover-open')) document.querySelector('#task-info-toggle')?.click();
    if (technicalDetails instanceof HTMLDetailsElement) technicalDetails.open = true;
    document.querySelector('#task-detail-open-terminal')?.click();
    const failedTerminalReturnsToDirectory = await waitFor(() => document.querySelector('#task-hub-list-pane')?.hidden === false &&
      status.getAttribute('role') === 'alert' && !directory.disabled && directory.options.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 3400));
    const toast = document.querySelector('#toast');
    const errorToast = toast instanceof HTMLElement ? { hidden:toast.hidden, role:toast.getAttribute('role'),
      live:toast.getAttribute('aria-live'), text:toast.textContent } : null;
    const errorRemainsReadable = toast instanceof HTMLElement && !toast.hidden && toast.getAttribute('role') === 'alert' &&
      toast.getAttribute('aria-live') === 'assertive' && toast.textContent.includes('Choose a working directory');
    document.querySelector('#toast-dismiss')?.click();
    const errorCanBeDismissed = toast?.hidden === true;
    change(directory, 'workspace-visual-sovereign');
    const alternateDirectoryRecovers = await waitFor(() => ready('workspace-visual-sovereign', 'consequential'));
    if(projectChooser instanceof HTMLDetailsElement) projectChooser.open=true;
    const controlFocus = directory;
    controlFocus.focus();
    document.querySelector('#task-hub-refresh')?.click();
    const refreshKeepsSelection = await waitFor(() => !document.querySelector('#task-hub-refresh')?.disabled &&
      directory === document.querySelector('#task-project-workspace-select') && document.activeElement === controlFocus &&
      ready('workspace-visual-sovereign', 'consequential'));
    change(project, '');
    const allProjectsRestored = await waitFor(() => section.hidden && project.value === '');
    if(projectChooser instanceof HTMLDetailsElement) projectChooser.open=false;

    return { ok: initialDirectory && chosenDirectory && directoryPermissionsAccessible && permissionIsDraft && permissionDraftReady && permissionSaved && otherProject && separatePermissions &&
      rememberedSelection && restoredDirectory && baseUnchanged && taskDetailOpened && terminalActionVisible && terminalOpened && terminalUsesSelectedDirectory &&
      summaryShowsSelectedDirectory && returningToTasksKeepsProject && savedDirectorySelectable && sharedDirectorySelected &&
      sameDirectorySwitchRestoresProject && failedActivationRetainsDirectories && taskDetailReopened && failedTerminalReturnsToDirectory &&
      alternateDirectoryRecovers && refreshKeepsSelection && allProjectsRestored && errorRemainsReadable && errorCanBeDismissed,
      initialDirectory, chosenDirectory, permissionSaved, otherProject, separatePermissions, rememberedSelection,
      restoredDirectory, baseUnchanged, savedDirectorySelectable, refreshKeepsSelection, allProjectsRestored,
      taskDetailOpened, terminalOpened, terminalUsesSelectedDirectory, summaryShowsSelectedDirectory, returningToTasksKeepsProject,
      sharedDirectorySelected, sameDirectorySwitchRestoresProject,
      failedActivationRetainsDirectories, alternateDirectoryRecovers, taskDetailReopened,
      failedTerminalReturnsToDirectory,
      directoryPermissionsAccessible, permissionIsDraft, permissionDraftReady, terminalActionVisible,
      errorRemainsReadable, errorCanBeDismissed, errorToast,
      restoredWorkspace: restoredState.activeDesktopWorkspace };
  })()`, true) as { readonly ok: boolean; readonly [key: string]: unknown };
  return result;
}
