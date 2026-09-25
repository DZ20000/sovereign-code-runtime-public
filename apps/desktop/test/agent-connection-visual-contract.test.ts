import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function navigationIcon(shell: string, name: string): string {
  const key = shell.indexOf(`${name}:`);
  expect(key).toBeGreaterThanOrEqual(0);
  const start = shell.indexOf("'", key);
  const end = start < 0 ? -1 : shell.indexOf("'", start + 1);
  expect(start).toBeGreaterThan(key);
  expect(end).toBeGreaterThan(start);
  return shell.slice(start + 1, end);
}

describe("ChatGPT connection visual contract", () => {
  it("uses two visible status summaries and one advanced connection fold", () => {
    const view = source("apps/desktop/src/renderer/view-agent.ts");

    expect(view).toContain("agent-status-strip-compact");
    expect(view).toContain("agent-status-strip-two");
    expect(view).not.toContain("agent-status-item-redundant");
    expect(view.match(/<div class="agent-status-item">/gu)).toHaveLength(2);
    expect(view).toContain('class="visually-hidden" aria-live="polite"');
    expect(view).toContain('id="web-session-badge"');
    expect(view.match(/<details\b/gu)).toHaveLength(1);
    expect(view).toContain(
      '<details class="agent-connection-advanced agent-advanced">',
    );
    expect(view).not.toContain("Advanced proxy and routing");
    expect(view).toContain("agent-local-connection-options");
    expect(view).toContain('id="secure-tunnel-route-list"');
    expect(view).toContain('id="web-agent-endpoint"');
    expect(view).toContain('id="web-copy-connection"');
  });

  it("removes nested bands and keeps selection restrained with keyboard focus", () => {
    const styles = source(
      "apps/desktop/src/renderer/operate-shell-connection-polish.css",
    );
    const block = styles.slice(
      styles.lastIndexOf("/* Operate connection view:"),
    );

    expect(block).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(block).toMatch(
      /:is\(\.agent-authority-section, \.agent-connect-section\)[\s\S]*?border: 0;[\s\S]*?background: transparent;/u,
    );
    expect(block).toMatch(
      /#view-agent \.agent-field \{[\s\S]*?border: 0;[\s\S]*?background: transparent;/u,
    );
    expect(
      [block, source("apps/desktop/src/renderer/ui-refinement.css")].join("\n"),
    ).toContain("box-shadow: inset 0 -2px 0 var(--ui-state)");
    expect(source("apps/desktop/src/renderer/ui-system.css")).toContain(
      "button:focus-visible",
    );
    expect(
      [block, source("apps/desktop/src/renderer/ui-system.css")].join("\n"),
    ).toContain("outline: 2px solid");
    expect(block).not.toContain("box-shadow: inset 2px 0 0");
    expect(block).not.toContain("linear-gradient");
  });

  it("keeps connection, Tasks, workflow, Terminal and Python icon semantics distinct", () => {
    const shell = source("apps/desktop/src/renderer/shell.ts");
    const connection = navigationIcon(shell, "connection");
    const tasks = navigationIcon(shell, "tasks");
    const workflow = navigationIcon(shell, "workflow");
    const terminal = navigationIcon(shell, "terminal");
    const python = navigationIcon(shell, "python");

    expect(connection).not.toContain("M3.25 3.25h9.5v7h-5");
    expect(connection).toContain("M6.15 5.15");
    expect(tasks).not.toBe(workflow);
    expect(tasks).toContain("m4.25 5.25");
    expect(terminal).not.toBe(python);
    expect(python).toContain('circle cx="7.1"');
    expect(shell).toContain('class="statusbar-local-icon"');
    expect(shell).not.toContain('class="status-dot is-local"');
  });

  it("keeps sidebar selection on a compact rail without a full-row tint or glow", () => {
    const styles = source(
      "apps/desktop/src/renderer/operate-shell-connection-polish.css",
    );
    const block = styles.slice(
      styles.lastIndexOf(
        "/* Operate shell navigation: keep selection local to its rail and icon. */",
      ),
    );

    expect(block).toMatch(
      /navigation-item:is\([\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/u,
    );
    expect(block).toContain("width: 2px");
    expect(block).toContain("left: 0");
    expect(block).toContain("color: var(--ui-accent)");
    expect(block).not.toContain("0 0 12px");
  });
});
