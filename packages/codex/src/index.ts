#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { startServer } from "./mcp-server.js";
import type { EnvConfig } from "./types.js";

const envConfig: EnvConfig = {
  cliPath: process.env.CODEX_CLI_PATH || "codex",
  approvalTimeoutMs: parseInt(
    process.env.APPROVAL_TIMEOUT_MS || "300000",
    10,
  ),
  maxSessions: parseInt(process.env.MAX_SESSIONS || "10", 10),
  logLevel: process.env.LOG_LEVEL || "info",
  eventBufferSize: parseInt(process.env.EVENT_BUFFER_SIZE || "500", 10),
  codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
};

startServer(envConfig).catch((err) => {
  process.stderr.write(`[codex-mcp] Fatal error: ${err}\n`);
  process.exit(1);
});
