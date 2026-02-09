import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapToolHandler, log } from "@localrouter/mcp-base";
import { SessionManager } from "./session-manager.js";
import type { EnvConfig, PermissionMode } from "./types.js";

/**
 * Create the MCP server with all 6 tools and the session manager.
 */
export function createMcpServer(envConfig: EnvConfig): {
  mcpServer: McpServer;
  sessionManager: SessionManager;
} {
  const sessionManager = new SessionManager(envConfig);

  const mcpServer = new McpServer(
    {
      name: "claude-code-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: { listChanged: false },
        logging: {},
      },
    },
  );

  // ── 1. claude_start ────────────────────────────────────────────────
  mcpServer.registerTool(
    "claude_start",
    {
      description:
        "Start a new Claude Code CLI session with an initial prompt",
      inputSchema: {
        prompt: z
          .string()
          .describe("The initial task/prompt for Claude Code"),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory for the session"),
        model: z
          .string()
          .optional()
          .describe(
            "Model override (e.g. 'sonnet', 'opus', or full model ID)",
          ),
        permissionMode: z
          .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
          .optional()
          .describe(
            "Permission mode. 'plan' = read-only analysis then plan review. Default: CLI's configured mode",
          ),
        allowedTools: z
          .array(z.string())
          .optional()
          .describe(
            "Tools to pre-approve without prompting (e.g. ['Read', 'Glob', 'Bash(git diff *)'])",
          ),
        disallowedTools: z
          .array(z.string())
          .optional()
          .describe("Tools to explicitly block"),
        maxTurns: z
          .number()
          .optional()
          .describe("Maximum agentic turns. Default: unlimited"),
        maxBudgetUsd: z
          .number()
          .optional()
          .describe("Maximum spend in USD. Default: unlimited"),
        systemPrompt: z
          .string()
          .optional()
          .describe(
            "System prompt text to append via --append-system-prompt",
          ),
        dangerouslySkipPermissions: z
          .boolean()
          .optional()
          .describe("Skip all permission checks. Default: false"),
      },
    },
    wrapToolHandler(async (args: {
      prompt: string;
      workingDirectory?: string;
      model?: string;
      permissionMode?: string;
      allowedTools?: string[];
      disallowedTools?: string[];
      maxTurns?: number;
      maxBudgetUsd?: number;
      systemPrompt?: string;
      dangerouslySkipPermissions?: boolean;
    }) => {
      return sessionManager.startSession({
        prompt: args.prompt,
        workingDirectory: args.workingDirectory,
        model: args.model,
        permissionMode: args.permissionMode as PermissionMode | undefined,
        allowedTools: args.allowedTools,
        disallowedTools: args.disallowedTools,
        maxTurns: args.maxTurns,
        maxBudgetUsd: args.maxBudgetUsd,
        systemPrompt: args.systemPrompt,
        dangerouslySkipPermissions: args.dangerouslySkipPermissions,
      });
    }),
  );

  // ── 2. claude_say ──────────────────────────────────────────────────
  mcpServer.registerTool(
    "claude_say",
    {
      description:
        "Send a message to a Claude Code session. Automatically resumes the session if it has ended.",
      inputSchema: {
        sessionId: z.string().describe("The session ID"),
        message: z.string().describe("The message to send"),
        permissionMode: z
          .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
          .optional()
          .describe(
            "Switch permission mode for this and subsequent turns",
          ),
      },
    },
    wrapToolHandler(async (args: {
      sessionId: string;
      message: string;
      permissionMode?: string;
    }) => {
      return sessionManager.sayToSession({
        sessionId: args.sessionId,
        message: args.message,
        permissionMode: args.permissionMode as PermissionMode | undefined,
      });
    }),
  );

  // ── 3. claude_status ───────────────────────────────────────────────
  mcpServer.registerTool(
    "claude_status",
    {
      description:
        "Get the current status and recent output of a Claude Code session",
      inputSchema: {
        sessionId: z.string().describe("The session ID to check"),
        outputLines: z
          .number()
          .optional()
          .describe(
            "Number of recent output lines to return (default: 50)",
          ),
      },
    },
    wrapToolHandler((args: { sessionId: string; outputLines?: number }) => {
      return sessionManager.getSessionStatus(
        args.sessionId,
        args.outputLines,
      );
    }),
  );

  // ── 4. claude_respond ──────────────────────────────────────────────
  mcpServer.registerTool(
    "claude_respond",
    {
      description:
        "Respond to a pending question in a Claude Code session. Provide one answer per question, selected from the options shown in claude_status. Answers can include a reason after a colon (e.g. 'deny: too risky', 'reject: also cover auth').",
      inputSchema: {
        sessionId: z.string().describe("The session ID"),
        id: z
          .string()
          .describe(
            "The question ID from pendingQuestion.id in claude_status",
          ),
        answers: z
          .array(z.string())
          .describe(
            "One answer per question. Use option value directly (e.g. 'allow') or with reason (e.g. 'deny: too dangerous')",
          ),
      },
    },
    wrapToolHandler((args: { sessionId: string; id: string; answers: string[] }) => {
      return sessionManager.respondToQuestion({
        sessionId: args.sessionId,
        id: args.id,
        answers: args.answers,
      });
    }),
  );

  // ── 5. claude_interrupt ────────────────────────────────────────────
  mcpServer.registerTool(
    "claude_interrupt",
    {
      description:
        "Interrupt a running Claude Code session (equivalent to pressing Escape)",
      inputSchema: {
        sessionId: z.string().describe("The session ID to interrupt"),
      },
    },
    wrapToolHandler((args: { sessionId: string }) => {
      return sessionManager.interruptSession(args.sessionId);
    }),
  );

  // ── 6. claude_list ─────────────────────────────────────────────────
  mcpServer.registerTool(
    "claude_list",
    {
      description:
        "List all Claude Code sessions across all projects. Includes both programmatic and interactive user-created sessions.",
      inputSchema: {
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Filter to sessions created in this directory. If omitted, lists all sessions.",
          ),
        limit: z
          .number()
          .optional()
          .describe(
            "Maximum sessions to return (default: 50, most recent first)",
          ),
      },
    },
    wrapToolHandler((args: { workingDirectory?: string; limit?: number }) => {
      return sessionManager.listSessions({
        workingDirectory: args.workingDirectory,
        limit: args.limit,
      });
    }),
  );

  return { mcpServer, sessionManager };
}

/**
 * Start the MCP server with STDIO transport and graceful shutdown.
 */
export async function startServer(envConfig: EnvConfig): Promise<void> {
  const { mcpServer, sessionManager } = createMcpServer(envConfig);

  await sessionManager.start();

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  log("mcp-server", "info", "Claude Code MCP server started");

  const shutdown = async (): Promise<void> => {
    log("mcp-server", "info", "Shutting down...");
    await sessionManager.stop();
    await mcpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
