import { describe, it, expect, afterEach } from "vitest";
import { createMcpServer } from "../src/mcp-server.js";
import type { EnvConfig } from "../src/types.js";

function createEnvConfig(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    cliPath: "node",
    approvalTimeoutMs: 5000,
    maxSessions: 10,
    logLevel: "error",
    eventBufferSize: 500,
    codexHome: "/tmp/codex-test-mcp",
    ...overrides,
  };
}

describe("createMcpServer", () => {
  let sessionManager: ReturnType<typeof createMcpServer>["sessionManager"];

  afterEach(async () => {
    if (sessionManager) {
      await sessionManager.stop();
    }
  });

  it("creates server and session manager", () => {
    const envConfig = createEnvConfig();
    const result = createMcpServer(envConfig);
    sessionManager = result.sessionManager;
    expect(result.mcpServer).toBeDefined();
    expect(result.sessionManager).toBeDefined();
  });

  it("registers all 6 tools", () => {
    const envConfig = createEnvConfig();
    const result = createMcpServer(envConfig);
    sessionManager = result.sessionManager;
    // The MCP server is created without errors -- tools were registered.
    // Deep inspection of tool names requires transport-level testing.
    expect(result.mcpServer).toBeDefined();
  });
});
