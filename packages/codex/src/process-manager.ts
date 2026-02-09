import { spawn, type ChildProcess } from "node:child_process";
import { createNdjsonParser, log } from "@localrouter/mcp-base";
import { parseEvent } from "./stream-parser.js";
import type { SpawnConfig, CodexEvent, EnvConfig, ApprovalResponse } from "./types.js";

/**
 * Spawn a `codex exec` process with the given configuration.
 * Streams JSONL events from stdout, monitors stderr for approval requests.
 */
export function spawnCodexProcess(
  config: SpawnConfig,
  envConfig: EnvConfig,
  onEvent: (event: CodexEvent) => void,
  onApprovalRequest: (request: string) => void,
  onExit: (code: number | null, signal: string | null) => void,
): ChildProcess {
  const cliPath = envConfig.cliPath;
  const args: string[] = ["exec"];

  if (config.resumeSessionId) {
    args.push("resume", config.resumeSessionId);
  }

  args.push("--json");

  // Only pass optional flags when explicitly set
  if (config.model !== undefined) args.push("--model", config.model);
  if (config.approvalPolicy !== undefined) args.push("--ask-for-approval", config.approvalPolicy);
  if (config.sandbox !== undefined) args.push("--sandbox", config.sandbox);
  if (config.fullAuto) args.push("--full-auto");
  if (config.profile !== undefined) args.push("--profile", config.profile);
  if (config.config) {
    for (const [key, value] of Object.entries(config.config)) {
      args.push("-c", `${key}=${value}`);
    }
  }
  if (config.baseInstructions !== undefined) {
    args.push("-c", `instructions.base_instructions=${JSON.stringify(config.baseInstructions)}`);
  }
  if (config.images?.length) args.push("--image", config.images.join(","));
  if (config.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (config.dangerouslyBypassApprovalsAndSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  // Prompt: positional argument (last)
  args.push(config.prompt);

  const child = spawn(cliPath, args, {
    cwd: config.workingDirectory || process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Parse JSONL from stdout
  if (child.stdout) {
    const parser = createNdjsonParser();
    child.stdout.pipe(parser);
    parser.on("data", (data: unknown) => onEvent(parseEvent(data)));
    parser.on("error", (err: Error) => log("process-manager", "warn", `Stream parse error: ${err.message}`));
  }

  // Monitor stderr for approval requests and debug output
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && isApprovalRequest(text)) {
        onApprovalRequest(text);
      } else if (text) {
        log("process-manager", "debug", `[codex stderr] ${text}`);
      }
    });
  }

  child.on("exit", (code, signal) => onExit(code, signal));
  child.on("error", (err) => {
    log("process-manager", "error", `Process error: ${err.message}`);
    onExit(1, null);
  });

  return child;
}

/**
 * Send an approval response to the Codex process via stdin.
 */
export function sendApprovalResponse(child: ChildProcess, response: ApprovalResponse): void {
  if (!child.stdin || child.stdin.destroyed) {
    throw new Error("Process stdin is not available");
  }
  const payload = response.approved ? "y\n" : "n\n";
  child.stdin.write(payload);
}

/**
 * Interrupt a running process by sending SIGINT.
 */
export function interruptProcess(child: ChildProcess): void {
  child.kill("SIGINT");
}

/**
 * Heuristic to detect approval requests from Codex stderr output.
 * The exact pattern depends on codex exec behavior.
 */
function isApprovalRequest(text: string): boolean {
  return /\b(allow|approve|apply|permit)\b.*\?/i.test(text);
}
