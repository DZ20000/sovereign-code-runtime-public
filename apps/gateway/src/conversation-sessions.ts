import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { RuntimeError } from "@sovereign/runtime-core";
import type { GatewaySessionCloseReason } from "./app.js";

interface Conversation {
  readonly id: string;
  readonly transports: Set<string>;
}

/** Correlation only: the caller must already have passed bearer authentication.
 * Never pass tool arguments here. Only the MCP host's tools/call _meta belongs
 * here. Metadata does not grant capabilities, task ownership or native consent.
 * Raw host IDs are neither persisted nor returned as task session identifiers.
 */
export class ConversationSessions {
  readonly #key = randomBytes(32);
  readonly #conversations = new Map<string, Conversation>();
  readonly #transports = new Map<string, Set<string>>();
  readonly #maximumConversations: number;
  readonly #maximumPerTransport: number;

  constructor(maximumConversations = 2_048, maximumPerTransport = 16) {
    if (!Number.isSafeInteger(maximumConversations) || maximumConversations < 1 || maximumConversations > 32_768 ||
        !Number.isSafeInteger(maximumPerTransport) || maximumPerTransport < 1 || maximumPerTransport > 64) {
      throw new Error("Invalid conversation correlation capacity.");
    }
    this.#maximumConversations = maximumConversations;
    this.#maximumPerTransport = maximumPerTransport;
  }

  resolve(principalId: string, transportId: string, metadata: unknown): string {
    const session = this.#field(metadata, "openai/session");
    if (session === undefined) return transportId;
    const subject = this.#field(metadata, "openai/subject");
    const organization = this.#field(metadata, "openai/organization");
    const key = createHmac("sha256", this.#key)
      .update(JSON.stringify([principalId, session, subject ?? null, organization ?? null]))
      .digest("hex");
    const transportKey = JSON.stringify([principalId, transportId]);
    const associations = this.#transports.get(transportKey) ?? new Set<string>();
    if (!associations.has(key) && associations.size >= this.#maximumPerTransport) {
      throw new RuntimeError("POLICY_DENIED", "This MCP transport has reached its conversation correlation capacity.", 429);
    }
    let conversation = this.#conversations.get(key);
    if (conversation === undefined) {
      if (this.#conversations.size >= this.#maximumConversations) {
        // Never evict a still-live context to accommodate untrusted metadata.
        throw new RuntimeError("POLICY_DENIED", "The Gateway conversation correlation capacity has been reached.", 429);
      }
      conversation = { id: `conversation-${randomUUID()}`, transports: new Set() };
      this.#conversations.set(key, conversation);
    }
    conversation.transports.add(transportKey);
    associations.add(key);
    this.#transports.set(transportKey, associations);
    return conversation.id;
  }

  /** Return logical sessions that actually closed. Retiring an older physical
   * transport must not revoke a conversation still attached to another live
   * transport. An explicit client DELETE or Gateway shutdown does revoke it.
   * A later correlation gets a NEW random epoch, never a reopened task lease.
   */
  closeTransport(principalId: string, transportId: string, reason: GatewaySessionCloseReason): readonly string[] {
    const transportKey = JSON.stringify([principalId, transportId]);
    const associations = this.#transports.get(transportKey);
    if (associations === undefined) return [];
    const closed: string[] = [];
    for (const key of [...associations]) {
      const conversation = this.#conversations.get(key);
      if (conversation === undefined) continue;
      conversation.transports.delete(transportKey);
      if (conversation.transports.size !== 0 && reason !== "client-delete" && reason !== "gateway-shutdown") continue;
      closed.push(conversation.id);
      this.#conversations.delete(key);
      for (const relatedTransport of conversation.transports) {
        const related = this.#transports.get(relatedTransport);
        related?.delete(key);
        if (related?.size === 0) this.#transports.delete(relatedTransport);
      }
    }
    this.#transports.delete(transportKey);
    return closed;
  }

  #field(metadata: unknown, name: string): string | undefined {
    if (metadata === undefined) return undefined;
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new RuntimeError("INVALID_INPUT", "MCP call metadata must be an object.", 400);
    }
    // Inherited members and nested arguments are not host-provided fields.
    if (!Object.hasOwn(metadata, name)) return undefined;
    const value: unknown = (metadata as Record<string, unknown>)[name];
    if (typeof value !== "string" || !/^[\x21-\x7e]{1,512}$/u.test(value)) {
      // Do not echo the rejected value: it is opaque host metadata.
      throw new RuntimeError("INVALID_INPUT", "Invalid host conversation metadata.", 400);
    }
    return value;
  }
}
