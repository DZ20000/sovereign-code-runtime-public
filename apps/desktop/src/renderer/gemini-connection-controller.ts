import type {
  DesktopGeminiConnectionConfigurationInput,
  DesktopGeminiConnectionStatus,
  DesktopProtectedValueUpdate,
  SovereignDesktopApi,
} from "@sovereign/control-plane-contract";
import { requiredElement } from "./connection-presentation.js";
import { EXAMPLE_GEMINI_CONFIGURATION, parseGeminiConfiguration, type GeminiPublicConfiguration } from "./gemini-configuration-import.js";

type ProtectedField = "ownerSubject" | "introspectionAuthorization";
type ProtectedDraft = Record<ProtectedField, DesktopProtectedValueUpdate>;
const configurationFields = [
  ["publicMcpUrl", "#gemini-public-url", "Public MCP URL"],
  ["oauthDiscoveryUrl", "#gemini-discovery-url", "OAuth discovery URL"],
  ["introspectionUrl", "#gemini-introspection-url", "Introspection URL"],
  ["clientId", "#gemini-client-id", "Client ID"],
  ["loopbackPort", "#gemini-port", "Local listener port"],
] as const;
const protectedFields = {
  ownerSubject: { name: "owner", input: "#gemini-owner-subject", state: "#gemini-owner-state" },
  introspectionAuthorization: { name: "authorization", input: "#gemini-introspection-authorization", state: "#gemini-authorization-state" },
} as const;
const fieldNames = Object.keys(protectedFields) as ProtectedField[];
const keep = (): ProtectedDraft => ({ ownerSubject: { action: "keep" }, introspectionAuthorization: { action: "keep" } });
const clone = (draft: ProtectedDraft): ProtectedDraft => ({ ownerSubject: { ...draft.ownerSubject }, introspectionAuthorization: { ...draft.introspectionAuthorization } });
const phaseLabels: Readonly<Record<DesktopGeminiConnectionStatus["phase"], string>> = {
  unconfigured: "Not configured", saved: "Saved", starting: "Starting…", listening: "Listening locally", error: "Needs attention",
};

