import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNdjsonParser, log } from "@localrouter/mcp-base";
import { parseEvent } from "./stream-parser.js";
import type { SpawnConfig, ParsedEvent, EnvConfig } from "./types.js";

/**
 * Returns the path to the compiled permission-handler-mcp.js script,
 * which lives alongside this file in dist/.
 */
export function getPermissionHandlerScriptPath(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(thisDir, "permission-handler-mcp.js");
}

/**
 * Spawn a Claude Code CLI process with the given configuration.
 * Streams NDJSON events from stdout, and calls onExit when the process terminates.
 */
export function spawnClaudeProcess(
  config: SpawnConfig,
  envConfig: EnvConfig,
  onEvent: (event: ParsedEvent) => void,
  onExit: (code: number | null, signal: string | null) => void,
): ChildProcess {
  const cliPath = envConfig.claudeCodePath;

  const args: string[] = [
    "-p", config.prompt,
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];

  if (config.resumeSessionId) {
    args.push("--resume", config.resumeSessionId);
  }

  // Only pass optional flags when explicitly set (otherwise CLI defaults apply)
  if (config.model !== undefined) {
    args.push("--model", config.model);
  }
  if (config.permissionMode !== undefined) {
    args.push("--permission-mode", config.permissionMode);
  }
  if (config.allowedTools && config.allowedTools.length > 0) {
    args.push("--allowedTools", ...config.allowedTools);
  }
  if (config.disallowedTools && config.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...config.disallowedTools);
  }
  if (config.maxTurns !== undefined) {
    args.push("--max-turns", String(config.maxTurns));
  }
  if (config.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(config.maxBudgetUsd));
  }
  if (config.systemPrompt !== undefined) {
    args.push("--append-system-prompt", config.systemPrompt);
  }
  if (config.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  // Permission handling via internal MCP server (unless bypassed)
  if (!config.dangerouslySkipPermissions) {
    const permissionHandlerScriptPath = getPermissionHandlerScriptPath();
    const mcpConfig = {
      mcpServers: {
        perm: {
          command: "node",
          args: [permissionHandlerScriptPath],
          env: {
            PERMISSION_CALLBACK_PORT: String(config.permissionCallbackPort),
            PERMISSION_SESSION_ID: config.resumeSessionId || "__pending__",
          },
        },
      },
    };
    args.push("--mcp-config", JSON.stringify(mcpConfig));
    args.push("--permission-prompt-tool", "mcp__perm__permission_check");
  }

  const child = spawn(cliPath, args, {
    cwd: config.workingDirectory || process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Parse NDJSON from stdout
  if (child.stdout) {
    const parser = createNdjsonParser();
    child.stdout.pipe(parser);

    parser.on("data", (data: unknown) => {
      const event = parseEvent(data);
      onEvent(event);
    });

    parser.on("error", (err: Error) => {
      log("process-manager", "warn", `Stream parse error: ${err.message}`);
    });
  }

  // Log stderr
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      log("process-manager", "debug", `[claude stderr] ${chunk.toString().trim()}`);
    });
  }

  child.on("exit", (code, signal) => {
    onExit(code, signal);
  });

  child.on("error", (err) => {
    log("process-manager", "error", `Process error: ${err.message}`);
    onExit(1, null);
  });

  return child;
}

/**
 * Send a follow-up user message to a running Claude Code process via stdin (stream-json format).
 */
export function sendMessage(child: ChildProcess, sessionId: string, message: string): void {
  if (!child.stdin || child.stdin.destroyed) {
    throw new Error("Process stdin is not available");
  }

  const payload = {
    type: "user",
    message: { role: "user", content: message },
    session_id: sessionId,
  };
  child.stdin.write(JSON.stringify(payload) + "\n");
}

/**
 * Interrupt a running process by sending SIGINT (equivalent to pressing Escape in the CLI).
 */
export function interruptProcess(child: ChildProcess): void {
  child.kill("SIGINT");
}
