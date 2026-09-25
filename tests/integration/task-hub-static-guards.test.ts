import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import ts from "typescript";

function source(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}

describe("task and Agent hub static security guards", () => {
  it("renders untrusted task and message content through DOM text sinks only", () => {
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    expect(controller).toContain("textContent");
    expect(controller).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=/u);
    expect(controller).not.toContain("insertAdjacentHTML");
    expect(controller).not.toMatch(/\beval\s*\(/u);
    expect(controller).not.toContain("new Function");
  });

  it("keeps every task-registry SQL statement parameterized", () => {
    const registry = source(
      "packages",
      "control-plane",
      "src",
      "task-registry.ts",
    );
    const parsed = ts.createSourceFile(
      "task-registry.ts",
      registry,
      ts.ScriptTarget.Latest,
      true,
    );
    const statements: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "prepare"
      ) {
        expect(node.arguments).toHaveLength(1);
        statements.push(node.arguments[0]!);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(statements.length).toBeGreaterThan(10);
    for (const statement of statements) {
      if (ts.isTemplateExpression(statement)) {
        // Only the fixed owner-lease projection may generate SQL syntax.
        // Task/session identifiers remain bound parameters, never interpolation.
        for (const span of statement.templateSpans) {
          expect([
            'taskSessionLeaseProjection("t")',
            'taskCoordinationPendingProjection("t")',
          ]).toContain(span.expression.getText(parsed));
        }
      } else {
        expect(
          ts.isStringLiteral(statement) ||
            ts.isNoSubstitutionTemplateLiteral(statement),
        ).toBe(true);
      }
    }
    expect(registry).toContain('createHash("sha256")');
    expect(registry).toContain("#assertPrincipalCanMutate");
    expect(registry).toContain("taskForPrincipalWorkspace");
    expect(registry).toContain("snapshotForPrincipal");
    expect(
      source("packages", "control-plane", "src", "task-registry-model.ts"),
    ).toContain("realpathSync");
    expect(registry).toContain("MAX_TOTAL_TASKS");
    expect(registry).toContain("MAX_TOTAL_MESSAGES");
  });

  it("does not let a remote Agent forge local system conversation messages", () => {
    const tools = source("packages", "control-plane", "src", "task-tools.ts");
    const contract = source(
      "packages",
      "control-plane-contract",
      "src",
      "tasks.ts",
    );
    expect(tools).toContain('"assistant",');
    expect(tools).not.toContain('["assistant", "system"]');
    expect(tools).not.toContain('z.literal("system")');
    expect(contract).not.toContain("readonly role?:");
  });

  it("keeps the first-party task protocol wired through every desktop boundary", () => {
    const apiFiles = [
      ["packages", "control-plane-contract", "src", "api.ts"],
      ["apps", "desktop", "src", "task-ipc.ts"],
      ["apps", "desktop", "src", "preload.ts"],
      ["apps", "desktop-tauri", "src", "bridge.ts"],
    ] as const;
    for (const parts of apiFiles) {
      const contents = source(...parts);
      expect(contents, parts.join("/")).toContain("getTaskWorkspace");
      expect(contents, parts.join("/")).toContain("getTaskDetail");
      expect(contents, parts.join("/")).toContain("getTaskCoordinationInbox");
      expect(contents, parts.join("/")).toContain("sendTaskUserMessage");
    }
    expect(source("apps", "desktop", "src", "main.ts")).toContain(
      "registerTaskIpc(controller, assertTrustedSender)",
    );

    const protocolFiles = [
      ["packages", "control-plane-contract", "src", "protocol.ts"],
      ["apps", "runtime-host", "src", "main.ts"],
      ["apps", "desktop", "src", "runtime-host-client.ts"],
      ["apps", "desktop-tauri", "src", "bridge.ts"],
      ["apps", "desktop-tauri", "src-tauri", "src", "runtime_host.rs"],
    ] as const;
    for (const parts of protocolFiles) {
      const contents = source(...parts);
      expect(contents, parts.join("/")).toContain("tasks.snapshot");
      expect(contents, parts.join("/")).toContain("tasks.get");
      expect(contents, parts.join("/")).toContain(
        "tasks.coordination.operator-inbox",
      );
      expect(contents, parts.join("/")).toContain("tasks.message.user");
    }
  });

  it("keeps operator coordination visible and separate from Task conversation receipts", () => {
    const view = source("apps", "desktop", "src", "renderer", "view-tasks.ts");
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    const coordination = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-coordination-inbox.ts",
    );
    expect(view).toContain('id="task-coordination-list"');
    expect(view).toContain('id="task-message-list"');
    expect(view).toContain("Separate from Task conversation");
    expect(controller).toContain("this.#coordinationInbox?.refresh(taskId)");
    expect(controller).toContain("task.coordinationPendingCount");
    expect(controller).toContain(
      "coordinationPendingCount: task.coordinationPendingCount",
    );
    expect(coordination).toContain("getTaskCoordinationInbox");
    expect(coordination).toContain("replaceChildren");
    expect(coordination).toContain("textContent");
    expect(coordination).not.toContain("tasks.coordination.acknowledge");
    expect(coordination).not.toContain("sendTaskUserMessage");
    expect(coordination).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=/u);
  });

  it("runs visual validation with an isolated, disposable Electron profile", () => {
    const runner = source(
      "apps",
      "desktop",
      "scripts",
      "run-electron-visual.mjs",
    );
    const harness = source("apps", "desktop", "src", "visual-test.ts");
    expect(runner).toContain("mkdtemp");
    expect(runner).toContain("SCR_VISUAL_USER_DATA");
    expect(runner).toContain("shell: false");
    expect(runner).toContain("maxRetries: 8");
    expect(harness).toContain("USER_DATA_ROOT");
    expect(harness).toContain('app.setPath("userData", USER_DATA_ROOT)');
  });

  it("keeps the Tauri Runtime Host control whitelist synchronized with the shared protocol", () => {
    const protocol = source(
      "packages",
      "control-plane-contract",
      "src",
      "protocol.ts",
    );
    const rustHost = source(
      "apps",
      "desktop-tauri",
      "src-tauri",
      "src",
      "runtime_host.rs",
    );
    const protocolBlock = protocol.match(
      /export const CONTROL_REQUEST_METHODS = \[(?<body>[\s\S]*?)\] as const;/u,
    )?.groups?.body;
    const rustBlock = rustHost.match(
      /const CONTROL_METHODS: &\[&str\] = &\[(?<body>[\s\S]*?)\];/u,
    )?.groups?.body;
    expect(protocolBlock).toBeDefined();
    expect(rustBlock).toBeDefined();
    const methods = (block: string | undefined): string[] =>
      [...(block ?? "").matchAll(/"(?<method>[a-z0-9.-]+)"/gu)]
        .map((match) => match.groups?.method)
        .filter((method): method is string => method !== undefined);
    expect(methods(rustBlock)).toEqual(methods(protocolBlock));
  });

  it("keeps task filters single-layer and distinguishes inferred activity from bound Agents", () => {
    const view = source("apps", "desktop", "src", "renderer", "view-tasks.ts");
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    const styles = ["task-hub.css", "task-board.css"].map((file) => source("apps", "desktop", "src", "renderer", file)).join("\n");
    const progressModel = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-progress-model.ts",
    );
    expect(view).toContain('id="task-hub-progress-advisory"');
    expect(view).toContain('id="task-hub-progress-advisory-detail"');
    expect(view).toContain('id="task-board-current-count"');
    expect(view).toContain('id="task-board-activity-count"');
    expect(view).not.toContain('id="task-hub-active-count"');
    expect(view).toContain('id="task-detail-progress-note"');
    expect(view).toContain('placeholder="Search this queue"');
    expect(view).not.toContain('placeholder="Project, task, step or Agent"');
    expect(progressModel).toContain(
      "Live activity · structured progress not reported",
    );
    expect(controller).toContain("Activity detected · no task Agent");
    expect(source("apps", "desktop", "src", "renderer", "task-conversation-delivery.ts")).toContain("No task Agent assigned · stored locally");
    expect(controller).toContain("Unassigned · inferred from tool activity");
    expect(controller).toContain("isInferredTask(task)");
    expect(controller).toContain("taskHasLiveAgent");
    expect(controller).toContain("preserveSourceText");
    expect(controller).toContain('setAttribute("data-no-i18n", "")');
    expect(controller).toContain("is-indeterminate");
    const focusRule = styles.match(
      /#view-tasks :is\(input, select, textarea\):focus-visible\s*\{[^}]+\}/u,
    )?.[0];
    expect(focusRule).toBeDefined();
    expect(focusRule).toContain("outline: 2px solid var(--ui-accent)");
    expect(styles).toContain("grid-template-columns: var(--task-list-size) minmax(340px, 1fr)");
    expect(styles).toContain(".task-agent-activity");
    expect(controller).toContain('button.classList.toggle("task-source-inferred", isInferredTask(task))');
    expect(controller).toContain("userDelivery: userMessageDeliveryLabel");
    expect(controller).toContain("acknowledgedAt");
    expect(controller).toContain("Waiting for Agent");
    expect(source("apps", "desktop", "src", "renderer", "task-conversation-delivery.ts")).toContain("Delivered to Agent");
    expect(controller).toContain("next tool result");
    expect(styles).toContain(".task-message-delivery-acknowledged");
    expect(styles).toContain(".task-message-delivery-pending");
  });

  it("reconciles task step rows by identity instead of replacing the detail list", () => {
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    const stepList = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-step-list.ts",
    );
    expect(controller).toContain("reconcileTaskStepList({");
    expect(stepList).toContain("data-step-id");
    expect(stepList).toContain("container.insertBefore(row, cursor)");
    expect(stepList).toContain("if (row === cursor)");
    expect(stepList).not.toContain("container.replaceChildren()");
  });

  it("keeps the task conversation log keyboard reachable and reconciles messages by identity", () => {
    const view = source("apps", "desktop", "src", "renderer", "view-tasks.ts");
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    const messageList = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-message-list.ts",
    );
    const logTag = view.match(/<div id="task-message-list"[^>]+>/u)?.[0];
    expect(logTag).toBeDefined();
    expect(logTag).toContain('role="log"');
    expect(logTag).toContain('tabindex="0"');
    expect(logTag).toContain('aria-relevant="additions text"');
    expect(logTag).toContain('aria-atomic="false"');
    expect(logTag).toContain('aria-labelledby="task-conversation-title"');
    expect(view).toContain('role="group" aria-label="Task filters"');
    expect(view).toContain(
      'role="status" aria-live="polite" aria-atomic="true"',
    );
    expect(controller).toContain("reconcileTaskMessageList");
    expect(messageList).toContain("dataset.messageId");
    expect(messageList).toContain("container.insertBefore(row, cursor)");
    expect(messageList).toContain("sourceText");
    expect(messageList).not.toContain("replaceChildren");
    expect(messageList).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=/u);
  });

  it("restores the task list and focus target when a revealed detail request fails", () => {
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    const loadDetail = controller.match(
      /async #loadDetail\([\s\S]*?\n  #storeCurrentDraft\(/u,
    )?.[0];
    expect(loadDetail).toBeDefined();
    expect(loadDetail).toContain("if (reveal) this.showProjects();");
    expect(controller).toContain("this.#pendingListFocusTaskId = focusTaskId");
    expect(controller).toContain(
      "setTimeout(() => this.#restoreListFocus(), 0)",
    );
  });

  it("provides bounded manual refresh feedback and roving queue focus", () => {
    const view = source("apps", "desktop", "src", "renderer", "view-tasks.ts");
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    const refreshFeedback = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-refresh-feedback.ts",
    );
    const laneControls = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-lane-controls.ts",
    );
    const toolbarTag = view.match(/<div id="task-board-lanes"[^>]+>/u)?.[0];
    expect(toolbarTag).toBeDefined();
    expect(toolbarTag).toContain('role="toolbar"');
    expect(toolbarTag).toContain('aria-orientation="horizontal"');
    const laneTags = [
      ...view.matchAll(/<button id="task-board-lane-[^"]+"[^>]+>/gu),
    ].map((match) => match[0] ?? "");
    expect(laneTags).toHaveLength(5);
    expect(
      laneTags.every((tag) =>
        tag.includes('aria-controls="task-project-grid"'),
      ),
    ).toBe(true);
    expect(laneTags.filter((tag) => tag.includes('tabindex="0"'))).toHaveLength(
      1,
    );
    expect(
      laneTags.filter((tag) => tag.includes('tabindex="-1"')),
    ).toHaveLength(4);
    expect(view).toContain('id="task-hub-refresh-status"');
    expect(view).toContain(
      'aria-describedby="task-board-sync-state task-hub-refresh-status"',
    );
    expect(controller).toContain('void this.refresh("manual")');
    expect(laneControls).toContain("button.tabIndex = selected ? 0 : -1");
    expect(controller).toContain("this.#refreshFeedback?.begin()");
    expect(controller).toContain("this.#refreshFeedback?.succeed");
    expect(controller).toContain("this.#refreshFeedback?.manualFail");
    expect(controller).toContain("this.#refreshFeedback?.backgroundFail");
    expect(controller).toContain("taskRefreshFailureDisposition(");
    expect(controller).toContain(
      "taskDetailFailureDisposition(refreshOrigin, reveal)",
    );
    expect(controller).toContain("await this.refresh().catch(() => undefined)");
    expect(refreshFeedback).toContain('setAttribute("aria-busy", "true")');
    expect(refreshFeedback).toContain("Existing task data was not replaced");
  });

  it("routes refresh failures without background polling toast noise", () => {
    const main = source("apps", "desktop", "src", "renderer", "main.ts");
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    const policy = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-refresh-failure-policy.ts",
    );
    expect(main).toContain("tasksController.refresh().catch(() => undefined)");
    expect(main).toContain(
      "await Promise.all([runsController.refresh(), tasksController.refresh()])",
    );
    expect(controller).toContain(
      'void this.refresh("manual").catch(() => undefined)',
    );
    expect(controller).toContain("taskRefreshFailureDisposition(");
    expect(controller).toContain(
      "taskDetailFailureDisposition(refreshOrigin, reveal)",
    );
    expect(controller).toContain("await this.refresh().catch(() => undefined)");
    expect(policy).toContain('notify: manualRequested || origin === "manual"');
    expect(policy).toContain("propagate: true");
  });

  it("keeps one task card in the Tab order and exposes explicit filter clearing", () => {
    const view = source("apps", "desktop", "src", "renderer", "view-tasks.ts");
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    const cardNavigation = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-card-navigation.ts",
    );
    const filterControls = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-filter-controls.ts",
    );
    expect(view).toContain('id="task-hub-clear-filters"');
    expect(view).toContain('aria-keyshortcuts="Escape"');
    expect(view).toContain('role="group" aria-label="Task list"');
    expect(view).toContain(
      'aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home End Enter"',
    );
    expect(controller).toContain("new TaskFilterControls");
    expect(controller).toContain("new TaskCardNavigation");
    expect(controller).toContain("button.tabIndex = -1");
    expect(controller).toContain("this.#cardNavigation?.sync(focusedTaskId)");
    expect(controller).toContain("this.#cardNavigation?.focus(taskId, true)");
    expect(cardNavigation).toContain('addEventListener("keydown"');
    expect(cardNavigation).toContain("taskCardNavigationIndex");
    expect(cardNavigation).toContain("scrollIntoView");
    expect(filterControls).toContain('event.key !== "Escape"');
    expect(filterControls).toContain('this.#categorySelect.value = "all"');
    expect(filterControls).toContain("this.#clearButton.disabled");
    expect(filterControls).not.toContain(".focus(");
    expect(controller).toContain("if (this.#pendingListFocusTaskId !== null)");
  });

  it("hides stale task detail while a newly selected task is loading", () => {
    const view = source("apps", "desktop", "src", "renderer", "view-tasks.ts");
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    const loading = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-detail-loading.ts",
    );
    const styles = source("apps", "desktop", "src", "renderer", "task-board.css");
    expect(view).toContain('id="task-detail-loading"');
    expect(view).toContain('id="task-detail-loading-label"');
    expect(view).toContain('id="task-detail-freshness"');
    expect(view).toContain(">Snapshot unavailable</small>");
    expect(view).toContain('id="task-detail-heading"');
    expect(view).toContain('id="task-detail-heading-state"');
    expect(view).toContain('id="task-detail-layout"');
    expect(controller).toContain('setTaskDetailLoading(document, "loading")');
    expect(controller).toContain('setTaskDetailLoading(document, "ready")');
    expect(controller).toContain(
      'setTaskDetailLoading(document, "unavailable")',
    );
    expect(loading).toContain('pane.setAttribute("aria-busy", "true")');
    expect(loading).toContain('"task-detail-loading-label"');
    expect(loading).toContain(
      'pane.setAttribute("aria-describedby", "task-detail-freshness")',
    );
    expect(loading).toContain("freshness.hidden = !unavailable");
    expect(loading).toContain("requiredElement(document, id).hidden = loading");
    const hiddenBlock = [styles, source("apps", "desktop", "src", "renderer", "styles.css")]
      .join("\n")
      .match(/\[hidden\][^{]*\{[^}]*\}/gu)
      ?.find((block) => block.includes("display: none !important"));
    expect(hiddenBlock).toBeDefined();
    expect(hiddenBlock).toContain("display: none !important");
  });

  it("validates task detail identity before rendering or accepting a sent message", () => {
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    const integrity = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-detail-integrity.ts",
    );
    expect(
      controller.match(/assertTaskDetailIntegrity\(taskId, detail\)/gu),
    ).toHaveLength(2);
    expect(integrity).toContain("detail.task.id !== requestedTaskId");
    expect(integrity).toContain("message.taskId !== requestedTaskId");
    expect(integrity).toContain("message.sequence <= previousSequence");
    expect(integrity).toContain("detail.messagesTruncated !==");
    expect(integrity).toContain(
      "detail.oldestMessageSequence !== expectedOldest",
    );
    expect(integrity).toContain(
      "detail.newestMessageSequence !== expectedNewest",
    );
    expect(integrity).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=/u);
  });

  it("keeps task message submission bounded, composition-safe and draft-preserving", () => {
    const view = source("apps", "desktop", "src", "renderer", "view-tasks.ts");
    const controller = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "tasks-controller.ts",
    );
    const composer = source(
      "apps",
      "desktop",
      "src",
      "renderer",
      "task-message-composer.ts",
    );
    expect(view).toContain('maxlength="8000"');
    expect(view).toContain('aria-keyshortcuts="Enter Control+Enter Meta+Enter"');
    expect(view).toContain('id="task-message-submit-status"');
    expect(controller).toContain("taskMessageContent(input.value)");
    expect(controller).toContain("isTaskMessageSubmitShortcut(event)");
    expect(controller).toContain(
      "this.#messageSendFeedback?.begin(focusTarget)",
    );
    expect(controller).toContain("this.#messageSendFeedback?.fail(");
    expect(composer).toContain("TASK_MESSAGE_MAX_LENGTH = 8_000");
    expect(composer).toContain("!event.isComposing");
    expect(composer).toContain("this.#input.disabled = true");
    expect(composer).toContain("Message not sent. Draft preserved.");
    expect(composer).toContain("Delivery uncertain. Draft preserved.");
    expect(controller).toContain("isTaskDetailIntegrityError(error)");
    expect(controller).toContain(
      "this.#messageSendFeedback?.fail(taskStillOpen, deliveryUncertain)",
    );
    expect(controller).toContain(
      'setTaskDetailLoading(document, "unavailable")',
    );
    expect(controller).toContain(
      "Message may have been saved, but the returned snapshot failed integrity checks.",
    );
    expect(composer).toContain('focusTarget === "button"');
    expect(composer).not.toMatch(/\.(?:innerHTML|outerHTML)\s*=/u);
  });

  it("surfaces pending panel messages through a principal-scoped MCP inbox", () => {
    const tools = source("packages", "control-plane", "src", "task-tools.ts");
    const registry = source(
      "packages",
      "control-plane",
      "src",
      "task-registry.ts",
    );
    const gateway = source("apps", "gateway", "src", "app.ts");
    const controller = source(
      "packages",
      "control-plane",
      "src",
      "controller.ts",
    );
    expect(tools).toContain('name: "tasks.inbox"');
    expect(tools).toContain("before a final response");
    expect(registry).toContain("inboxForPrincipal");
    expect(registry).toContain("WHERE t.principal_id = ?");
    expect(registry).toContain("projectWithinWorkspace");
    expect(gateway).toContain("SOVEREIGN_TASK_INBOX");
    expect(gateway).toContain("operatorInboxNotice(operatorInbox)");
    expect(gateway).toContain("structuredContent: structuredToolResult");
    expect(
      [gateway, source("apps", "gateway", "src", "mcp-tool-result.ts")].join("\n"),
    ).toContain("operatorInbox: JSON.parse");
    expect(gateway).toContain("Call tasks.inbox before starting work");
    expect(gateway).toContain(
      "acknowledge its latest sequence with tasks.heartbeat",
    );
    const integration = source(
      "packages",
      "control-plane",
      "src",
      "task-gateway-integration.ts",
    );
    expect(controller).toContain("createTaskGatewayToolDefinitions(");
    expect(controller).toContain("createTaskGatewaySessionCallbacks(");
    expect(integration).toContain('"tasks.inbox"');
    expect(integration).toContain("...createTaskTools(");
  });
});
