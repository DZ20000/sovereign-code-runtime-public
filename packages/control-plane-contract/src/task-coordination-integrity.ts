import type {
  TaskCoordinationDeliveryState,
  TaskCoordinationMessage,
} from "./task-coordination.js";

function inconsistentDeliveryHistory(detail: string): never {
  throw new Error(
    `Coordination inbox contains inconsistent causal delivery history: ${detail}.`,
  );
}

function timestamp(value: string | null, label: string): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    inconsistentDeliveryHistory(`${label} is not a timestamp`);
  }
  return parsed;
}

function requireOrdered(
  earlier: number | null,
  later: number | null,
  relationship: string,
): void {
  if (earlier !== null && later !== null && earlier > later) {
    inconsistentDeliveryHistory(relationship);
  }
}

function derivedState(
  message: TaskCoordinationMessage,
  expired: boolean,
): TaskCoordinationDeliveryState {
  if (message.repliedAt !== null) return "replied";
  if (message.acknowledgedAt !== null) return "acknowledged";
  if (message.cancelledAt !== null) return "cancelled";
  if (!message.requiresAcknowledgement && message.readAt !== null) {
    return "read";
  }
  if (expired) return "expired";
  if (message.readAt !== null) return "read";
  if (message.deliveredAt !== null) return "delivered";
  if (!message.recipient.principalCurrent) return "recipient-changed";
  return "queued";
}

/**
 * Verifies the cross-field invariants emitted by the persisted coordination
 * state machine. Callers still validate individual field shapes and page
 * identity before invoking this causal check.
 */
export function validateTaskCoordinationMessageCausality(
  message: TaskCoordinationMessage,
  generatedAt: string,
): void {
  const generated = timestamp(generatedAt, "snapshot generation time");
  const created = timestamp(message.createdAt, "creation time");
  if (generated === null || created === null || created > generated) {
    inconsistentDeliveryHistory("creation is later than the snapshot");
  }

  const expires = timestamp(message.expiresAt, "expiry time");
  const delivered = timestamp(message.deliveredAt, "delivery time");
  const read = timestamp(message.readAt, "read time");
  const acknowledged = timestamp(
    message.acknowledgedAt,
    "acknowledgement time",
  );
  const replied = timestamp(message.repliedAt, "reply time");
  const cancelled = timestamp(message.cancelledAt, "cancellation time");
  const expiredAt = timestamp(message.expiredAt, "derived expiry time");

  if (expires !== null && expires <= created) {
    inconsistentDeliveryHistory("expiry is not later than creation");
  }
  for (const [label, value] of [
    ["delivery", delivered],
    ["read", read],
    ["acknowledgement", acknowledged],
    ["reply", replied],
    ["cancellation", cancelled],
  ] as const) {
    if (value !== null && (value < created || value > generated)) {
      inconsistentDeliveryHistory(`${label} is outside the snapshot lifetime`);
    }
  }

  const deliveredIdentity = [
    message.recipient.deliveredSessionId,
    message.recipient.deliveredAgentId,
    message.recipient.deliveredAgentName,
  ];
  const identityCount = deliveredIdentity.filter(
    (value) => value !== null,
  ).length;
  if (identityCount !== 0 && identityCount !== deliveredIdentity.length) {
    inconsistentDeliveryHistory("delivered identity is partial");
  }
  if ((delivered !== null) !== (identityCount === deliveredIdentity.length)) {
    inconsistentDeliveryHistory(
      "delivery time and delivered identity do not appear together",
    );
  }
  if (
    message.recipient.ownershipCurrent &&
    !message.recipient.principalCurrent
  ) {
    inconsistentDeliveryHistory(
      "ownership cannot remain current after the recipient principal changed",
    );
  }

  if (read !== null && delivered === null) {
    inconsistentDeliveryHistory("read receipt has no delivery receipt");
  }
  if (acknowledged !== null && read === null) {
    inconsistentDeliveryHistory("acknowledgement has no read receipt");
  }
  if (replied !== null && acknowledged === null) {
    inconsistentDeliveryHistory("reply has no acknowledgement receipt");
  }
  if (
    acknowledged !== null &&
    !message.requiresAcknowledgement &&
    replied === null
  ) {
    inconsistentDeliveryHistory(
      "a no-acknowledgement message was acknowledged without a reply",
    );
  }
  if (cancelled !== null && (acknowledged !== null || replied !== null)) {
    inconsistentDeliveryHistory(
      "cancellation conflicts with acknowledgement or reply",
    );
  }

  requireOrdered(delivered, read, "read precedes delivery");
  requireOrdered(read, acknowledged, "acknowledgement precedes read");
  requireOrdered(acknowledged, replied, "reply precedes acknowledgement");
  requireOrdered(delivered, cancelled, "cancellation precedes delivery");
  requireOrdered(read, cancelled, "cancellation precedes read");

  if (expires !== null) {
    for (const [label, value] of [
      ["delivery", delivered],
      ["read", read],
      ["acknowledgement", acknowledged],
      ["cancellation", cancelled],
    ] as const) {
      if (value !== null && value >= expires) {
        inconsistentDeliveryHistory(`${label} occurred after expiry`);
      }
    }
  }

  const expired = expires !== null && expires <= generated;
  if (expired) {
    if (expiredAt === null || expiredAt !== expires) {
      inconsistentDeliveryHistory(
        "derived expiry does not match the persisted expiry",
      );
    }
  } else if (expiredAt !== null) {
    inconsistentDeliveryHistory("derived expiry exists before expiry");
  }

  const expectedState = derivedState(message, expired);
  if (message.deliveryState !== expectedState) {
    inconsistentDeliveryHistory(
      `delivery state ${message.deliveryState} should be ${expectedState}`,
    );
  }
}
