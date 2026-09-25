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
    const project = document.querySelector('#task-project-select');
    const directory = document.querySelector('#task-project-workspace-select');
    const permission = document.querySelector('#task-project-workspace-permission');
    const choose = document.querySelector('#task-project-workspace-choose');
    const section = document.querySelector('#task-project-workspace');
    const status = document.querySelector('#task-project-workspace-status');
    if (!(project instanceof HTMLSelectElement) || !(directory instanceof HTMLSelectElement) ||
      !(permission instanceof HTMLSelectElement) || !(choose instanceof HTMLButtonElement) ||
      !(section instanceof HTMLElement) || !(status instanceof HTMLElement)) {
      return { ok: false, reason: 'project working directory controls missing' };
    }
    const change = (element, value) => {
      element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const baseline = await window.sovereign.getState();
    const ready = (workspaceId, profile) => !directory.disabled && directory.value === workspaceId &&
      permission.value === profile && !permission.disabled && section.getAttribute('aria-busy') === 'false' &&
      status.getAttribute('role') === 'status';

    change(project, 'project-visual-sovereign');
    const initialDirectory = await waitFor(() => ready('workspace-visual-sovereign', 'consequential'));
    choose.click();
    const chosenDirectory = await waitFor(() => ready('workspace-visual-sovereign-chosen', 'observe') && directory.options.length === 2);
    const permissionDetails = permission.closest('details');
    permissionDetails?.querySelector('summary')?.click();
    const directoryPermissionsAccessible = await waitFor(() => permissionDetails instanceof HTMLDetailsElement &&
      permissionDetails.open && permission.getBoundingClientRect().height > 0 &&
      document.querySelector('label[for="task-project-workspace-permission"]') !== null);
    change(permission, 'workspace');
    const permissionSaved = await waitFor(async () => ready('workspace-visual-sovereign-chosen', 'workspace') &&
      (await window.sovereign.readProjectWorkspaces('project-visual-sovereign')).workspaces.find(
        (workspace) => workspace.id === 'workspace-visual-sovereign-chosen')?.permissionProfile === 'workspace');

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

    document.querySelector('#task-project-grid [data-task-id="task-visual-agent-hub"]')?.click();
    const taskDetailOpened = await waitFor(() => document.querySelector('#task-detail-title')?.textContent?.trim() === 'Build task and Agent hub');
    const technical = document.querySelector('.task-technical-details');
    if (technical instanceof HTMLDetailsElement) technical.open = true;
    document.querySelector('#task-detail-open-terminal')?.click();
    const terminalOpened = await waitFor(() => document.querySelector('#view-terminal')?.classList.contains('is-active'));
    const terminalSessions = await window.sovereign.invokeTool('terminal.session.list', {});
    const terminalUsesSelectedDirectory = terminalSessions.some((session) => session.id === 'terminal-visual-project' &&
      session.workspaceId === 'workspace-visual-sovereign-chosen' && session.relativeCwd === '') &&
      terminalSessions.some((session) => session.id === 'terminal-visual-session' && session.workspaceId === 'desktop-workspace');
    const statusShowsSelectedDirectory = document.querySelector('#status-workspace')?.textContent?.trim() === 'sovereign-task-workspace';
    document.querySelector('#status-workspace-action')?.click();
    const statusRoutesToProject = await waitFor(() => document.querySelector('#view-tasks')?.classList.contains('is-active') &&
      document.querySelector('#task-hub-list-pane')?.hidden === false && project.value === 'project-visual-sovereign' &&
      ready('workspace-visual-sovereign-chosen', 'workspace'));

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
    document.querySelector('#task-project-grid [data-task-id="task-visual-agent-hub"]')?.click();
    await waitFor(() => document.querySelector('#task-detail-title')?.textContent?.trim() === 'Build task and Agent hub');
    if (technical instanceof HTMLDetailsElement) technical.open = true;
    document.querySelector('#task-detail-open-terminal')?.click();
    const failedTerminalReturnsToDirectory = await waitFor(() => document.querySelector('#task-hub-list-pane')?.hidden === false &&
      status.getAttribute('role') === 'alert' && !directory.disabled && directory.options.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 3400));
    const toast = document.querySelector('#toast');
    const errorRemainsReadable = toast instanceof HTMLElement && !toast.hidden && toast.getAttribute('role') === 'alert' &&
      toast.getAttribute('aria-live') === 'assertive' && toast.textContent.includes('Choose a working directory');
    document.querySelector('#toast-dismiss')?.click();
    const errorCanBeDismissed = toast?.hidden === true;
    change(directory, 'workspace-visual-sovereign');
    const alternateDirectoryRecovers = await waitFor(() => ready('workspace-visual-sovereign', 'consequential'));
    const controlFocus = directory;
    controlFocus.focus();
    document.querySelector('#task-hub-refresh')?.click();
    const refreshKeepsSelection = await waitFor(() => !document.querySelector('#task-hub-refresh')?.disabled &&
      directory === document.querySelector('#task-project-workspace-select') && document.activeElement === controlFocus &&
      ready('workspace-visual-sovereign', 'consequential'));
    if (permissionDetails instanceof HTMLDetailsElement) permissionDetails.open = false;
    change(project, '');
    const allProjectsRestored = await waitFor(() => section.hidden && project.value === '');

    return { ok: initialDirectory && chosenDirectory && directoryPermissionsAccessible && permissionSaved && otherProject && separatePermissions &&
      rememberedSelection && restoredDirectory && baseUnchanged && taskDetailOpened && terminalOpened && terminalUsesSelectedDirectory &&
      statusShowsSelectedDirectory && statusRoutesToProject && savedDirectorySelectable && sharedDirectorySelected &&
      sameDirectorySwitchRestoresProject && failedActivationRetainsDirectories && failedTerminalReturnsToDirectory &&
      alternateDirectoryRecovers && refreshKeepsSelection && allProjectsRestored && errorRemainsReadable && errorCanBeDismissed,
      initialDirectory, chosenDirectory, permissionSaved, otherProject, separatePermissions, rememberedSelection,
      restoredDirectory, baseUnchanged, savedDirectorySelectable, refreshKeepsSelection, allProjectsRestored,
      taskDetailOpened, terminalOpened, terminalUsesSelectedDirectory, statusShowsSelectedDirectory, statusRoutesToProject,
      sharedDirectorySelected, sameDirectorySwitchRestoresProject,
      failedActivationRetainsDirectories, alternateDirectoryRecovers,
      failedTerminalReturnsToDirectory,
      directoryPermissionsAccessible,
      errorRemainsReadable, errorCanBeDismissed,
      restoredWorkspace: restoredState.activeDesktopWorkspace };
  })()`, true) as { readonly ok: boolean; readonly [key: string]: unknown };
  return result;
}
