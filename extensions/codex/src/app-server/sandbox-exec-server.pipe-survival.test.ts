import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
/**
 * Regression test: Codex sandbox exec-server bridge survives stdout/stderr
 * pipe errors in both the process RPC and streaming HTTP subprocess paths.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  closeCodexSandboxExecServersForTests,
  ensureCodexSandboxExecServerEnvironment,
} from "./sandbox-exec-server.js";
import {
  collectNotifications,
  createClient,
  createSandboxContext,
  execServerUrlFromClient,
  openSocket,
  readUntilClosed,
  rpc,
  waitForSocketClose,
} from "./sandbox-exec-server.test-helpers.js";

const TMPDIR = process.env.TMPDIR ?? "/tmp";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeSandbox(): SandboxContext {
  return createSandboxContext({
    buildExecSpec: async ({ command }) => ({
      argv: ["/bin/sh", "-c", command],
      env: { PATH: process.env.PATH, TMPDIR },
      stdinMode: "pipe-closed" as const,
    }),
  });
}

function client() {
  return createClient() as ReturnType<typeof createClient> & {
    request: ReturnType<typeof createClient>["request"];
  };
}

afterEach(async () => {
  await closeCodexSandboxExecServersForTests();
});

describe("sandbox exec-server pipe survival", () => {
  describe("process bridge survives when child writes 200 lines then is killed", () => {
    it("spawns, kills mid-output, bridge survives, second process works", async () => {
      const sandbox = makeSandbox();
      const fakeClient = client();
      const env = await ensureCodexSandboxExecServerEnvironment({
        client: fakeClient,
        sandbox,
      });
      expect(env).toBeDefined();
      const url = execServerUrlFromClient(fakeClient);
      const socket = await openSocket(url);
      collectNotifications(socket);

      // Spawn a Node.js child writing 200 lines to both stdout and stderr,
      // then pause with setTimeout so we can kill it mid-output.
      const SCRIPT =
        "for(var i=0;i<200;i++){" +
        "process.stdout.write('stdout line '+i+'\\n');" +
        "process.stderr.write('stderr line '+i+'\\n')" +
        "};setTimeout(function(){},300000)";
      const p1id = "pipe-srv-101";
      const start = (await rpc(socket, "process/start", {
        processId: p1id,
        argv: [process.execPath, "-e", SCRIPT],
        cwd: TMPDIR,
        tty: false,
        pipeStdin: false,
      })) as { processId: string };
      expect(start.processId).toBe(p1id);

      await delay(150);
      await rpc(socket, "process/terminate", { processId: p1id });
      await delay(1000);

      const read = await readUntilClosed(socket, p1id);
      expect(read.closed).toBe(true);
      expect(socket.readyState).toBe(1);

      // Second process proves full functionality
      const p2id = "pipe-srv-102";
      const ECHO = "process.stdout.write('bridge-survived')";
      await rpc(socket, "process/start", {
        processId: p2id,
        argv: [process.execPath, "-e", ECHO],
        cwd: TMPDIR,
        tty: false,
        pipeStdin: false,
      });
      const r2 = await readUntilClosed(socket, p2id);
      const out2 = r2.chunks
        ?.map((c) => Buffer.from(c.chunk, "base64").toString("utf8"))
        .join("")
        .trim();
      expect(out2).toBe("bridge-survived");
      socket.close();
    });
  });

  describe("http streaming bridge survives when socket closes mid-stream", () => {
    it("streams HTTP through a local echo server, closes socket mid-stream, bridge survives", async () => {
      // Start a local TCP echo server instead of depending on httpbin.org
      const http = await import("node:http");
      const echoServer = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        // Write a chunk then delay to give us time to close the socket mid-stream
        res.write("first-chunk\n");
        setTimeout(() => {
          res.write("second-chunk\n");
          res.end();
        }, 5000);
      });
      const echoPort: number = await new Promise((resolve) => {
        echoServer.listen(0, "127.0.0.1", () => {
          resolve((echoServer.address() as { port: number }).port);
        });
      });

      const sandbox = makeSandbox();
      const fakeClient = client();
      const env = await ensureCodexSandboxExecServerEnvironment({
        client: fakeClient,
        sandbox,
      });
      expect(env).toBeDefined();
      const url = execServerUrlFromClient(fakeClient);

      const socket = await openSocket(url);
      collectNotifications(socket);

      const rid = "http-pipe-201";
      const id = Math.floor(Math.random() * 1e6);
      socket.send(
        JSON.stringify({
          id,
          method: "http/request",
          params: {
            requestId: rid,
            url: `http://127.0.0.1:${echoPort}/`,
            method: "GET",
            headers: [],
            streamResponse: true,
          },
        }),
      );

      await delay(300);
      socket.close();
      const cr = await waitForSocketClose(socket);
      expect(cr.code).toBe(1005);

      // Connect a new socket to prove bridge is still functional
      const s2 = await openSocket(url);

      const ECHO = "process.stdout.write('http-bridge-survived')";
      await rpc(s2, "process/start", {
        processId: "http-surv-202",
        argv: [process.execPath, "-e", ECHO],
        cwd: TMPDIR,
        tty: false,
        pipeStdin: false,
      });
      const r3 = await readUntilClosed(s2, "http-surv-202");
      const o3 = r3.chunks
        ?.map((c) => Buffer.from(c.chunk, "base64").toString("utf8"))
        .join("")
        .trim();
      expect(o3).toBe("http-bridge-survived");
      s2.close();
      echoServer.close();
    });
  });
});
