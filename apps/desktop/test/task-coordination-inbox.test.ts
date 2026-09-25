import { describe, expect, it, vi } from "vitest";

import {
  TASK_COORDINATION_OPERATOR_INBOX_SCHEMA_VERSION,
  type TaskCoordinationMessage,
  type TaskCoordinationOperatorInbox,
} from "../src/shared.js";
import {
  loadTaskCoordinationInbox,
  taskCoordinationPendingText,
  validateTaskCoordinationInbox,
} from "../src/renderer/task-coordination-inbox.js";
import {
  TASK_BOARD_PHRASES,
  translateTaskBoardPattern,
} from "../src/renderer/task-board-localization.js";
import {
  COORDINATION_TEST_TIMESTAMPS,
  coordinationMessage,
} from "./task-coordination-test-fixture.js";

function message(
  sequence: number,
  overrides: Partial<TaskCoordinationMessage> = {},
): TaskCoordinationMessage {
  const canonical = coordinationMessage(
    "recipient-task",
    overrides.deliveryState ?? "queued",
    overrides,
  );
  return {
    ...canonical,
    id: `message-${sequence}`,
    ordinal: sequence,
    recipientSequence: sequence,
    senderSequence: sequence,
    content: `Coordinate item ${sequence}`,
    createdAt: `2026-08-30T00:00:0${sequence}.000Z`,
    ...overrides,
    recipient: {
      ...canonical.recipient,
      ...overrides.recipient,
    },
  };
}

function inbox(
  messages: readonly TaskCoordinationMessage[] = [message(1)],
  overrides: Partial<TaskCoordinationOperatorInbox> = {},
): TaskCoordinationOperatorInbox {
  return {
    schemaVersion: TASK_COORDINATION_OPERATOR_INBOX_SCHEMA_VERSION,
    taskId: "recipient-task",
    generatedAt: COORDINATION_TEST_TIMESTAMPS.generated,
    messages,
    unreadCount: messages.length,
    pendingCount: messages.length,
    firstSequence: messages[0]?.recipientSequence ?? null,
    lastSequence: messages.at(-1)?.recipientSequence ?? null,
    nextBeforeSequence: null,
    truncated: false,
    ...overrides,
  };
}

