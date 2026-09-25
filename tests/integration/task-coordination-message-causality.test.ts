import { describe, expect, it } from "vitest";

import {
  validateTaskCoordinationMessageCausality,
  type TaskCoordinationMessage,
} from "../../packages/control-plane-contract/src/index.js";
import {
  COORDINATION_TEST_TIMESTAMPS,
  coordinationMessage,
} from "../../apps/desktop/test/task-coordination-test-fixture.js";

describe("Task coordination message causal contract", () => {
  it("accepts complete terminal and old-principal history", () => {
    const acknowledged = coordinationMessage("recipient-task", "acknowledged");
    const historical: TaskCoordinationMessage = {
      ...acknowledged,
      expiresAt: COORDINATION_TEST_TIMESTAMPS.expired,
      expiredAt: COORDINATION_TEST_TIMESTAMPS.expired,
      recipient: {
        ...acknowledged.recipient,
        taskStatus: "failed",
        ownershipCurrent: false,
        principalCurrent: false,
      },
    };

    expect(() =>
      validateTaskCoordinationMessageCausality(
        historical,
        COORDINATION_TEST_TIMESTAMPS.generated,
      ),
    ).not.toThrow();

    const repliedAfterExpiry = coordinationMessage(
      "recipient-task",
      "replied",
      {
        expiresAt: COORDINATION_TEST_TIMESTAMPS.expired,
        expiredAt: COORDINATION_TEST_TIMESTAMPS.expired,
        repliedAt: "2026-08-30T00:00:55.000Z",
      },
    );
    expect(() =>
      validateTaskCoordinationMessageCausality(
        repliedAfterExpiry,
        COORDINATION_TEST_TIMESTAMPS.generated,
      ),
    ).not.toThrow();
  });

  it("fails closed when state, receipts or delivered identity disagree", () => {
    const delivered = coordinationMessage("recipient-task", "delivered");
    const malformed: readonly TaskCoordinationMessage[] = [
      { ...delivered, deliveryState: "acknowledged" },
      {
        ...delivered,
        recipient: {
          ...delivered.recipient,
          deliveredAgentId: null,
        },
      },
      {
        ...coordinationMessage("recipient-task", "read"),
        readAt: "2026-08-30T00:00:05.000Z",
      },
      {
        ...coordinationMessage("recipient-task", "queued"),
        recipient: delivered.recipient,
      },
    ];

    for (const message of malformed) {
      expect(() =>
        validateTaskCoordinationMessageCausality(
          message,
          COORDINATION_TEST_TIMESTAMPS.generated,
        ),
      ).toThrow("inconsistent causal delivery history");
    }
  });
});