export function createGeminiConnectionController(options: {
  api: Pick<SovereignDesktopApi, "getGeminiConnection" | "configureGeminiConnection" | "startGeminiConnection" | "stopGeminiConnection">;
  notify: (message: string, isError?: boolean) => void;
  onStatusChanged: () => void;
  openConfiguration: (provider: "gemini" | "advanced") => void;
}) {
  const { api, notify } = options;
  const form = requiredElement<HTMLFormElement>("#gemini-config-form");
  const primary = requiredElement<HTMLButtonElement>("#gemini-primary");
  const stop = requiredElement<HTMLButtonElement>("#gemini-stop");
  const save = requiredElement<HTMLButtonElement>("#gemini-save");
  const protectedDialog = requiredElement<HTMLDialogElement>("#gemini-protected-dialog");
  const importDialog = requiredElement<HTMLDialogElement>("#gemini-import-dialog");
  const presetDialog = requiredElement<HTMLDialogElement>("#gemini-preset-dialog");
  const dialogs = [protectedDialog, importDialog, presetDialog];
  const returnFocus = new Map<HTMLDialogElement, HTMLElement | null>();
  let status: DesktopGeminiConnectionStatus | null = null;
  let dirty = false;
  let pending = false;
  let pendingLabel = "Working…";
  let hostRunning = false;
  let revision = 0;
  let refreshPromise: Promise<void> | null = null;
  let localError: string | null = null;
  let protectedDraft = keep();
  let protectedSnapshot: ProtectedDraft | null = null;
  let editing: ProtectedDraft | null = null;
  let preview: GeminiPublicConfiguration | null = null;

  function hasProtectedValue(field: ProtectedField): boolean {
    return field === "ownerSubject" ? status?.hasOwnerSubject === true : status?.hasIntrospectionAuthorization === true;
  }
  function action(): "configure" | "advanced" | "start" | "stop" {
    if (!hostRunning) return "advanced";
    if (status?.phase === "listening" || status?.phase === "starting") return "stop";
    if (dirty || !status?.configuration || !status.hasOwnerSubject || !status.hasIntrospectionAuthorization) return "configure";
    return "start";
  }
  function renderProtectedEditor(): void {
    if (editing === null) return;
    for (const field of fieldNames) {
      const controls = protectedFields[field];
      const value = editing[field];
      for (const button of protectedDialog.querySelectorAll<HTMLButtonElement>('[data-secret-field="' + controls.name + '"]')) {
        button.setAttribute("aria-pressed", String(button.dataset.secretMode === value.action));
        button.disabled = pending;
      }
      const input = requiredElement<HTMLInputElement>(controls.input);
      input.hidden = value.action !== "replace";
      input.disabled = pending || value.action !== "replace";
      input.placeholder = field === "ownerSubject" ? "Enter owner subject" : "Enter introspection authorization";
    }
  }
  function render(): void {
    const phase = status?.phase;
    requiredElement<HTMLElement>(".gemini-connection-card").classList.toggle("is-first-configuration", status?.configuration == null);
    const badge = requiredElement<HTMLElement>("#gemini-status");
    badge.textContent = pending ? pendingLabel : phase === undefined ? "Checking…" : !hostRunning ? "Host offline" : phaseLabels[phase];
    badge.className = "connection-status state-" + (localError || phase === "error" ? "error" : hostRunning && phase === "listening" ? "success" : "neutral");
    requiredElement<HTMLElement>("#gemini-configuration-state").textContent = dirty ? "Unsaved changes" : status?.configuration ? "Saved" : "Not configured";
    requiredElement<HTMLElement>("#gemini-public-endpoint").textContent = status?.configuration?.publicMcpUrl ?? "—";
    requiredElement<HTMLButtonElement>("#gemini-copy-url").disabled = pending || !status?.configuration?.publicMcpUrl;
    const selectedAction = action();
    primary.textContent = pending ? pendingLabel : selectedAction === "configure" ? "Configure"
      : selectedAction === "advanced" ? "Open host" : selectedAction === "stop" ? "Stop" : "Start";
    primary.disabled = pending || (status === null && hostRunning);
    primary.title = selectedAction === "advanced" ? "Start the local Gateway first."
      : selectedAction === "configure" ? "Save the Gemini configuration before starting." : "";
    primary.classList.toggle("button-primary", selectedAction !== "stop");
    primary.classList.toggle("button-secondary", selectedAction === "stop");
    stop.hidden = phase !== "listening" && phase !== "starting";
    stop.disabled = pending;
    stop.classList.remove("button-primary");
    stop.classList.add("button-secondary");
    save.textContent = pending && pendingLabel === "Saving…" ? "Saving…" : "Save";
    save.disabled = pending || status === null || !dirty || dialogs.some(dialog => dialog.open);
    for (const id of ["#gemini-refresh", "#gemini-import", "#gemini-presets", "#gemini-protected-open"]) requiredElement<HTMLButtonElement>(id).disabled = pending;
    for (const input of form.querySelectorAll<HTMLInputElement>("input")) input.disabled = pending;
    for (const field of fieldNames) {
      const value = protectedDraft[field];
      requiredElement<HTMLElement>(protectedFields[field].state).textContent = value.action === "forget" ? "Will be forgotten when saved"
        : value.action === "replace" ? "Replacement ready to save" : hasProtectedValue(field) ? "Saved securely · not displayed" : "Not saved";
    }
    renderProtectedEditor();
    const error = requiredElement<HTMLElement>("#gemini-error");
    error.hidden = localError === null;
    error.textContent = localError ?? "";
    requiredElement<HTMLElement>("#gemini-listen-endpoint").textContent = status?.listenEndpoint ?? "—";
    requiredElement<HTMLElement>("#gemini-listener-note").textContent = phase === "listening"
      ? "Listening does not mean a client has connected." : "Save configuration, start the listener, then add it to your client.";
  }
  function fillPublic(configuration: Partial<GeminiPublicConfiguration> | null): void {
    for (const [key, selector] of configurationFields) {
      requiredElement<HTMLInputElement>(selector).value = String(configuration?.[key] ?? (key === "loopbackPort" ? 0 : ""));
    }
  }
  function accept(next: DesktopGeminiConnectionStatus, saved = false): void {
    status = next;
    localError = next.lastError ?? (dirty && !saved ? localError : null);
    if (saved || !dirty) fillPublic(next.configuration);
    if (saved) {
      dirty = false;
      protectedDraft = keep();
      for (const field of fieldNames) requiredElement<HTMLInputElement>(protectedFields[field].input).value = "";
    }
    render();
    options.onStatusChanged();
  }
  function configuration(): DesktopGeminiConnectionConfigurationInput | null {
    if (!form.checkValidity()) {
      localError = "Complete the required Gemini settings.";
      render();
      form.querySelector<HTMLElement>(":invalid")?.focus();
      return null;
    }
    const values: Record<string, string | number> = {};
    for (const [key, selector] of configurationFields) {
      const raw = requiredElement<HTMLInputElement>(selector).value;
      values[key] = key === "loopbackPort" ? Number(raw) : raw.trim();
    }
    try {
      return { ...parseGeminiConfiguration(JSON.stringify(values)), ownerSubject: { ...protectedDraft.ownerSubject }, introspectionAuthorization: { ...protectedDraft.introspectionAuthorization } };
    } catch (error) {
      localError = error instanceof Error ? error.message : "Gemini connection settings are invalid.";
      render();
      return null;
    }
  }
  async function operate(selectedAction: "save" | "start" | "stop"): Promise<void> {
    if (pending || status === null) return;
    const input = selectedAction === "save" ? configuration() : null;
    if (selectedAction === "save" && input === null) return;
    if (selectedAction === "start") {
      if (!hostRunning) { options.openConfiguration("advanced"); return; }
      if (dirty || !status.configuration || !status.hasOwnerSubject || !status.hasIntrospectionAuthorization) { options.openConfiguration("gemini"); return; }
    }
    revision += 1;
    pendingLabel = selectedAction === "save" ? "Saving…" : selectedAction === "start" ? "Starting…" : "Stopping…";
    pending = true;
    localError = null;
    render();
    try {
      const next = selectedAction === "save" ? await api.configureGeminiConnection(input!)
        : selectedAction === "start" ? await api.startGeminiConnection() : await api.stopGeminiConnection();
      accept(next, selectedAction === "save");
      if (selectedAction === "start" && next.phase !== "listening") notify(next.lastError ?? "Gemini listener did not start.", true);
      else if (next.phase !== "error") notify(selectedAction === "save" ? "Gemini configuration saved."
        : selectedAction === "start" ? "Gemini listener started." : "Gemini listener stopped.");
    } catch {
      localError = selectedAction === "save" ? "Could not save Gemini configuration."
        : selectedAction === "start" ? "Could not start the Gemini listener." : "Could not stop the Gemini listener.";
      notify(localError, true);
    } finally {
      pending = false;
      render();
    }
  }
  async function refresh(): Promise<void> {
    if (pending) return;
    if (refreshPromise !== null) return refreshPromise;
    const observedRevision = revision;
    refreshPromise = (async () => {
      try {
        const next = await api.getGeminiConnection();
        if (!pending && observedRevision === revision) accept(next);
      } catch {
        if (!pending && observedRevision === revision) { localError = "Could not read Gemini connection status."; render(); }
      }
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  function showDialog(dialog: HTMLDialogElement): void {
    if (pending) return;
    returnFocus.set(dialog, document.activeElement instanceof HTMLElement ? document.activeElement : null);
    dialog.returnValue = "";
    if (!dialog.open) dialog.showModal();
    render();
  }
  for (const dialog of dialogs) {
    dialog.addEventListener("cancel", event => { event.preventDefault(); dialog.close("cancel"); });
    dialog.addEventListener("close", () => {
      if (dialog === protectedDialog) {
        if (dialog.returnValue !== "apply" && protectedSnapshot !== null) protectedDraft = clone(protectedSnapshot);
        protectedSnapshot = null;
        editing = null;
        for (const field of fieldNames) requiredElement<HTMLInputElement>(protectedFields[field].input).value = "";
      }
      if (dialog === importDialog) { preview = null; requiredElement<HTMLTextAreaElement>("#gemini-import-json").value = ""; }
      render();
      const target = returnFocus.get(dialog);
      if (target?.isConnected) target.focus();
      returnFocus.delete(dialog);
    });
  }
  requiredElement<HTMLButtonElement>("#gemini-protected-open").addEventListener("click", () => {
    if (pending) return;
    protectedSnapshot = clone(protectedDraft);
    editing = clone(protectedDraft);
    for (const field of fieldNames) {
      const value = editing[field];
      requiredElement<HTMLInputElement>(protectedFields[field].input).value = value.action === "replace" ? value.value : "";
    }
    requiredElement<HTMLElement>("#gemini-protected-note").textContent = "Saved values are never displayed.";
    showDialog(protectedDialog);
  });
  for (const field of fieldNames) {
    const controls = protectedFields[field];
    const input = requiredElement<HTMLInputElement>(controls.input);
    for (const mode of ["keep", "replace", "forget"] as const) {
      requiredElement<HTMLButtonElement>("#gemini-" + mode + "-" + controls.name).addEventListener("click", () => {
        if (editing === null || pending) return;
        editing[field] = mode === "replace" ? { action: "replace", value: input.value } : { action: mode };
        if (mode !== "replace") input.value = "";
        renderProtectedEditor();
        if (mode === "replace") input.focus();
      });
    }
    input.addEventListener("input", () => {
      if (editing !== null && editing[field].action === "replace") editing[field] = { action: "replace", value: input.value };
    });
  }
  requiredElement<HTMLButtonElement>("#gemini-protected-cancel").addEventListener("click", () => protectedDialog.close("cancel"));
  requiredElement<HTMLButtonElement>("#gemini-protected-apply").addEventListener("click", () => {
    if (editing === null || pending) return;
    for (const field of fieldNames) {
      const value = editing[field];
      if (value.action === "replace" && value.value.length === 0) {
        requiredElement<HTMLElement>("#gemini-protected-note").textContent = "Enter a replacement value or choose Keep or Clear.";
        requiredElement<HTMLInputElement>(protectedFields[field].input).focus();
        return;
      }
    }
    const changed = fieldNames.some(field => {
      const before = protectedDraft[field], next = editing![field];
      return before.action !== next.action || (before.action === "replace" && next.action === "replace" && before.value !== next.value);
    });
    protectedDraft = clone(editing);
    dirty ||= changed;
    localError = null;
    protectedDialog.close("apply");
  });
  function clearPreview(): void {
    preview = null;
    requiredElement<HTMLButtonElement>("#gemini-import-apply").disabled = true;
    requiredElement<HTMLElement>("#gemini-import-fields").hidden = true;
    requiredElement<HTMLElement>("#gemini-import-error").hidden = true;
  }
  requiredElement<HTMLButtonElement>("#gemini-import").addEventListener("click", () => { clearPreview(); showDialog(importDialog); requiredElement<HTMLTextAreaElement>("#gemini-import-json").focus(); });
  requiredElement<HTMLTextAreaElement>("#gemini-import-json").addEventListener("input", clearPreview);
  requiredElement<HTMLButtonElement>("#gemini-import-preview").addEventListener("click", () => {
    clearPreview();
    const error = requiredElement<HTMLElement>("#gemini-import-error");
    try {
      preview = parseGeminiConfiguration(requiredElement<HTMLTextAreaElement>("#gemini-import-json").value);
      const fields = requiredElement<HTMLElement>("#gemini-import-fields");
      fields.replaceChildren();
      for (const [key, , label] of configurationFields) {
        const row = document.createElement("div"), term = document.createElement("dt"), value = document.createElement("dd");
        term.textContent = label;
        value.textContent = String(preview[key]);
        value.dataset.noI18n = "";
        row.append(term, value);
        fields.append(row);
      }
      fields.hidden = false;
      requiredElement<HTMLButtonElement>("#gemini-import-apply").disabled = false;
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : "Gemini connection settings are invalid.";
      error.hidden = false;
    }
  });
  requiredElement<HTMLButtonElement>("#gemini-import-apply").addEventListener("click", () => {
    if (preview === null || pending) return;
    fillPublic(preview);
    dirty = true;
    localError = null;
    importDialog.close("apply");
  });
  requiredElement<HTMLButtonElement>("#gemini-import-cancel").addEventListener("click", () => importDialog.close("cancel"));
  requiredElement<HTMLButtonElement>("#gemini-presets").addEventListener("click", () => showDialog(presetDialog));
  for (const [id, configuration] of [["#gemini-preset-example", EXAMPLE_GEMINI_CONFIGURATION], ["#gemini-preset-manual", null]] as const) {
    requiredElement<HTMLButtonElement>(id).addEventListener("click", () => {
      if (pending) return;
      fillPublic(configuration);
      dirty = true;
      localError = null;
      presetDialog.close("apply");
    });
  }
  requiredElement<HTMLButtonElement>("#gemini-preset-cancel").addEventListener("click", () => presetDialog.close("cancel"));
  for (const [, selector] of configurationFields) requiredElement<HTMLInputElement>(selector).addEventListener("input", () => { dirty = true; localError = null; render(); });
  primary.addEventListener("click", () => {
    const selected = action();
    if (selected === "advanced" || selected === "configure") options.openConfiguration(selected === "advanced" ? "advanced" : "gemini");
    else void operate(selected);
  });
  stop.addEventListener("click", () => void operate("stop"));
  form.addEventListener("submit", event => { event.preventDefault(); if (!dialogs.some(dialog => dialog.open)) void operate("save"); });
  requiredElement<HTMLButtonElement>("#gemini-refresh").addEventListener("click", () => void refresh());
  requiredElement<HTMLButtonElement>("#gemini-copy-url").addEventListener("click", () => {
    const url = status?.configuration?.publicMcpUrl;
    if (!url || pending) return;
    void navigator.clipboard.writeText(url).then(() => notify("Public MCP address copied.")).catch(() => { localError = "Could not copy the public MCP address."; render(); });
  });
  render();
  return {
    refresh,
    cancelDialogs() { for (const dialog of dialogs) if (dialog.open) dialog.close("cancel"); },
    get status() { return status; },
    setHostRunning(value: boolean) { hostRunning = value; render(); },
  };
}
