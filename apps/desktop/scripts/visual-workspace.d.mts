export interface VisualWorkspace {
  readonly repositoryRoot: string;
  readonly outputRoot: string;
  readonly userDataRoot: string;
  readonly runId: string;
}
export function createVisualWorkspace(repositoryPath: string): VisualWorkspace;
export function validateVisualWorkspace(repositoryPath: string, environment: NodeJS.ProcessEnv): VisualWorkspace;
export function removeVisualProfile(workspace: VisualWorkspace): Promise<void>;
