import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapToolHandler, log } from "@localrouter/mcp-base";
import { SessionManager } from "./session-manager.js";
import type { EnvConfig } from "./types.js";

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
      name: "codex-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: { listChanged: false },
        logging: {},
      },
    },
  );

  // ── 1. codex_start ────────────────────────────────────────────────
  mcpServer.registerTool(
    "codex_start",
    {
      description: "Start a new Codex CLI session with an initial prompt",
      inputSchema: {
        prompt: z
          .string()
          .describe("The initial task/prompt for Codex"),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory for the session"),
        model: z
          .string()
          .optional()
          .describe("Model override (e.g. 'o4-mini', 'o3')"),
        approvalPolicy: z
          .enum(["untrusted", "on-failure", "on-request", "never"])
          .optional()
          .describe("Approval policy for commands and patches"),
        sandbox: z
          .enum(["read-only", "workspace-write", "danger-full-access"])
          .optional()
          .describe("Sandbox mode for file system access"),
        fullAuto: z
          .boolean()
          .optional()
          .describe("Enable full auto mode (no approvals)"),
        profile: z
          .string()
          .optional()
          .describe("Codex profile to use"),
        config: z
          .record(z.string(), z.string())
          .optional()
          .describe("Key-value config overrides"),
        baseInstructions: z
          .string()
          .optional()
          .describe("Base instructions to prepend"),
        images: z
          .array(z.string())
          .optional()
          .describe("Image file paths to include"),
        skipGitRepoCheck: z
          .boolean()
          .optional()
          .describe("Skip git repository validation"),
        dangerouslyBypassApprovalsAndSandbox: z
          .boolean()
          .optional()
          .describe("Bypass all approvals and sandbox restrictions"),
      },
    },
    wrapToolHandler(async (args: {
      prompt: string;
      workingDirectory?: string;
      model?: string;
      approvalPolicy?: string;
      sandbox?: string;
      fullAuto?: boolean;
      profile?: string;
      config?: Record<string, string>;
      baseInstructions?: string;
      images?: string[];
      skipGitRepoCheck?: boolean;
      dangerouslyBypassApprovalsAndSandbox?: boolean;
    }) => {
      return sessionManager.startSession(args);
    }),
  );

  // ── 2. codex_say ──────────────────────────────────────────────────
  mcpServer.registerTool(
    "codex_say",
    {
      description:
        "Send a follow-up message to a Codex session. The session must not be actively processing (poll codex_status until done).",
      inputSchema: {
        sessionId: z.string().describe("The session ID"),
        message: z.string().describe("The message to send"),
        images: z
          .array(z.string())
          .optional()
          .describe("Image file paths to include"),
      },
    },
    wrapToolHandler(async (args: {
      sessionId: string;
      message: string;
      images?: string[];
    }) => {
      return sessionManager.sayToSession(args);
    }),
  );

  // ── 3. codex_status ───────────────────────────────────────────────
  mcpServer.registerTool(
    "codex_status",
    {
      description:
        "Get the current status, recent output, and pending approvals of a Codex session",
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

  // ── 4. codex_respond ──────────────────────────────────────────────
  mcpServer.registerTool(
    "codex_respond",
    {
      description:
        "Respond to a pending approval question in a Codex session. Answers can include a reason after a colon (e.g. 'deny: too risky').",
      inputSchema: {
        sessionId: z.string().describe("The session ID"),
        id: z
          .string()
          .describe(
            "The question ID from pendingQuestion.id in codex_status",
          ),
        answers: z
          .array(z.string())
          .describe(
            "One answer per question (e.g. ['approve'] or ['deny: too risky'])",
          ),
      },
    },
    wrapToolHandler((args: { sessionId: string; id: string; answers: string[] }) => {
      return sessionManager.respondToQuestion(args);
    }),
  );

  // ── 5. codex_interrupt ────────────────────────────────────────────
  mcpServer.registerTool(
    "codex_interrupt",
    {
      description: "Interrupt a running Codex session (sends SIGINT)",
      inputSchema: {
        sessionId: z.string().describe("The session ID to interrupt"),
      },
    },
    wrapToolHandler((args: { sessionId: string }) => {
      return sessionManager.interruptSession(args.sessionId);
    }),
  );

  // ── 6. codex_list ─────────────────────────────────────────────────
  mcpServer.registerTool(
    "codex_list",
    {
      description:
        "List Codex sessions. Discovers sessions from $CODEX_HOME/sessions/ directory.",
      inputSchema: {
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Filter to sessions in this directory. If omitted, lists all.",
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
      return sessionManager.listSessions(args);
    }),
  );

  return { mcpServer, sessionManager };
}

/**
 * Start the MCP server with STDIO transport and graceful shutdown.
 */
export async function startServer(envConfig: EnvConfig): Promise<void> {
  const { mcpServer, sessionManager } = createMcpServer(envConfig);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  log("mcp-server", "info", "Codex MCP server started");

  const shutdown = async (): Promise<void> => {
    log("mcp-server", "info", "Shutting down...");
    await sessionManager.stop();
    await mcpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
