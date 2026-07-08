// Bash tool helper tests cover conversion from model-facing timeout seconds to
// timer-safe millisecond values.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBashTool,
  createLocalBashOperations,
  resolveBashTimeoutMs,
  type BashOperations,
} from "./bash.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

type MockChild = ChildProcessWithoutNullStreams & { stdout: PassThrough; stderr: PassThrough };

function createChild(): MockChild {
  let killed = false;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as MockChild;
  Object.defineProperty(child, "killed", { get: () => killed });
  child.kill = vi.fn(() => {
    killed = true;
    return true;
  });
  return child;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("bash tool timeout helpers", () => {
  it("converts positive timeout seconds to timer-safe milliseconds", () => {
    expect(resolveBashTimeoutMs(1)).toBe(1_000);
    expect(resolveBashTimeoutMs(1.5)).toBe(1_500);
    expect(resolveBashTimeoutMs(0.0005)).toBe(1);
  });

  it("caps oversized timeout seconds", () => {
    // Node timers cannot safely represent arbitrary user-provided seconds.
    expect(resolveBashTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("ignores absent, invalid, and non-positive timeout seconds", () => {
    expect(resolveBashTimeoutMs(undefined)).toBeUndefined();
    expect(resolveBashTimeoutMs(Number.NaN)).toBeUndefined();
    expect(resolveBashTimeoutMs(0)).toBeUndefined();
    expect(resolveBashTimeoutMs(-1)).toBeUndefined();
  });
});

describe("bash tool output lifecycle", () => {
  it("ignores output callbacks after execution settles", async () => {
    const operations: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.from("before\n"));
        setTimeout(() => onData(Buffer.from("late\n")), 0);
        return { exitCode: 0 };
      },
    };
    const tool = createBashTool(process.cwd(), { operations });

    const result = await tool.execute("call-late-output", { command: "ignored" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(result.content[0]).toEqual({ type: "text", text: "before\n" });
  });
});

describe("bash tool stream errors", () => {
  it.each(["stdout", "stderr"] as const)("rejects when %s emits an error", async (stream) => {
    const child = createChild();
    vi.mocked(spawn).mockReturnValue(child);

    const resultPromise = createLocalBashOperations().exec("echo hi", "/tmp", {
      onData: () => {},
      signal: undefined,
      timeout: undefined,
      env: undefined,
    });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child[stream].emit("error", new Error(`${stream} EPIPE`));

    await expect(resultPromise).rejects.toThrow(`bash ${stream} error: ${stream} EPIPE`);
  });

  it("kills the child process when stdout fails", async () => {
    const child = createChild();
    vi.mocked(spawn).mockReturnValue(child);

    const resultPromise = createLocalBashOperations().exec("echo hi", "/tmp", {
      onData: () => {},
      signal: undefined,
      timeout: undefined,
      env: undefined,
    });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.emit("error", new Error("stdout EPIPE"));

    await expect(resultPromise).rejects.toThrow("bash stdout error: stdout EPIPE");
  });

  it("keeps stdout guarded after a stderr failure", async () => {
    const child = createChild();
    vi.mocked(spawn).mockReturnValue(child);

    const result = createLocalBashOperations().exec("echo hi", "/tmp", {
      onData: () => {},
      signal: undefined,
      timeout: undefined,
      env: undefined,
    });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    expect(() => {
      child.stderr.emit("error", new Error("stderr first"));
      child.stdout.emit("error", new Error("stdout later"));
    }).not.toThrow();

    await expect(result).rejects.toThrow("bash stderr error: stderr first");
  });
});
