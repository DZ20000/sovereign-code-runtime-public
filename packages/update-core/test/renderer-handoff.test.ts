import { describe, expect, it } from "vitest";

import {
  RENDERER_HANDOFF_SCHEMA_VERSION,
  RendererHandoffVault,
  parseRendererHandoffEnvelope,
  parseRendererHandoffState,
  type RendererHandoffStorage,
} from "../src/renderer-handoff.js";

class MemoryStorage implements RendererHandoffStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function state() {
  return {
    viewId: "tasks",
    settingsTab: "diagnostics",
    selectedTaskId: "task-1",
    selectedRunId: null,
    focusKey: "task-message-input",
    scrollPositions: [
      { key: "main", top: 120, left: 0 },
      { key: "task-thread", top: 640, left: 0 },
    ],
    drafts: [{ key: "task:task-1", value: "Unsent operator message" }],
  } as const;
}

describe("RendererHandoffVault", () => {
  it("creates a digest-bound one-time handoff for one release generation", () => {
    const storage = new MemoryStorage();
    const vault = new RendererHandoffVault({
      storage,
      now: () => 1_000,
      randomId: () => "handoff-fixed-1",
    });
    const envelope = vault.create({
      sourceReleaseId: "renderer-release-1",
      targetReleaseId: "renderer-release-2",
      targetGeneration: 2,
      ttlMs: 5_000,
      state: state(),
    });

    expect(envelope).toMatchObject({
      schemaVersion: RENDERER_HANDOFF_SCHEMA_VERSION,
      handoffId: "handoff-fixed-1",
      sourceReleaseId: "renderer-release-1",
      targetReleaseId: "renderer-release-2",
      targetGeneration: 2,
      createdAt: 1_000,
      expiresAt: 6_000,
      state: state(),
    });
    expect(envelope.stateSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      vault.consume({
        targetReleaseId: "renderer-release-2",
        targetGeneration: 2,
      }),
    ).toEqual(envelope);
    expect(
      vault.consume({
        targetReleaseId: "renderer-release-2",
        targetGeneration: 2,
      }),
    ).toBeNull();
  });

  it("removes and rejects a handoff bound to another target", () => {
    const storage = new MemoryStorage();
    const vault = new RendererHandoffVault({
      storage,
      now: () => 1_000,
      randomId: () => "handoff-fixed-2",
    });
    vault.create({
      sourceReleaseId: "renderer-release-1",
      targetReleaseId: "renderer-release-2",
      targetGeneration: 2,
      state: state(),
    });

    expect(() =>
      vault.consume({
        targetReleaseId: "renderer-release-3",
        targetGeneration: 3,
      }),
    ).toThrow(/different release or generation/u);
    expect(storage.values.size).toBe(0);
  });

  it("rejects expired state and consumes it before returning the error", () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const vault = new RendererHandoffVault({
      storage,
      now: () => now,
      randomId: () => "handoff-expired",
    });
    vault.create({
      sourceReleaseId: "renderer-release-1",
      targetReleaseId: "renderer-release-2",
      targetGeneration: 2,
      ttlMs: 10,
      state: state(),
    });
    now = 1_011;

    expect(() =>
      vault.consume({
        targetReleaseId: "renderer-release-2",
        targetGeneration: 2,
      }),
    ).toThrow(/expired/u);
    expect(storage.values.size).toBe(0);
  });

  it("detects stored state tampering before exposing any UI state", () => {
    const storage = new MemoryStorage();
    const vault = new RendererHandoffVault({
      storage,
      now: () => 1_000,
      randomId: () => "handoff-tamper",
    });
    vault.create({
      sourceReleaseId: "renderer-release-1",
      targetReleaseId: "renderer-release-2",
      targetGeneration: 2,
      state: state(),
    });
    const [key, raw] = [...storage.values.entries()][0]!;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const storedState = value.state as Record<string, unknown>;
    storedState.viewId = "settings";
    storage.values.set(key, JSON.stringify(value));

    expect(() =>
      vault.consume({
        targetReleaseId: "renderer-release-2",
        targetGeneration: 2,
      }),
    ).toThrow(/digest does not match/u);
    expect(storage.values.size).toBe(0);
  });

  it("rejects unknown fields, duplicate keys, unsafe controls, and oversized drafts", () => {
    expect(() =>
      parseRendererHandoffState({
        ...state(),
        unexpected: true,
      }),
    ).toThrow(/unsupported fields/u);
    expect(() =>
      parseRendererHandoffState({
        ...state(),
        scrollPositions: [
          { key: "main", top: 0, left: 0 },
          { key: "main", top: 1, left: 0 },
        ],
      }),
    ).toThrow(/duplicated/u);
    expect(() =>
      parseRendererHandoffState({
        ...state(),
        focusKey: "bad\nfocus",
      }),
    ).toThrow(/focus key/u);
    expect(() =>
      parseRendererHandoffState({
        ...state(),
        drafts: Array.from({ length: 5 }, (_, index) => ({
          key: `draft-${index}`,
          value: "x".repeat(16_384),
        })),
      }),
    ).toThrow(/byte limit/u);
  });

  it("rejects an envelope whose digest or expiry window is not canonical", () => {
    const storage = new MemoryStorage();
    const vault = new RendererHandoffVault({
      storage,
      now: () => 1_000,
      randomId: () => "handoff-envelope",
    });
    const envelope = vault.create({
      sourceReleaseId: "renderer-release-1",
      targetReleaseId: "renderer-release-2",
      targetGeneration: 2,
      state: state(),
    });

    expect(() =>
      parseRendererHandoffEnvelope({
        ...envelope,
        stateSha256: "0".repeat(64),
      }),
    ).toThrow(/digest does not match/u);
    expect(() =>
      parseRendererHandoffEnvelope({
        ...envelope,
        expiresAt: envelope.createdAt + 10 * 60_000,
      }),
    ).toThrow(/expiry window/u);
  });

  it("clears any pending handoff explicitly", () => {
    const storage = new MemoryStorage();
    const vault = new RendererHandoffVault({
      storage,
      now: () => 1_000,
      randomId: () => "handoff-clear",
    });
    vault.create({
      sourceReleaseId: "renderer-release-1",
      targetReleaseId: "renderer-release-2",
      targetGeneration: 2,
      state: state(),
    });
    vault.clear();
    expect(storage.values.size).toBe(0);
  });
});
