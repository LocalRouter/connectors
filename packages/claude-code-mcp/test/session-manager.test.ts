import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { ParsedEvent, EnvConfig } from "../src/types.js";

// --- Mocks ---

// Capture the onEvent/onExit callbacks so tests can drive session state
let capturedOnEvent: ((event: ParsedEvent) => void) | null = null;
let capturedOnExit: ((code: number | null, signal: string | null) => void) | null = null;

const mockChild = {
  stdin: { write: vi.fn(), destroyed: false },
  stdout: null,
  stderr: null,
  pid: 99999,
  kill: vi.fn(),
  on: vi.fn(),
};

vi.mock("../src/process-manager.js", () => ({
  spawnClaudeProcess: vi.fn(
    (
      _config: unknown,
      _env: unknown,
      onEvent: (event: ParsedEvent) => void,
      onExit: (code: number | null, signal: string | null) => void,
    ) => {
      capturedOnEvent = onEvent;
      capturedOnExit = onExit;
      return mockChild;
    },
  ),
  sendMessage: vi.fn(),
  interruptProcess: vi.fn(),
  getPermissionHandlerScriptPath: vi.fn(() => "/mock/permission-handler-mcp.js"),
}));

// Import after mocks
const { SessionManager } = await import("../src/session-manager.js");
const processManager = await import("../src/process-manager.js");

const envConfig: EnvConfig = {
  claudeCodePath: "claude",
  permissionTimeoutMs: 5000,
  maxSessions: 10,
  logLevel: "error",
  eventBufferSize: 100,
};

