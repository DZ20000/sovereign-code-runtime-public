export type TaskRefreshOrigin = "background" | "manual";

export interface TaskRefreshFailureDisposition {
  readonly notify: boolean;
  readonly propagate: boolean;
}

export function taskRefreshFailureDisposition(
  origin: TaskRefreshOrigin,
  manualRequested: boolean,
): TaskRefreshFailureDisposition {
  return {
    notify: manualRequested || origin === "manual",
    propagate: true,
  };
}

export function taskDetailFailureDisposition(
  origin: TaskRefreshOrigin | null,
  reveal: boolean,
): TaskRefreshFailureDisposition {
  const propagate = origin !== null;
  return {
    notify: !propagate && reveal,
    propagate,
  };
}