describe("Task coordination inbox presentation model", () => {
  it("accepts a bounded increasing page and labels pending work", () => {
    const page = inbox([message(2), message(3)], {
      pendingCount: 4,
      firstSequence: 2,
      lastSequence: 3,
      nextBeforeSequence: 2,
      truncated: true,
    });
    expect(() =>
      validateTaskCoordinationInbox("recipient-task", page),
    ).not.toThrow();
    expect(taskCoordinationPendingText(0)).toBe("No coordination pending");
    expect(taskCoordinationPendingText(4)).toBe("4 coordination pending");
  });

  it("rejects mixed Task identity, duplicate ordering and false cursors", () => {
    expect(() =>
      validateTaskCoordinationInbox(
        "recipient-task",
        inbox([
          message(1, {
            recipient: { ...message(1).recipient, taskId: "other" },
          }),
        ]),
      ),
    ).toThrow("participant identity");
    expect(() =>
      validateTaskCoordinationInbox(
        "recipient-task",
        inbox([message(2), message(1)], { firstSequence: 2, lastSequence: 1 }),
      ),
    ).toThrow("increasing recipient order");
    expect(() =>
      validateTaskCoordinationInbox(
        "recipient-task",
        inbox([message(2)], {
          firstSequence: 2,
          lastSequence: 2,
          nextBeforeSequence: 1,
          truncated: true,
        }),
      ),
    ).toThrow("continuation cursor");
    expect(() =>
      validateTaskCoordinationInbox("recipient-task", {
        ...inbox(),
        generatedAt: null,
      } as unknown as TaskCoordinationOperatorInbox),
    ).toThrow("identity or schema");
    expect(() =>
      validateTaskCoordinationInbox(
        "recipient-task",
        inbox([
          message(1, {
            sender: {
              ...message(1).sender,
              taskTitle: "x".repeat(201),
            },
          }),
        ]),
      ),
    ).toThrow("participant identity");
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid unread count %s",
    (unreadCount) => {
      expect(() =>
        validateTaskCoordinationInbox("recipient-task", inbox([], { unreadCount })),
      ).toThrow("count or page size");
    },
  );

  it("rejects impossible counter relationships and non-array pages", () => {
    expect(() =>
      validateTaskCoordinationInbox("recipient-task", inbox([], {
        unreadCount: 1,
        pendingCount: 0,
      })),
    ).toThrow("count or page size");
    expect(() =>
      validateTaskCoordinationInbox("recipient-task", {
        ...inbox(), messages: null,
      } as unknown as TaskCoordinationOperatorInbox),
    ).toThrow("count or page size");
    expect(() =>
      validateTaskCoordinationInbox("recipient-task", {
        ...inbox(), unreadCount: undefined,
      } as unknown as TaskCoordinationOperatorInbox),
    ).toThrow("count or page size");
  });

  it("accepts empty history and already-read work still awaiting acknowledgement", () => {
    expect(() => validateTaskCoordinationInbox("recipient-task", inbox([]))).not.toThrow();
    expect(() => validateTaskCoordinationInbox("recipient-task", inbox([
      message(1, { readAt: "2026-08-30T00:00:30.000Z", deliveryState: "read" }),
    ], { unreadCount: 0, pendingCount: 1 }))).not.toThrow();
  });

  it("accepts every canonical persisted delivery state, including historical identities", () => {
    const deliveredRecipient = coordinationMessage(
      "recipient-task",
      "delivered",
    ).recipient;
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly message: TaskCoordinationMessage;
      readonly unreadCount: number;
      readonly pendingCount: number;
    }> = [
      { name: "queued", message: message(1), unreadCount: 1, pendingCount: 1 },
      {
        name: "delivered to an old principal on a terminal Task",
        message: message(1, {
          deliveryState: "delivered",
          recipient: {
            ...deliveredRecipient,
            taskStatus: "succeeded",
            ownershipCurrent: false,
            principalCurrent: false,
          },
        }),
        unreadCount: 0,
        pendingCount: 0,
      },
      {
        name: "read and awaiting acknowledgement",
        message: message(1, {
          deliveryState: "read",
          expiresAt: COORDINATION_TEST_TIMESTAMPS.futureExpiry,
        }),
        unreadCount: 0,
        pendingCount: 1,
      },
      {
        name: "no-ack read after its informational expiry",
        message: message(1, {
          deliveryState: "read",
          requiresAcknowledgement: false,
          expiresAt: COORDINATION_TEST_TIMESTAMPS.expired,
          expiredAt: COORDINATION_TEST_TIMESTAMPS.expired,
        }),
        unreadCount: 0,
        pendingCount: 0,
      },
      {
        name: "acknowledged old-principal terminal history",
        message: message(1, {
          deliveryState: "acknowledged",
          expiresAt: COORDINATION_TEST_TIMESTAMPS.expired,
          expiredAt: COORDINATION_TEST_TIMESTAMPS.expired,
          recipient: {
            ...deliveredRecipient,
            taskStatus: "cancelled",
            ownershipCurrent: false,
            principalCurrent: false,
          },
        }),
        unreadCount: 0,
        pendingCount: 0,
      },
      {
        name: "replied no-ack history",
        message: message(1, {
          deliveryState: "replied",
          requiresAcknowledgement: false,
          expiresAt: COORDINATION_TEST_TIMESTAMPS.expired,
          expiredAt: COORDINATION_TEST_TIMESTAMPS.expired,
        }),
        unreadCount: 0,
        pendingCount: 0,
      },
      {
        name: "cancelled before delivery",
        message: message(1, { deliveryState: "cancelled" }),
        unreadCount: 0,
        pendingCount: 0,
      },
      {
        name: "cancelled after read and later expired",
        message: message(1, {
          deliveryState: "cancelled",
          recipient: deliveredRecipient,
          deliveredAt: COORDINATION_TEST_TIMESTAMPS.delivered,
          readAt: COORDINATION_TEST_TIMESTAMPS.read,
          expiresAt: COORDINATION_TEST_TIMESTAMPS.expired,
          expiredAt: COORDINATION_TEST_TIMESTAMPS.expired,
        }),
        unreadCount: 0,
        pendingCount: 0,
      },
      {
        name: "expired before delivery",
        message: message(1, { deliveryState: "expired" }),
        unreadCount: 0,
        pendingCount: 0,
      },
      {
        name: "ack-required read that later expired",
        message: message(1, {
          deliveryState: "expired",
          recipient: deliveredRecipient,
          deliveredAt: COORDINATION_TEST_TIMESTAMPS.delivered,
          readAt: COORDINATION_TEST_TIMESTAMPS.read,
        }),
        unreadCount: 0,
        pendingCount: 0,
      },
      {
        name: "recipient changed before delivery",
        message: message(1, {
          deliveryState: "recipient-changed",
          expiresAt: COORDINATION_TEST_TIMESTAMPS.futureExpiry,
          recipient: {
            ...message(1, { deliveryState: "recipient-changed" }).recipient,
            taskStatus: "failed",
          },
        }),
        unreadCount: 0,
        pendingCount: 0,
      },
    ];

    for (const value of cases) {
      expect(
        () =>
          validateTaskCoordinationInbox(
            "recipient-task",
            inbox([value.message], {
              unreadCount: value.unreadCount,
              pendingCount: value.pendingCount,
            }),
          ),
        value.name,
      ).not.toThrow();
    }
  });

  it.each([
    [
      "acknowledged state without the receipt chain",
      message(1, { deliveryState: "acknowledged", acknowledgedAt: null }),
    ],
    [
      "partial delivered identity",
      message(1, {
        recipient: {
          ...message(1).recipient,
          deliveredSessionId: "partial-session",
        },
      }),
    ],
    [
      "delivery timestamp without identity",
      message(1, {
        deliveryState: "delivered",
        recipient: {
          ...message(1).recipient,
          deliveredSessionId: null,
          deliveredAgentId: null,
          deliveredAgentName: null,
        },
      }),
    ],
    [
      "read timestamp without delivery",
      message(1, {
        deliveryState: "read",
        deliveredAt: null,
        recipient: {
          ...message(1).recipient,
          deliveredSessionId: null,
          deliveredAgentId: null,
          deliveredAgentName: null,
        },
      }),
    ],
    [
      "read before delivery",
      message(1, {
        deliveryState: "read",
        deliveredAt: COORDINATION_TEST_TIMESTAMPS.read,
        readAt: COORDINATION_TEST_TIMESTAMPS.delivered,
      }),
    ],
    [
      "acknowledgement before read",
      message(1, {
        deliveryState: "acknowledged",
        readAt: COORDINATION_TEST_TIMESTAMPS.acknowledged,
        acknowledgedAt: COORDINATION_TEST_TIMESTAMPS.read,
      }),
    ],
    [
      "reply before acknowledgement",
      message(1, {
        deliveryState: "replied",
        acknowledgedAt: COORDINATION_TEST_TIMESTAMPS.replied,
        repliedAt: COORDINATION_TEST_TIMESTAMPS.acknowledged,
      }),
    ],
    [
      "cancellation before an existing read receipt",
      message(1, {
        deliveryState: "cancelled",
        recipient: coordinationMessage("recipient-task", "delivered").recipient,
        deliveredAt: COORDINATION_TEST_TIMESTAMPS.delivered,
        readAt: COORDINATION_TEST_TIMESTAMPS.read,
        cancelledAt: "2026-08-30T00:00:15.000Z",
      }),
    ],
    [
      "future receipt",
      message(1, {
        deliveryState: "read",
        readAt: "2026-08-30T00:02:10.000Z",
      }),
    ],
    [
      "expiry before creation",
      message(1, {
        deliveryState: "expired",
        expiresAt: "2026-08-29T23:59:59.000Z",
        expiredAt: "2026-08-29T23:59:59.000Z",
      }),
    ],
    [
      "missing derived expiry receipt",
      message(1, { deliveryState: "expired", expiredAt: null }),
    ],
    [
      "expiry receipt for a future deadline",
      message(1, {
        expiresAt: COORDINATION_TEST_TIMESTAMPS.futureExpiry,
        expiredAt: COORDINATION_TEST_TIMESTAMPS.expired,
      }),
    ],
    [
      "expiry receipt at another instant",
      message(1, {
        deliveryState: "expired",
        expiredAt: "2026-08-30T00:00:49.000Z",
      }),
    ],
    [
      "current ownership under a changed principal",
      message(1, {
        deliveryState: "recipient-changed",
        recipient: {
          ...message(1, { deliveryState: "recipient-changed" }).recipient,
          ownershipCurrent: true,
        },
      }),
    ],
    [
      "queued state for a changed principal",
      message(1, {
        recipient: {
          ...message(1).recipient,
          ownershipCurrent: false,
          principalCurrent: false,
        },
      }),
    ],
    [
      "recipient-changed state after delivery",
      message(1, {
        deliveryState: "recipient-changed",
        deliveredAt: COORDINATION_TEST_TIMESTAMPS.delivered,
        recipient: coordinationMessage("recipient-task", "delivered").recipient,
      }),
    ],
    [
      "acknowledged no-ack message without a reply",
      message(1, {
        deliveryState: "acknowledged",
        requiresAcknowledgement: false,
      }),
    ],
    [
      "reply without acknowledgement",
      message(1, { deliveryState: "replied", acknowledgedAt: null }),
    ],
    [
      "no-ack read incorrectly labelled expired",
      message(1, {
        deliveryState: "expired",
        requiresAcknowledgement: false,
        recipient: coordinationMessage("recipient-task", "delivered").recipient,
        deliveredAt: COORDINATION_TEST_TIMESTAMPS.delivered,
        readAt: COORDINATION_TEST_TIMESTAMPS.read,
      }),
    ],
    [
      "ack-required read incorrectly kept read after expiry",
      message(1, {
        deliveryState: "read",
        expiresAt: COORDINATION_TEST_TIMESTAMPS.expired,
        expiredAt: COORDINATION_TEST_TIMESTAMPS.expired,
      }),
    ],
    [
      "cancelled state carrying an acknowledgement",
      message(1, {
        deliveryState: "cancelled",
        recipient: coordinationMessage("recipient-task", "delivered").recipient,
        deliveredAt: COORDINATION_TEST_TIMESTAMPS.delivered,
        readAt: COORDINATION_TEST_TIMESTAMPS.read,
        acknowledgedAt: COORDINATION_TEST_TIMESTAMPS.acknowledged,
      }),
    ],
  ] satisfies ReadonlyArray<readonly [string, TaskCoordinationMessage]>)(
    "rejects causally inconsistent history: %s",
    (_name, invalidMessage) => {
      expect(() =>
        validateTaskCoordinationInbox(
          "recipient-task",
          inbox([invalidMessage]),
        ),
      ).toThrow("causal delivery history");
    },
  );

  it("loads only the read-only operator endpoint and isolates malformed responses", async () => {
    const getTaskCoordinationInbox = vi.fn(async () => inbox());
    const loaded = await loadTaskCoordinationInbox(
      { getTaskCoordinationInbox },
      "recipient-task",
    );
    expect(getTaskCoordinationInbox).toHaveBeenCalledWith(
      "recipient-task",
      undefined,
      50,
    );
    expect(loaded.error).toBeNull();
    expect(loaded.inbox?.messages).toHaveLength(1);

    const older = await loadTaskCoordinationInbox(
      { getTaskCoordinationInbox },
      "recipient-task",
      2,
      12,
    );
    expect(getTaskCoordinationInbox).toHaveBeenLastCalledWith(
      "recipient-task",
      2,
      12,
    );
    expect(older.error).toBeNull();

    getTaskCoordinationInbox.mockResolvedValueOnce(
      inbox([message(2)], {
        firstSequence: 2,
        lastSequence: 2,
        nextBeforeSequence: 2,
        truncated: true,
      }),
    );
    const repeatedCursor = await loadTaskCoordinationInbox(
      { getTaskCoordinationInbox },
      "recipient-task",
      2,
    );
    expect(repeatedCursor.inbox).toBeNull();
    expect(repeatedCursor.error).toEqual(
      expect.objectContaining({ message: "Coordination inbox cursor did not move backwards." }),
    );

    getTaskCoordinationInbox.mockResolvedValueOnce(
      inbox([], { taskId: "wrong-task" }),
    );
    const rejected = await loadTaskCoordinationInbox(
      { getTaskCoordinationInbox },
      "recipient-task",
    );
    expect(rejected.inbox).toBeNull();
    expect(rejected.error).toBeInstanceOf(Error);
  });

  it("localizes stale snapshot times and last-known counters", () => {
    const phrases = new Map(TASK_BOARD_PHRASES);
    expect(phrases.get("Coordination status unavailable.")).toBe(
      "协调状态不可用。",
    );
    expect(phrases.get("Last known: No coordination pending")).toBe(
      "上次已知：没有待处理协调消息",
    );
    expect(phrases.get("Last known: No unread coordination")).toBe(
      "上次已知：没有未读协调消息",
    );
    expect(
      translateTaskBoardPattern(
        "Coordination messages and counts updated 2026-08-30 16:00.",
      ),
    ).toBe("协调消息和计数更新于 2026-08-30 16:00。");
    expect(
      translateTaskBoardPattern(
        "Coordination messages and counts may be out of date. Last updated 2026-08-30 16:00.",
      ),
    ).toBe("协调消息和计数可能已过期，上次更新于 2026-08-30 16:00。");
    expect(
      translateTaskBoardPattern("Last known: 7 coordination unread"),
    ).toBe("上次已知：7 条协调消息未读");
    expect(
      translateTaskBoardPattern("Last known: 12 coordination pending"),
    ).toBe("上次已知：12 条协调消息待处理");
  });
});