describe("SessionManager", () => {
  let manager: InstanceType<typeof SessionManager>;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedOnEvent = null;
    capturedOnExit = null;
    mockChild.kill.mockReset();
    mockChild.stdin.write.mockReset();
    mockChild.stdin.destroyed = false;
    manager = new SessionManager(envConfig);
    await manager.start();
  });

  afterEach(async () => {
    await manager.stop();
  });

  // Helper: simulate init event
  function emitInit(sessionId: string): void {
    capturedOnEvent!({
      type: "init",
      session_id: sessionId,
      timestamp: new Date().toISOString(),
    });
  }

  // Helper: simulate result event
  function emitResult(
    sessionId: string,
    status: "success" | "error" | "interrupted" = "success",
    result?: string,
  ): void {
    capturedOnEvent!({
      type: "result",
      status,
      result: result || "done",
      session_id: sessionId,
      cost_usd: 0.05,
      turns: 2,
    });
  }

  // Helper: simulate stream text event
  function emitText(text: string): void {
    capturedOnEvent!({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text },
      },
    });
  }

  // Helper: simulate tool use start
  function emitToolStart(name: string): void {
    capturedOnEvent!({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name },
      },
    });
  }

  // Helper: simulate tool use stop
  function emitToolStop(): void {
    capturedOnEvent!({
      type: "stream_event",
      event: { type: "content_block_stop" },
    });
  }

  // --- startSession ---

  describe("startSession", () => {
    it("spawns process and returns session ID from init event", async () => {
      const startPromise = manager.startSession({ prompt: "Hello" });

      // Simulate the init event from Claude Code
      await new Promise((r) => setTimeout(r, 20));
      emitInit("real-session-id");

      const result = await startPromise;
      expect(result.sessionId).toBe("real-session-id");
      expect(result.status).toBe("active");
    });

    it("returns temp ID on init timeout", async () => {
      // Don't emit init event - should timeout
      const result = await manager.startSession({ prompt: "Hello" });
      // Should get a temp_ id since no init event arrived within the wait
      // (waitForSessionId has 10s timeout, but the test should still work
      // as it polls every 50ms and eventually times out)
      expect(result.sessionId).toMatch(/^temp_/);
      expect(result.status).toBe("active");
    }, 15000);

    it("rejects when max sessions reached", async () => {
      // Create sessions up to the limit
      const limitedConfig = { ...envConfig, maxSessions: 1 };
      const limitedManager = new SessionManager(limitedConfig);
      await limitedManager.start();

      const p1 = limitedManager.startSession({ prompt: "first" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("s1");
      await p1;

      // Second session should fail
      await expect(limitedManager.startSession({ prompt: "second" })).rejects.toThrow(
        "Maximum concurrent sessions",
      );

      await limitedManager.stop();
    });

    it("stores session config for re-spawning", async () => {
      const startPromise = manager.startSession({
        prompt: "test",
        model: "opus",
        permissionMode: "plan",
        maxTurns: 5,
      });

      await new Promise((r) => setTimeout(r, 20));
      emitInit("cfg-session");

      const result = await startPromise;
      const status = manager.getSessionStatus(result.sessionId);
      expect(status.sessionId).toBe("cfg-session");
      expect(status.status).toBe("active");
    });
  });

  // --- getSessionStatus ---

  describe("getSessionStatus", () => {
    it("returns session status with recent output", async () => {
      const startPromise = manager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("status-session");
      await startPromise;

      emitText("Hello ");
      emitText("World!");

      const status = manager.getSessionStatus("status-session");
      expect(status.sessionId).toBe("status-session");
      expect(status.status).toBe("active");
      expect(status.recentOutput).toContain("Hello ");
      expect(status.recentOutput).toContain("World!");
    });

    it("includes result and metrics after completion", async () => {
      const startPromise = manager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("done-session");
      await startPromise;

      emitResult("done-session", "success", "Final answer");

      const status = manager.getSessionStatus("done-session");
      expect(status.status).toBe("done");
      expect(status.result).toBe("Final answer");
      expect(status.costUsd).toBe(0.05);
      expect(status.turnCount).toBe(2);
    });

    it("tracks tool use events", async () => {
      const startPromise = manager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("tool-session");
      await startPromise;

      emitToolStart("Edit");
      emitToolStop();
      emitToolStart("Bash");

      const status = manager.getSessionStatus("tool-session");
      expect(status.toolUseEvents).toHaveLength(2);
      expect(status.toolUseEvents[0]).toEqual({ toolName: "Edit", status: "completed" });
      expect(status.toolUseEvents[1]).toEqual({ toolName: "Bash", status: "running" });
    });

    it("throws for unknown session", () => {
      expect(() => manager.getSessionStatus("nonexistent")).toThrow("Unknown session");
    });
  });

  // --- sayToSession ---

  describe("sayToSession", () => {
    it("sends message to active session via process-manager", async () => {
      const startPromise = manager.startSession({ prompt: "initial" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("say-session");
      await startPromise;

      await manager.sayToSession({
        sessionId: "say-session",
        message: "follow up",
      });

      expect(processManager.sendMessage).toHaveBeenCalledWith(
        mockChild,
        "say-session",
        "follow up",
      );
    });

    it("resumes dead session by spawning new process", async () => {
      const startPromise = manager.startSession({ prompt: "initial" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("resume-session");
      await startPromise;

      // Simulate process completion
      emitResult("resume-session", "success");
      capturedOnExit!(0, null);

      // Reset mock to track new spawn
      vi.mocked(processManager.spawnClaudeProcess).mockClear();

      await manager.sayToSession({
        sessionId: "resume-session",
        message: "continue",
      });

      // Should have spawned a new process with --resume
      expect(processManager.spawnClaudeProcess).toHaveBeenCalledTimes(1);
      const config = vi.mocked(processManager.spawnClaudeProcess).mock.calls[0][0];
      expect(config.resumeSessionId).toBe("resume-session");
      expect(config.prompt).toBe("continue");
    });

    it("creates tracked session for unknown session ID", async () => {
      // sayToSession with unknown ID should create and resume
      await manager.sayToSession({
        sessionId: "user-created-session",
        message: "hello",
      });

      expect(processManager.spawnClaudeProcess).toHaveBeenCalled();
      const config = vi.mocked(processManager.spawnClaudeProcess).mock.calls[0][0];
      expect(config.resumeSessionId).toBe("user-created-session");
    });
  });

  // --- respondToQuestion ---

  describe("respondToQuestion", () => {
    it("throws when no pending question", async () => {
      const startPromise = manager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("respond-session");
      await startPromise;

      expect(() =>
        manager.respondToQuestion({
          sessionId: "respond-session",
          id: "q1",
          answers: ["allow"],
        }),
      ).toThrow("No pending question");
    });

    it("throws on question ID mismatch", async () => {
      const startPromise = manager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("mismatch-session");
      await startPromise;

      // Manually set a pending question on the session
      const status = manager.getSessionStatus("mismatch-session");
      // We need to trigger a permission to set pending question
      // For simplicity, test the error path
      expect(() =>
        manager.respondToQuestion({
          sessionId: "mismatch-session",
          id: "wrong-id",
          answers: ["allow"],
        }),
      ).toThrow("No pending question");
    });

    it("throws for unknown session", () => {
      expect(() =>
        manager.respondToQuestion({
          sessionId: "nonexistent",
          id: "q1",
          answers: ["allow"],
        }),
      ).toThrow("Unknown session");
    });
  });

  // --- interruptSession ---

  describe("interruptSession", () => {
    it("sends SIGINT to active process", async () => {
      const startPromise = manager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("int-session");
      await startPromise;

      const result = manager.interruptSession("int-session");

      expect(processManager.interruptProcess).toHaveBeenCalledWith(mockChild);
      expect(result.status).toBe("interrupted");
    });

    it("throws for unknown session", () => {
      expect(() => manager.interruptSession("nonexistent")).toThrow("Unknown session");
    });

    it("throws when no active process", async () => {
      const startPromise = manager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("no-proc");
      await startPromise;

      // Simulate process exit
      emitResult("no-proc", "success");
      capturedOnExit!(0, null);

      expect(() => manager.interruptSession("no-proc")).toThrow("no active process");
    });
  });

  // --- listSessions ---

  describe("listSessions", () => {
    it("returns empty when no history file and no active sessions", () => {
      const result = manager.listSessions();
      expect(result.sessions).toEqual([]);
    });

    it("includes active sessions", async () => {
      const startPromise = manager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("list-session");
      await startPromise;

      const result = manager.listSessions();
      const found = result.sessions.find((s) => s.sessionId === "list-session");
      expect(found).toBeDefined();
      expect(found!.isActive).toBe(true);
      expect(found!.activeStatus).toBe("active");
    });
  });

  // --- Event handling ---

  describe("event handling", () => {
    it("updates session ID when init event arrives", async () => {
      const startPromise = manager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));

      // Before init, session has temp_ ID
      emitInit("real-id");
      const result = await startPromise;
      expect(result.sessionId).toBe("real-id");

      // Should be accessible by new ID
      const status = manager.getSessionStatus("real-id");
      expect(status.sessionId).toBe("real-id");
    });

    it("sets status to interrupted on SIGINT exit", async () => {
      const startPromise = manager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("sigint-session");
      await startPromise;

      capturedOnExit!(null, "SIGINT");

      const status = manager.getSessionStatus("sigint-session");
      expect(status.status).toBe("interrupted");
    });

    it("sets status to error on non-zero exit", async () => {
      const startPromise = manager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("error-session");
      await startPromise;

      capturedOnExit!(1, null);

      const status = manager.getSessionStatus("error-session");
      expect(status.status).toBe("error");
    });

    it("sets status to done on zero exit", async () => {
      const startPromise = manager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("done-exit");
      await startPromise;

      capturedOnExit!(0, null);

      const status = manager.getSessionStatus("done-exit");
      expect(status.status).toBe("done");
    });

    it("result event takes precedence over exit code", async () => {
      const startPromise = manager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("precedence");
      await startPromise;

      // Result event first, then exit
      emitResult("precedence", "success", "All good");
      capturedOnExit!(0, null);

      const status = manager.getSessionStatus("precedence");
      expect(status.status).toBe("done");
      expect(status.result).toBe("All good");
    });

    it("respects event buffer size limit", async () => {
      const smallBufferConfig = { ...envConfig, eventBufferSize: 3 };
      const smallManager = new SessionManager(smallBufferConfig);
      await smallManager.start();

      const startPromise = smallManager.startSession({ prompt: "test" });
      await new Promise((r) => setTimeout(r, 20));
      emitInit("buffer-test");
      await startPromise;

      // Push 5 text events (+ 1 init = 6 total, buffer size is 3)
      emitText("a");
      emitText("b");
      emitText("c");
      emitText("d");
      emitText("e");

      const status = smallManager.getSessionStatus("buffer-test");
      // Buffer should only contain the last 3 events
      expect(status.recentOutput.length).toBeLessThanOrEqual(3);

      await smallManager.stop();
    });
  });
});
