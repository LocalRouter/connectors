#!/usr/bin/env node

import { startServer } from "./mcp-server.js";
import type { EnvConfig } from "./types.js";

const envConfig: EnvConfig = {
  claudeCodePath: process.env.CLAUDE_CODE_PATH || "claude",
  permissionTimeoutMs: parseInt(
    process.env.PERMISSION_TIMEOUT_MS || "300000",
    10,
  ),
  maxSessions: parseInt(process.env.MAX_SESSIONS || "10", 10),
  logLevel: process.env.LOG_LEVEL || "info",
  eventBufferSize: parseInt(process.env.EVENT_BUFFER_SIZE || "500", 10),
};

startServer(envConfig).catch((err) => {
  process.stderr.write(`[claude-code-mcp] Fatal error: ${err}\n`);
  process.exit(1);
});
