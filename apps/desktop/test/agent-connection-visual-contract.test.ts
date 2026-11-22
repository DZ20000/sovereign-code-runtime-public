import { describe, expect, it } from "vitest";

import { renderAgentView } from "../src/renderer/view-agent.js";
import { renderOverviewView } from "../src/renderer/view-overview.js";

function ids(html: string): string[] {
  return [...html.matchAll(/\bid="([^"]+)"/gu)].map(match=>match[1]!);
}

describe("v2 connection information boundaries", () => {
  it("keeps the first screen to two client cards and moves configuration into one named dialog", () => {
    const home=renderOverviewView(), drawer=renderAgentView();
    expect(home.match(/class="v2-connection-card /gu)).toHaveLength(2);
    expect(home).toContain('id="v2-chatgpt-config"');
    expect(home).toContain('id="v2-gemini-config"');
    expect(home).not.toContain('<input');
    expect(drawer).toContain('<dialog id="connection-drawer"');
    expect(drawer).toContain('aria-labelledby="connection-drawer-title"');
    expect(drawer).toContain('id="connection-drawer-close"');
    for(const provider of ["chatgpt","gemini","advanced"]) expect(drawer).toContain('data-connection-panel="'+provider+'" hidden');
    const all=ids(home+drawer);
    expect(new Set(all).size).toBe(all.length);
    expect(drawer).not.toContain('id="web-permission-profiles"');
  });

  it("retains protected ChatGPT and Gemini fields without filling stored values", () => {
    const drawer=renderAgentView();
    for(const id of ["secure-tunnel-api-key","secure-tunnel-proxy","secure-tunnel-backup-proxy","gemini-owner-subject","gemini-introspection-authorization"]) {
      const input=drawer.match(new RegExp('<input id="'+id+'"[^>]*>','u'))?.[0];
      expect(input).toBeDefined();
      expect(input).toContain('type="password"');
      expect(input).not.toMatch(/\bvalue=/u);
    }
    for(const id of ["secure-tunnel-route-list","web-agent-endpoint","web-copy-connection","gemini-public-endpoint","gemini-listen-endpoint"]) expect(drawer).toContain('id="'+id+'"');
    expect(drawer).toContain('id="gemini-save" form="gemini-config-form"');
    expect(drawer).toContain('id="gemini-protected-dialog"');
    for(const mode of ["keep","replace","forget"]) expect(drawer).toContain('data-secret-mode="'+mode+'"');
  });

  it("offers preview and cancellation before import or protected changes reach Save", () => {
    const drawer=renderAgentView();
    for(const id of ["gemini-import-json","gemini-import-preview","gemini-import-fields","gemini-import-error","gemini-import-apply","gemini-import-cancel","gemini-preset-example","gemini-preset-manual","gemini-preset-cancel","gemini-protected-apply","gemini-protected-cancel"]) expect(drawer).toContain('id="'+id+'"');
    expect(drawer).toMatch(/id="gemini-import-apply"[^>]*disabled/u);
    expect(drawer).toContain('Protected values stay unchanged.');
    expect(drawer).toContain('Saved values are never displayed.');
  });
});
