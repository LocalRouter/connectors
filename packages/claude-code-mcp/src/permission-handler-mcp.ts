#!/usr/bin/env node

/**
 * Standalone MCP server script that Claude Code spawns via --mcp-config.
 *
 * It provides a single tool `permission_check` which receives ALL tool approval
 * requests (regular tools, ExitPlanMode, AskUserQuestion) from Claude Code.
 * It forwards them via HTTP to the permission callback server running in the
 * main MCP server process, and blocks until a response is received.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from "node:http";

const CALLBACK_PORT = process.env.PERMISSION_CALLBACK_PORT;
const SESSION_ID = process.env.PERMISSION_SESSION_ID || "";

if (!CALLBACK_PORT) {
  process.stderr.write("[permission-handler-mcp] PERMISSION_CALLBACK_PORT is required\n");
  process.exit(1);
}

const server = new McpServer({
  name: "permission-handler",
  version: "0.1.0",
});

server.registerTool(
  "permission_check",
  {
    description: "Check if a tool operation is permitted",
    inputSchema: {
      tool_name: z.string().describe("The name of the tool requesting permission"),
      tool_input: z.record(z.string(), z.unknown()).describe("The input parameters for the tool"),
    },
  },
  async ({ tool_name, tool_input }) => {
    try {
      const response = await postToCallback({
        sessionId: SESSION_ID,
        toolName: tool_name,
        toolInput: tool_input as Record<string, unknown>,
        requestId: `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(response),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              behavior: "deny",
              message: `Permission check failed: ${err}`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
);

function postToCallback(body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: parseInt(CALLBACK_PORT!, 10),
        path: "/permission",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(responseBody));
          } catch {
            reject(new Error(`Invalid response: ${responseBody}`));
          }
        });
      },
    );

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[permission-handler-mcp] started\n");
}

main().catch((err) => {
  process.stderr.write(`[permission-handler-mcp] fatal: ${err}\n`);
  process.exit(1);
});
