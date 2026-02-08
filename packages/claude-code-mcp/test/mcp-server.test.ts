import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EnvConfig } from "../src/types.js";

// Mock process-manager to prevent real process spawning
vi.mock("../src/process-manager.js", () => ({
  spawnClaudeProcess: vi.fn(() => ({
    stdin: { write: vi.fn(), destroyed: false },
    stdout: null,
    stderr: null,
    pid: 1,
    kill: vi.fn(),
    on: vi.fn(),
  })),
  sendMessage: vi.fn(),
  interruptProcess: vi.fn(),
  getPermissionHandlerScriptPath: vi.fn(() => "/mock/perm.js"),
}));

const { createMcpServer } = await import("../src/mcp-server.js");

const envConfig: EnvConfig = {
  claudeCodePath: "claude",
  permissionTimeoutMs: 300000,
  maxSessions: 10,
  logLevel: "error",
  eventBufferSize: 500,
};

describe("createMcpServer", () => {
  let mcpServer: ReturnType<typeof createMcpServer>["mcpServer"];
  let sessionManager: ReturnType<typeof createMcpServer>["sessionManager"];

  beforeEach(async () => {
    const result = createMcpServer(envConfig);
    mcpServer = result.mcpServer;
    sessionManager = result.sessionManager;
    await sessionManager.start();
  });

  afterEach(async () => {
    await sessionManager.stop();
  });

  it("returns mcpServer and sessionManager", () => {
    expect(mcpServer).toBeDefined();
    expect(sessionManager).toBeDefined();
  });

  it("registers all 6 tools", () => {
    // McpServer stores registered tools internally as an object keyed by tool name
    const server = mcpServer as any;
    const registeredTools = server._registeredTools;

    expect(registeredTools).toBeDefined();
    const toolNames = Object.keys(registeredTools);
    expect(toolNames).toContain("claude_start");
    expect(toolNames).toContain("claude_say");
    expect(toolNames).toContain("claude_status");
    expect(toolNames).toContain("claude_respond");
    expect(toolNames).toContain("claude_interrupt");
    expect(toolNames).toContain("claude_list");
    expect(toolNames).toHaveLength(6);
  });

  it("has correct server name and version", () => {
    const server = mcpServer as any;
    expect(server.server._serverInfo.name).toBe("claude-code-mcp");
    expect(server.server._serverInfo.version).toBe("0.1.0");
  });
});

// Test SessionManager through the MCP tool interface indirectly
describe("MCP tool handlers via SessionManager", () => {
  let sessionManager: ReturnType<typeof createMcpServer>["sessionManager"];

  beforeEach(async () => {
    const result = createMcpServer(envConfig);
    sessionManager = result.sessionManager;
    await sessionManager.start();
  });

  afterEach(async () => {
    await sessionManager.stop();
  });

  describe("claude_status error handling", () => {
    it("throws for unknown session ID", () => {
      expect(() => sessionManager.getSessionStatus("nonexistent-id")).toThrow(
        "Unknown session",
      );
    });
  });

  describe("claude_respond error handling", () => {
    it("throws for unknown session ID", () => {
      expect(() =>
        sessionManager.respondToQuestion({
          sessionId: "nonexistent",
          id: "q1",
          answers: ["allow"],
        }),
      ).toThrow("Unknown session");
    });
  });

  describe("claude_interrupt error handling", () => {
    it("throws for unknown session ID", () => {
      expect(() => sessionManager.interruptSession("nonexistent")).toThrow(
        "Unknown session",
      );
    });
  });

  describe("claude_list", () => {
    it("returns empty sessions list when no history", () => {
      const result = sessionManager.listSessions();
      expect(result.sessions).toEqual([]);
    });

    it("accepts limit parameter", () => {
      const result = sessionManager.listSessions({ limit: 5 });
      expect(result.sessions).toEqual([]);
    });

    it("accepts workingDirectory filter", () => {
      const result = sessionManager.listSessions({ workingDirectory: "/tmp" });
      expect(result.sessions).toEqual([]);
    });
  });
});
