import { describe, expect, it } from "vitest";
import { ConversationSessions } from "../src/conversation-sessions.js";

const meta = (id = "host-conversation-A") => ({ "openai/session": id, "openai/subject": "host-user-A" });

describe("authenticated host conversation correlation", () => {
  it("keeps a logical epoch across different physical MCP sessions", () => {
    const store = new ConversationSessions();
    const a = store.resolve("owner", "transport-a", meta());
    expect(store.resolve("owner", "transport-b", meta())).toBe(a);
    expect(a).toMatch(/^conversation-[a-f0-9-]{36}$/u);
    expect(a).not.toContain("host-conversation");
  });
  it("isolates conversation, principal, subject and organization", () => {
    const store = new ConversationSessions();
    const a = store.resolve("owner", "one", meta());
    expect(store.resolve("owner", "two", meta("another-conversation"))).not.toBe(a);
    expect(store.resolve("another-owner", "one", meta())).not.toBe(a);
    expect(store.resolve("owner", "three", { ...meta(), "openai/subject": "another-user" })).not.toBe(a);
    expect(store.resolve("owner", "four", { ...meta(), "openai/organization": "another-org" })).not.toBe(a);
  });
  it("uses physical sessions unchanged without host conversation metadata", () => {
    const store = new ConversationSessions();
    expect(store.resolve("owner", "one", undefined)).toBe("one");
    expect(store.resolve("owner", "two", {})).toBe("two");
    expect(store.resolve("owner", "three", { "openai/userAgent": "ChatGPT", "openai/userLocation": { city: "test" } })).toBe("three");
  });
  it("never reads a model argument or inherited property as host metadata", () => {
    const store = new ConversationSessions();
    expect(store.resolve("owner", "one", { arguments: { _meta: meta() } })).toBe("one");
    expect(store.resolve("owner", "two", Object.create(meta()))).toBe("two");
  });
  it.each([null, [], "invalid", { "openai/session": "" }, { "openai/session": 12 },
    { "openai/session": "secret\nvalue" }, { "openai/session": "x".repeat(513) },
    { ...meta(), "openai/subject": null }, { ...meta(), "openai/organization": {} },
  ])("rejects malformed correlation without echoing opaque values", value => {
    const store = new ConversationSessions();
    expect(() => store.resolve("owner", "one", value)).toThrow(/metadata/u);
    try { store.resolve("owner", "one", value); } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
    expect(store.resolve("owner", "one", meta())).toMatch(/^conversation-/u);
  });
  it.each(["transport-closed", "capacity-reclaimed", "idle-timeout"] as const)("does not confuse %s of an old transport with closing the live conversation", reason => {
    const store = new ConversationSessions();
    const a = store.resolve("owner", "one", meta());
    store.resolve("owner", "two", meta());
    expect(store.closeTransport("owner", "one", reason)).toEqual([]);
    expect(store.resolve("owner", "two", meta())).toBe(a);
    expect(store.closeTransport("owner", "two", reason)).toEqual([a]);
    expect(store.resolve("owner", "three", meta())).not.toBe(a);
  });
  it.each(["client-delete", "gateway-shutdown"] as const)("revokes shared logical epochs on explicit %s", reason => {
    const store = new ConversationSessions();
    const a = store.resolve("owner", "one", meta());
    store.resolve("owner", "two", meta());
    expect(store.closeTransport("owner", "one", reason)).toEqual([a]);
    expect(store.closeTransport("owner", "two", reason)).toEqual([]);
    expect(store.resolve("owner", "three", meta())).not.toBe(a);
  });
  it("does not allow a different principal's close to remove an association", () => {
    const store = new ConversationSessions();
    const a = store.resolve("owner", "one", meta());
    expect(store.closeTransport("other", "one", "client-delete")).toEqual([]);
    expect(store.resolve("owner", "one", meta())).toBe(a);
  });
  it("bounds live contexts without evicting an approved context", () => {
    const store = new ConversationSessions(2, 2);
    const a = store.resolve("owner", "one", meta("A"));
    store.resolve("owner", "one", meta("B"));
    expect(() => store.resolve("owner", "one", meta("C"))).toThrow(/capacity/u);
    expect(() => store.resolve("owner", "two", meta("C"))).toThrow(/capacity/u);
    expect(store.resolve("owner", "one", meta("A"))).toBe(a);
    expect(store.closeTransport("owner", "one", "client-delete")).toHaveLength(2);
    expect(store.resolve("owner", "two", meta("A"))).not.toBe(a);
  });
  it("has no persisted affinity or grants across a Gateway restart", () => {
    const a = new ConversationSessions().resolve("owner", "one", meta());
    expect(new ConversationSessions().resolve("owner", "one", meta())).not.toBe(a);
  });
});
