// Covers Google Chat inbound recovery from racing reply-session-init conflicts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";
import { testing } from "./monitor.js";
import type { GoogleChatEvent } from "./types.js";

const apiMocks = vi.hoisted(() => ({
  downloadGoogleChatMedia: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(),
}));

vi.mock("./api.js", () => ({
  downloadGoogleChatMedia: apiMocks.downloadGoogleChatMedia,
  sendGoogleChatMessage: apiMocks.sendGoogleChatMessage,
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: accessMocks.applyGoogleChatInboundAccessPolicy,
}));

beforeEach(() => {
  apiMocks.downloadGoogleChatMedia.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset();
  accessMocks.applyGoogleChatInboundAccessPolicy.mockReset();
});

function replySessionInitConflict(sessionKey = "agent:main:main"): Error {
  return new Error(`reply session initialization conflicted for ${sessionKey}`);
}

function createCore(runTurn: ReturnType<typeof vi.fn>): GoogleChatCoreRuntime {
  return {
    logging: { shouldLogVerbose: () => false },
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          agentId: "agent-1",
          accountId: "work",
          sessionKey: "session-1",
        }),
      },
      session: {
        resolveStorePath: () => "/tmp/openclaw-googlechat-test",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: vi.fn(),
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
      inbound: { buildContext: vi.fn((payload: unknown) => payload), run: runTurn },
    },
  } as unknown as GoogleChatCoreRuntime;
}

function dmMessageEvent(): GoogleChatEvent {
  return {
    type: "MESSAGE",
    eventTime: "2026-03-22T00:00:00.001Z",
    space: { name: "spaces/DM", type: "DM" },
    message: {
      name: "spaces/DM/messages/2",
      text: "hello",
      sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
    },
  } satisfies GoogleChatEvent;
}

function humanAccount(): ResolvedGoogleChatAccount {
  return {
    accountId: "work",
    config: {},
    credentialSource: "inline",
  } as ResolvedGoogleChatAccount;
}

describe("isReplySessionInitConflictError", () => {
  it("matches the core conflict message", () => {
    expect(testing.isReplySessionInitConflictError(replySessionInitConflict())).toBe(true);
  });

  it("matches the conflict wrapped as a nested cause", () => {
    const wrapped = new Error("google chat webhook failed", { cause: replySessionInitConflict() });
    expect(testing.isReplySessionInitConflictError(wrapped)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(testing.isReplySessionInitConflictError(new Error("network down"))).toBe(false);
    expect(testing.isReplySessionInitConflictError(undefined)).toBe(false);
  });
});

describe("googlechat reply session init conflict recovery", () => {
  it("retries the inbound run when a reply session init conflict is thrown, then succeeds", async () => {
    const runTurn = vi
      .fn()
      .mockRejectedValueOnce(replySessionInitConflict())
      .mockResolvedValueOnce(undefined);
    const core = createCore(runTurn);
    const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });

    await testing.processMessageWithPipeline({
      event: dmMessageEvent(),
      account: humanAccount(),
      config: {},
      runtime,
      core,
      mediaMaxMb: 10,
    });

    // The conflict is retried instead of dropping the valid inbound message.
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("does not retry unrelated inbound run failures", async () => {
    const runTurn = vi.fn().mockRejectedValue(new Error("network down"));
    const core = createCore(runTurn);
    const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });

    await expect(
      testing.processMessageWithPipeline({
        event: dmMessageEvent(),
        account: humanAccount(),
        config: {},
        runtime,
        core,
        mediaMaxMb: 10,
      }),
    ).rejects.toThrow("network down");
    expect(runTurn).toHaveBeenCalledOnce();
  });
});
