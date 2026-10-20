import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import {
  createAccounting,
  createSettledExecution,
  createTurn,
} from "./followup-delivery.test-helpers.js";

describe("resolveFollowupDeliveryDecision usage footer", () => {
  it.each([
    {
      name: "a completed message-tool-only source reply",
      deliveredViaMessageTool: true,
      expectUsageFooter: true,
    },
    {
      name: "no completed message-tool-only source reply",
      deliveredViaMessageTool: false,
      expectUsageFooter: false,
    },
  ] as const)(
    "handles usage for $name without replaying private final text",
    async ({ deliveredViaMessageTool, expectUsageFooter }) => {
      const privateFinalText = "This is the private final answer.";
      const turn = createTurn({ config: { messages: { responseUsage: "full" } } });
      turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      turn.queued.run.messageProvider = "telegram";
      turn.queued.originatingChannel = "telegram";
      turn.queued.originatingTo = "123456";
      turn.queued.originatingChatType = "direct";
      turn.session.current = () => ({
        sessionId: "session",
        updatedAt: 1,
        responseUsage: "full",
      });

      const execution = createSettledExecution(privateFinalText);
      execution.outcome.result.didDeliverSourceReplyViaMessageTool = deliveredViaMessageTool;
      expect(hasCompletedSourceReplyDeliveryEvidence(execution.outcome.result)).toBe(
        deliveredViaMessageTool,
      );
      const decision = await resolveFollowupDeliveryDecision({
        turn,
        execution,
        accounting: createAccounting([{ text: privateFinalText }], {
          usage: { input: 120, output: 35, total: 155 },
        }),
      });

      const deliveredPayloads = decision.kind === "deliver" ? decision.payloads : [];
      expect(deliveredPayloads).toHaveLength(expectUsageFooter ? 1 : 0);
      if (expectUsageFooter) {
        const footer = expectDefined(deliveredPayloads[0], "completed source usage footer");
        expect(footer).toMatchObject({ isStatusNotice: true, text: expect.any(String) });
        expect(getReplyPayloadMetadata(footer)?.deliverDespiteSourceReplySuppression).toBe(true);
      }
      expect(deliveredPayloads.map((payload) => payload.text)).not.toContain(privateFinalText);
    },
  );
});
