export function setTextIfChanged(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

export function setClassIfChanged(element: HTMLElement, value: string): void {
  if (element.className !== value) element.className = value;
}

export function setAttributeIfChanged(
  element: HTMLElement,
  name: string,
  value: string | null,
): void {
  if (value === null) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
    return;
  }
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

export function boundedDisplayLine(value: string, maximum = 120): string {
  const normalized = value.replace(/[\0\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

export function looksLikeRawCommand(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length === 0) return false;
  return /^(?:>|\$|PS>|cmd(?:\.exe)?\b|powershell\b|pwsh\b|git\b|pnpm\b|npm\b|yarn\b|cargo\b|rustc\b|node\b|python\b|py\b|tsc\b|vitest\b)/iu.test(normalized)
    || /(?:^|\s)(?:--[a-z][\w-]*|\/[A-Za-z]:|[A-Za-z]:\\)/u.test(normalized);
}

export function safeActivityDetail(
  preferred: string | null | undefined,
  fallback: string,
): string {
  const candidate = boundedDisplayLine(preferred ?? "", 112);
  return candidate.length === 0 || looksLikeRawCommand(candidate)
    ? fallback
    : candidate;
}
