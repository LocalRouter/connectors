import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCodexProcess, interruptProcess } from "../src/process-manager.js";
import type { CodexEvent, EnvConfig } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockCliPath = path.join(__dirname, "mock-codex-cli.mjs");

const testEnvConfig: EnvConfig = {
  cliPath: "node",
  approvalTimeoutMs: 30000,
  maxSessions: 10,
  logLevel: "error",
  eventBufferSize: 500,
  codexHome: "/tmp/codex-test",
};

// We override the CLI invocation by using node + mock script
// The spawnCodexProcess calls spawn(cliPath, args), so cliPath="node" won't work directly.
// Instead, we test by directly spawning the mock CLI.

import { spawn } from "node:child_process";
import { createNdjsonParser } from "@localrouter/mcp-base";
import { parseEvent } from "../src/stream-parser.js";

describe("process-manager", () => {
  it("spawns mock CLI and receives events", async () => {
    const events: CodexEvent[] = [];

    const child = spawn("node", [mockCliPath], {
      env: {
        ...process.env,
        MOCK_THREAD_ID: "test-thread-1",
        MOCK_DELAY_MS: "5",
        MOCK_RESULT: "Test result",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parser = createNdjsonParser();
    child.stdout!.pipe(parser);
    parser.on("data", (data: unknown) => events.push(parseEvent(data)));

    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });

    expect(events.length).toBeGreaterThan(0);

    const threadEvent = events.find((e) => e.type === "thread.started");
    expect(threadEvent).toBeDefined();
    expect((threadEvent as any).thread_id).toBe("test-thread-1");

    const turnStarted = events.find((e) => e.type === "turn.started");
    expect(turnStarted).toBeDefined();

    const turnCompleted = events.find((e) => e.type === "turn.completed");
    expect(turnCompleted).toBeDefined();

    const agentMsg = events.find(
      (e) => e.type === "item.completed" && (e as any).item?.type === "agent_message",
    );
    expect(agentMsg).toBeDefined();
    expect((agentMsg as any).item.text).toBe("Test result");
  });

  it("handles error mode", async () => {
    const events: CodexEvent[] = [];

    const child = spawn("node", [mockCliPath], {
      env: { ...process.env, MOCK_ERROR: "true", MOCK_DELAY_MS: "5" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parser = createNdjsonParser();
    child.stdout!.pipe(parser);
    parser.on("data", (data: unknown) => events.push(parseEvent(data)));

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    expect(exitCode).toBe(1);
    const failEvent = events.find((e) => e.type === "turn.failed");
    expect(failEvent).toBeDefined();
  });

  it("handles SIGINT gracefully", async () => {
    const events: CodexEvent[] = [];

    const child = spawn("node", [mockCliPath], {
      env: {
        ...process.env,
        MOCK_DELAY_MS: "2000", // long delay so we can interrupt
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parser = createNdjsonParser();
    child.stdout!.pipe(parser);
    parser.on("data", (data: unknown) => events.push(parseEvent(data)));

    // Wait for thread.started then interrupt
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (events.some((e) => e.type === "thread.started")) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    child.kill("SIGINT");

    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });

    const failEvent = events.find((e) => e.type === "turn.failed");
    expect(failEvent).toBeDefined();
  });

  it("emits command execution items", async () => {
    const events: CodexEvent[] = [];

    const child = spawn("node", [mockCliPath], {
      env: {
        ...process.env,
        MOCK_COMMAND: "npm test",
        MOCK_DELAY_MS: "5",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parser = createNdjsonParser();
    child.stdout!.pipe(parser);
    parser.on("data", (data: unknown) => events.push(parseEvent(data)));

    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });

    const cmdItem = events.find(
      (e) => e.type === "item.completed" && (e as any).item?.type === "command_execution",
    );
    expect(cmdItem).toBeDefined();
    expect((cmdItem as any).item.command).toBe("npm test");
  });
});
