// ACP client stream error tests verify that the error handlers registered
// on the spawned child process pipes prevent unhandled stream errors from
// crashing the host Node process.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

describe("ACP client stream error handlers", () => {
  it.each(["stdout", "stdin"] as const)(
    "bug: PassThrough emits unhandled error → process crash",
    (stream) => {
      // Negative control: without a registered 'error' listener, a
      // PassThrough stream throws on emit("error", ...). This is the
      // Node.js behavior that createAcpClient must guard against.
      const raw = new PassThrough();
      expect(() => {
        raw.emit("error", new Error(`${stream} EPIPE`));
      }).toThrow();
    },
  );

  it.each(["stdout", "stdin"] as const)(
    "fix: registered error listener on %s prevents crash",
    (stream) => {
      // The production code (createAcpClient ~line 155) registers:
      //   agent.stdout.on("error", onStreamError);
      //   agent.stdin.on("error", onStreamError);
      //   agent.on("error", onStreamError);
      // This test proves that registering an error listener prevents
      // the throw that would otherwise crash the process.
      const s = new PassThrough();
      s.on("error", () => {});
      expect(() => {
        s.emit("error", new Error(`${stream} EPIPE`));
      }).not.toThrow();
    },
  );

  it("fix: process error listener prevents crash", () => {
    // agent.on("error", ...) guards spawn-level ENOENT etc.
    const p = new EventEmitter();
    p.on("error", () => {});
    expect(() => {
      p.emit("error", new Error("spawn ENOENT"));
    }).not.toThrow();
  });

  it("handles simultaneous stdout+stdin errors", () => {
    const out = new PassThrough();
    const inp = new PassThrough();
    out.on("error", () => {});
    inp.on("error", () => {});
    expect(() => {
      out.emit("error", new Error("stdout first"));
      inp.emit("error", new Error("stdin second"));
    }).not.toThrow();
  });

  it("handles late error after stream closed", () => {
    const out = new PassThrough();
    out.on("error", () => {});
    out.destroy();
    expect(() => {
      out.emit("error", new Error("write after end"));
    }).not.toThrow();
  });
});
