import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { ParsedEvent, EnvConfig, SpawnConfig } from "../src/types.js";

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock import.meta.url for getPermissionHandlerScriptPath
vi.mock("node:url", () => ({
  fileURLToPath: () => "/mock/dist/process-manager.js",
}));

// Import after mocks are set up
const { spawnClaudeProcess, sendMessage, interruptProcess } = await import(
  "../src/process-manager.js"
);

function createMockChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: 12345,
    kill: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    connected: false,
    exitCode: null,
    signalCode: null,
    killed: false,
    spawnargs: [],
    spawnfile: "",
    disconnect: vi.fn(),
    send: vi.fn(),
    stdio: [null, null, null, null, null] as any,
    [Symbol.dispose]: vi.fn(),
  }) as unknown as ChildProcess;
  return child;
}

const envConfig: EnvConfig = {
  claudeCodePath: "/usr/bin/claude",
  permissionTimeoutMs: 300000,
  maxSessions: 10,
  logLevel: "error",
  eventBufferSize: 500,
};

describe("spawnClaudeProcess", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("spawns process with required flags", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const config: SpawnConfig = {
      prompt: "Hello world",
      permissionCallbackPort: 3000,
    };

    spawnClaudeProcess(config, envConfig, vi.fn(), vi.fn());

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cliPath, args] = mockSpawn.mock.calls[0];
    expect(cliPath).toBe("/usr/bin/claude");
    expect(args).toContain("-p");
    expect(args).toContain("Hello world");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--input-format");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
  });

  it("passes resume flag when resumeSessionId is set", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const config: SpawnConfig = {
      prompt: "continue",
      resumeSessionId: "session-abc",
      permissionCallbackPort: 3000,
    };

    spawnClaudeProcess(config, envConfig, vi.fn(), vi.fn());

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--resume");
    expect(args).toContain("session-abc");
  });

  it("only passes optional flags when explicitly set", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    // No optional flags set
    const config: SpawnConfig = {
      prompt: "test",
      permissionCallbackPort: 3000,
    };

    spawnClaudeProcess(config, envConfig, vi.fn(), vi.fn());

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--disallowedTools");
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("--max-budget-usd");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("passes all optional flags when set", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const config: SpawnConfig = {
      prompt: "test",
      model: "opus",
      permissionMode: "plan",
      allowedTools: ["Read", "Glob"],
      disallowedTools: ["Bash"],
      maxTurns: 5,
      maxBudgetUsd: 1.5,
      systemPrompt: "Be helpful",
      permissionCallbackPort: 3000,
    };

    spawnClaudeProcess(config, envConfig, vi.fn(), vi.fn());

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--model");
    expect(args).toContain("opus");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read");
    expect(args).toContain("Glob");
    expect(args).toContain("--disallowedTools");
    expect(args).toContain("Bash");
    expect(args).toContain("--max-turns");
    expect(args).toContain("5");
    expect(args).toContain("--max-budget-usd");
    expect(args).toContain("1.5");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("Be helpful");
  });

  it("skips permission MCP config when dangerouslySkipPermissions is true", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const config: SpawnConfig = {
      prompt: "test",
      dangerouslySkipPermissions: true,
      permissionCallbackPort: 3000,
    };

    spawnClaudeProcess(config, envConfig, vi.fn(), vi.fn());

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--permission-prompt-tool");
  });

  it("includes MCP config and permission-prompt-tool when permissions not bypassed", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const config: SpawnConfig = {
      prompt: "test",
      permissionCallbackPort: 4567,
    };

    spawnClaudeProcess(config, envConfig, vi.fn(), vi.fn());

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--mcp-config");
    expect(args).toContain("--permission-prompt-tool");
    expect(args).toContain("mcp__perm__permission_check");

    // Verify MCP config JSON contains the port
    const mcpConfigIdx = args.indexOf("--mcp-config");
    const mcpConfigJson = JSON.parse(args[mcpConfigIdx + 1]);
    expect(mcpConfigJson.mcpServers.perm.env.PERMISSION_CALLBACK_PORT).toBe("4567");
  });

  it("parses NDJSON events from stdout and calls onEvent", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const events: ParsedEvent[] = [];
    spawnClaudeProcess(
      { prompt: "test", permissionCallbackPort: 3000 },
      envConfig,
      (e) => events.push(e),
      vi.fn(),
    );

    // Write NDJSON to stdout
    child.stdout!.push(JSON.stringify({ type: "init", session_id: "s1" }) + "\n");
    child.stdout!.push(
      JSON.stringify({ type: "result", status: "success", session_id: "s1" }) + "\n",
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("init");
    expect(events[1].type).toBe("result");
  });

  it("calls onExit when process exits", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const onExit = vi.fn();
    spawnClaudeProcess(
      { prompt: "test", permissionCallbackPort: 3000 },
      envConfig,
      vi.fn(),
      onExit,
    );

    (child as unknown as EventEmitter).emit("exit", 0, null);

    expect(onExit).toHaveBeenCalledWith(0, null);
  });

  it("calls onExit with signal on SIGINT", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const onExit = vi.fn();
    spawnClaudeProcess(
      { prompt: "test", permissionCallbackPort: 3000 },
      envConfig,
      vi.fn(),
      onExit,
    );

    (child as unknown as EventEmitter).emit("exit", null, "SIGINT");

    expect(onExit).toHaveBeenCalledWith(null, "SIGINT");
  });

  it("uses working directory from config", () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    spawnClaudeProcess(
      { prompt: "test", workingDirectory: "/tmp/project", permissionCallbackPort: 3000 },
      envConfig,
      vi.fn(),
      vi.fn(),
    );

    const options = mockSpawn.mock.calls[0][2];
    expect(options.cwd).toBe("/tmp/project");
  });
});

// --- sendMessage ---

describe("sendMessage", () => {
  it("writes NDJSON to stdin", () => {
    const child = createMockChild();
    const writeSpy = vi.spyOn(child.stdin!, "write");

    sendMessage(child, "session-123", "Hello");

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = writeSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content).toBe("Hello");
    expect(parsed.session_id).toBe("session-123");
  });

  it("throws when stdin is unavailable", () => {
    const child = createMockChild();
    (child as any).stdin = null;

    expect(() => sendMessage(child, "s1", "test")).toThrow("stdin is not available");
  });

  it("throws when stdin is destroyed", () => {
    const child = createMockChild();
    child.stdin!.destroy();

    expect(() => sendMessage(child, "s1", "test")).toThrow("stdin is not available");
  });
});

// --- interruptProcess ---

describe("interruptProcess", () => {
  it("sends SIGINT to the process", () => {
    const child = createMockChild();
    interruptProcess(child);
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
  });
});
