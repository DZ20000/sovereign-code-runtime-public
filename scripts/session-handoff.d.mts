export type SessionHandoffRole = "main" | "support";
export type SessionHandoffReason =
  "context-limit" | "connection-stop" | "compaction" | "manual";
export type SessionHandoffValidationStatus =
  "passed" | "failed" | "blocked" | "not-run";

export interface SessionHandoffContinuationInput {
  readonly epoch: number;
  readonly previousAnchorId?: string;
}

export interface SessionHandoffValidationInput {
  readonly name: string;
  readonly status: SessionHandoffValidationStatus;
  readonly summary?: string;
}

export interface SessionHandoffTaskInput {
  readonly id?: string;
  readonly title: string;
  readonly goal: string;
  readonly currentStep: string;
  readonly completed?: readonly string[];
  readonly remaining?: readonly string[];
  readonly decisions?: readonly string[];
  readonly limitations?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly validation?: readonly SessionHandoffValidationInput[];
}

export interface SessionHandoffInput {
  readonly schemaVersion: "scr.session-handoff-input/v1";
  readonly sessionRole?: SessionHandoffRole;
  readonly reason?: SessionHandoffReason;
  readonly task: SessionHandoffTaskInput;
  readonly continuation?: SessionHandoffContinuationInput;
}

export interface SessionContinuationAnchor {
  readonly schemaVersion: "scr.session-continuation-anchor/v1";
  readonly anchorId: string;
  readonly taskId: string;
  readonly epoch: number;
  readonly previousAnchorId: string | null;
  readonly generatedAt: string;
  readonly repositoryRoot: string;
  readonly branch: string | null;
  readonly head: string;
  readonly inputDigest: string;
  readonly bodyDigest: string;
}

export interface SessionHandoffWorktreeEvidence {
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly detached: boolean;
  readonly locked: boolean;
}

export interface SessionHandoffCommitEvidence {
  readonly commit: string;
  readonly authoredAt: string;
  readonly subject: string;
}

export interface SessionHandoffGitEvidence {
  readonly repositoryRoot: string;
  readonly commonGitDirectory: string;
  readonly worktreeName: string;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly head: string;
  readonly headSubject: string;
  readonly dirty: boolean;
  readonly status: readonly string[];
  readonly statusTruncated: boolean;
  readonly recentCommits: readonly SessionHandoffCommitEvidence[];
  readonly registeredWorktreeCount: number;
  readonly worktrees: readonly SessionHandoffWorktreeEvidence[];
  readonly currentWorktree: SessionHandoffWorktreeEvidence | null;
}

export interface SessionHandoffResult {
  readonly schemaVersion: "scr.session-handoff/v1";
  readonly generatedAt: string;
  readonly outputPath: string;
  readonly relativeOutputPath: string;
  readonly inputDigest: string;
  readonly continuationAnchor: SessionContinuationAnchor | null;
  readonly git: SessionHandoffGitEvidence;
}

export interface SessionHandoffCliOptions {
  readonly root: string;
  readonly input: string | null;
  readonly stdin: boolean;
  readonly output: string;
}

export function validateHandoffInput(input: unknown): Required<
  Pick<SessionHandoffInput, "schemaVersion" | "sessionRole" | "reason">
> & {
  readonly task: {
    readonly id: string | null;
    readonly title: string;
    readonly goal: string;
    readonly currentStep: string;
    readonly completed: readonly string[];
    readonly remaining: readonly string[];
    readonly decisions: readonly string[];
    readonly limitations: readonly string[];
    readonly openQuestions: readonly string[];
    readonly validation: readonly {
      readonly name: string;
      readonly status: SessionHandoffValidationStatus;
      readonly summary: string | null;
    }[];
  };
  readonly continuation: {
    readonly epoch: number;
    readonly previousAnchorId: string | null;
  } | null;
};

export function verifySessionContinuationAnchor(
  markdown: string,
  expected?: Partial<
    Pick<
      SessionContinuationAnchor,
      | "taskId"
      | "epoch"
      | "previousAnchorId"
      | "repositoryRoot"
      | "branch"
      | "head"
      | "inputDigest"
    >
  >,
): SessionContinuationAnchor;

export function collectGitEvidence(
  root: string,
): Promise<SessionHandoffGitEvidence>;

export function createSessionHandoff(options: {
  readonly root: string;
  readonly input: SessionHandoffInput;
  readonly output?: string;
}): Promise<SessionHandoffResult>;

export function parseCliArguments(
  argv: readonly string[],
): SessionHandoffCliOptions;

export function runSessionHandoffCli(
  argv: readonly string[],
): Promise<SessionHandoffResult>;
