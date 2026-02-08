# Claude Code MCP Server - Implementation Plan

## Overview

An MCP (Model Context Protocol) server that wraps the Claude Code CLI, exposing it as a set of tools over STDIO transport. This enables any MCP client (Claude Desktop, other AI agents, custom tooling) to programmatically operate Claude Code sessions -- creating them, sending prompts, managing permissions, and interrupting execution.

---

## Architecture

### High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  MCP Client (Claude Desktop, AI agent, etc.)                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │ STDIO (JSON-RPC 2.0)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code MCP Server  (@localrouter/claude-code-mcp)         │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ MCP Server   │  │ Session      │  │ Permission             │ │
│  │ (tools,      │  │ Manager      │  │ Manager                │ │
│  │  elicitation)│  │              │  │ (elicitation + queue)  │ │
│  └──────┬───┬──┘  └──────┬───────┘  └───────────┬────────────┘ │
│         │   │            │                       │              │
│         │   │     ┌──────┴───────┐               │              │
│         │   │     │ Process      │               │              │
│         │   │     │ Manager      ├───────────────┘              │
│         │   │     └──────┬───────┘                              │
│         │   │            │                                      │
│         │   │  ┌─────────┴──────────────────────────────┐       │
│         │   │  │ Internal Permission HTTP Callback Server│       │
│         │   │  └─────────┬──────────────────────────────┘       │
│         │   │            │                                      │
└─────────┼───┼────────────┼──────────────────────────────────────┘
          │   │            │
          │   │    spawn   │  For each session:
          │   │            ▼
          │   │  ┌─────────────────────────────────────────────┐
          │   │  │  claude -p                                   │
          │   │  │    --output-format stream-json               │
          │   │  │    --input-format stream-json                │
          │   │  │    --permission-prompt-tool mcp__perm__check │
          │   │  │    --mcp-config <generated-config>           │
          │   │  │    --verbose                                 │
          │   │  │                                              │
          │   │  │  stdin  ◄── NDJSON messages (prompts,        │
          │   │  │             control responses)               │
          │   │  │  stdout ──► NDJSON events (results,          │
          │   │  │             control requests, status)        │
          │   │  │  stderr ──► Debug/log output                 │
          │   │  └──────────────────────────┬──────────────────┘
          │   │                             │
          │   │                    spawns   │
          │   │                             ▼
          │   │  ┌─────────────────────────────────────────────┐
          │   │  │  Permission Handler MCP Server (internal)    │
          │   │  │  - Receives permission requests from Claude  │
          │   │  │  - HTTP POSTs to callback server             │
          │   │  │  - Blocks until response                     │
          │   │  └─────────────────────────────────────────────┘
          │   │
          │   └── MCP Elicitation (if client supports it)
          │        - Forwards permission prompts to human
          │        - Returns accept/reject response
          │
          └── Tool Results (JSON-RPC responses)
```

### Key Design Decisions

1. **`child_process.spawn` over `node-pty`**: Claude Code supports `--output-format stream-json` and `--input-format stream-json`, giving us structured NDJSON I/O. No need for PTY terminal emulation and its fragile ANSI parsing.

2. **Bidirectional streaming JSON**: A single long-lived Claude Code process per session, using NDJSON over stdin/stdout. This avoids the overhead of spawning a new process per message and naturally supports multi-turn conversations.

3. **`--permission-prompt-tool` via internal MCP server**: Claude Code delegates permission checks to an MCP tool. We run a small internal MCP server (spawned by Claude Code via `--mcp-config`) that forwards permission requests back to our main process via HTTP on localhost. This gives us full control over the approval flow.

4. **MCP Elicitation with fallback**: When the MCP client supports elicitation, permission requests are forwarded directly to the human. When it doesn't, requests are queued and exposed via `approve_tool`/`deny_tool` tools.

---

## MCP Tools

### 1. `claude_create_session`

Start a new Claude Code session with an initial prompt.

```typescript
{
  name: "claude_create_session",
  description: "Start a new Claude Code CLI session with an initial prompt",
  inputSchema: {
    type: "object",
    properties: {
      prompt:           { type: "string", description: "The initial task/prompt for Claude Code" },
      workingDirectory: { type: "string", description: "Working directory for the session (default: server CWD)" },
      model:            { type: "string", description: "Model to use (e.g. 'sonnet', 'opus')" },
      allowedTools:     { type: "array", items: { type: "string" }, description: "Tools to pre-approve (e.g. ['Read', 'Glob'])" },
      maxTurns:         { type: "number", description: "Maximum agentic turns before stopping" },
      maxBudgetUsd:     { type: "number", description: "Maximum spend in USD" },
      systemPrompt:     { type: "string", description: "Custom system prompt to append" },
    },
    required: ["prompt"]
  }
}
```

**Returns:** `{ sessionId: string, status: "running" }`

**Behavior:**
- Spawns a new `claude -p` process with streaming JSON flags
- Captures the `session_id` from the `init` event
- Returns immediately (session runs asynchronously)

### 2. `claude_resume_session`

Resume a previously created session with a new prompt.

```typescript
{
  name: "claude_resume_session",
  description: "Resume an existing Claude Code session with a follow-up prompt",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "The session ID to resume" },
      prompt:    { type: "string", description: "The follow-up prompt/task" },
    },
    required: ["sessionId", "prompt"]
  }
}
```

**Returns:** `{ sessionId: string, status: "running" }`

**Behavior:**
- If the session's process has exited, spawns a new process with `--resume <sessionId>`
- If the session's process is still alive, sends the message via stdin (stream-json input)
- Validates the session ID exists

### 3. `claude_get_status`

Check the current status of a session and retrieve output.

```typescript
{
  name: "claude_get_status",
  description: "Get the current status and recent output of a Claude Code session",
  inputSchema: {
    type: "object",
    properties: {
      sessionId:   { type: "string", description: "The session ID to check" },
      outputLines: { type: "number", description: "Number of recent output lines to return (default: 50)" },
    },
    required: ["sessionId"]
  }
}
```

**Returns:**
```typescript
{
  sessionId: string,
  status: "running" | "waiting_for_approval" | "completed" | "error" | "interrupted",
  result?: string,              // Final result if completed
  recentOutput: string[],       // Recent text output events
  pendingApprovals: Array<{     // Pending permission requests
    approvalId: string,
    toolName: string,
    toolInput: object,
    description: string,
  }>,
  toolUseEvents: Array<{       // Tools that have been used
    toolName: string,
    status: "running" | "completed" | "denied",
  }>,
  costUsd?: number,             // Current cost if available
  turnCount?: number,           // Number of agentic turns so far
}
```

### 4. `claude_send_message`

Send additional input to a running or completed session.

```typescript
{
  name: "claude_send_message",
  description: "Send a follow-up message to an existing Claude Code session",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "The session ID" },
      message:   { type: "string", description: "The message to send" },
    },
    required: ["sessionId", "message"]
  }
}
```

**Returns:** `{ sessionId: string, status: "running" }`

**Behavior:**
- If process is alive: writes a user message to stdin in stream-json format
- If process has exited: spawns a new process with `--resume` and the message as prompt
- Essentially an alias for resume but with clearer semantics for ongoing conversations

### 5. `claude_approve`

Approve a pending permission request.

```typescript
{
  name: "claude_approve",
  description: "Approve a pending tool permission request in a Claude Code session",
  inputSchema: {
    type: "object",
    properties: {
      sessionId:  { type: "string", description: "The session ID" },
      approvalId: { type: "string", description: "The approval request ID" },
      modifiedInput: { type: "object", description: "Optional modified tool input (for sanitization)" },
    },
    required: ["sessionId", "approvalId"]
  }
}
```

**Returns:** `{ sessionId: string, status: "running", approved: true }`

### 6. `claude_deny`

Deny a pending permission request.

```typescript
{
  name: "claude_deny",
  description: "Deny a pending tool permission request in a Claude Code session",
  inputSchema: {
    type: "object",
    properties: {
      sessionId:  { type: "string", description: "The session ID" },
      approvalId: { type: "string", description: "The approval request ID" },
      reason:     { type: "string", description: "Reason for denial (shown to Claude)" },
    },
    required: ["sessionId", "approvalId"]
  }
}
```

**Returns:** `{ sessionId: string, status: "running", denied: true }`

### 7. `claude_interrupt`

Interrupt a running session (equivalent to pressing Escape in the CLI).

```typescript
{
  name: "claude_interrupt",
  description: "Interrupt a running Claude Code session (equivalent to pressing Escape)",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "The session ID to interrupt" },
    },
    required: ["sessionId"]
  }
}
```

**Returns:** `{ sessionId: string, status: "interrupted" }`

**Behavior:**
- Sends `SIGINT` to the Claude Code process
- Process should emit an interrupted/result event before exiting
- Session can be resumed later with `claude_resume_session`

### 8. `claude_list_sessions`

List all sessions managed by this MCP server instance.

```typescript
{
  name: "claude_list_sessions",
  description: "List all Claude Code sessions managed by this server",
  inputSchema: {
    type: "object",
    properties: {},
  }
}
```

**Returns:**
```typescript
{
  sessions: Array<{
    sessionId: string,
    status: "running" | "waiting_for_approval" | "completed" | "error" | "interrupted",
    createdAt: string,      // ISO timestamp
    workingDirectory: string,
    pendingApprovals: number,
  }>
}
```

---

## Core Modules

### Module 1: `mcp-server.ts` -- MCP Server Setup

Responsibilities:
- Initialize the MCP server with STDIO transport
- Register all 8 tools
- Detect client elicitation capability during initialization
- Route tool calls to the session manager
- Handle graceful shutdown

```typescript
// Pseudocode structure
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "claude-code-mcp",
  version: "0.1.0",
}, {
  capabilities: {
    tools: {},
    // Declare we may use elicitation
  }
});

// Register tools...
// Connect transport...
```

### Module 2: `session-manager.ts` -- Session Lifecycle

Responsibilities:
- Create, track, and clean up sessions
- Map session IDs to process handles and state
- Provide session state queries
- Handle session reconnection (process died but session ID is valid)

```typescript
interface Session {
  id: string;
  status: SessionStatus;
  process: ChildProcess | null;
  createdAt: Date;
  workingDirectory: string;
  config: SessionConfig;

  // Event buffer (ring buffer of recent events)
  eventBuffer: StreamEvent[];

  // Pending permission requests
  pendingApprovals: Map<string, PendingApproval>;

  // Final result
  result?: string;
  error?: string;

  // Metrics
  costUsd?: number;
  turnCount?: number;
}

type SessionStatus =
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "error"
  | "interrupted";
```

### Module 3: `process-manager.ts` -- Claude Code CLI Process

Responsibilities:
- Spawn Claude Code CLI with correct flags
- Parse NDJSON output stream into typed events
- Send NDJSON messages via stdin
- Handle process lifecycle (spawn, signal, exit)
- Generate `--mcp-config` for the internal permission server

```typescript
interface ProcessManager {
  spawn(config: SpawnConfig): ManagedProcess;
}

interface ManagedProcess {
  readonly pid: number;
  readonly sessionId: string | null; // null until init event received

  // Event stream
  on(event: "init", handler: (data: InitEvent) => void): void;
  on(event: "stream", handler: (data: StreamEvent) => void): void;
  on(event: "result", handler: (data: ResultEvent) => void): void;
  on(event: "permission_request", handler: (data: PermissionRequest) => void): void;
  on(event: "error", handler: (data: ErrorEvent) => void): void;
  on(event: "exit", handler: (code: number | null, signal: string | null) => void): void;

  // Actions
  sendMessage(message: string, sessionId: string): void;
  sendControlResponse(requestId: string, response: ControlResponse): void;
  interrupt(): void;
  kill(): void;
}

interface SpawnConfig {
  prompt: string;
  workingDirectory: string;
  resumeSessionId?: string;
  model?: string;
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  permissionCallbackPort: number;
}
```

### Module 4: `stream-parser.ts` -- NDJSON Stream Parser

Responsibilities:
- Transform raw stdout bytes into parsed JSON objects
- Type-discriminate events (init, stream_event, result, control_request, etc.)
- Handle malformed lines gracefully (log to stderr, skip)
- Manage backpressure

```typescript
// Event types based on Claude Code's stream-json format
interface InitEvent {
  type: "init";
  session_id: string;
  timestamp: string;
}

interface StreamEvent {
  type: "stream_event";
  event: {
    type: string;  // "content_block_delta", "content_block_start", etc.
    delta?: {
      type: string;
      text?: string;
    };
    content_block?: {
      type: string;
      name?: string;  // tool name
    };
    // ... other Anthropic API event fields
  };
}

interface ResultEvent {
  type: "result";
  status: "success" | "error" | "interrupted";
  result?: string;
  session_id: string;
  cost_usd?: number;
  duration_ms?: number;
  turns?: number;
}

interface ControlRequest {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    tool_use_id: string;
  };
}
```

### Module 5: `permission-manager.ts` -- Permission Handling

Responsibilities:
- Receive permission requests from the internal HTTP callback server
- Attempt MCP elicitation if client supports it
- Fall back to queueing if elicitation unavailable
- Resolve pending approvals when approve/deny tools are called
- Timeout handling for stale permission requests

```typescript
interface PermissionManager {
  // Called when Claude Code requests permission
  handlePermissionRequest(
    sessionId: string,
    request: PermissionRequest
  ): Promise<PermissionResponse>;

  // Called when MCP client approves via tool
  approve(sessionId: string, approvalId: string, modifiedInput?: object): void;

  // Called when MCP client denies via tool
  deny(sessionId: string, approvalId: string, reason?: string): void;

  // Check for pending approvals
  getPendingApprovals(sessionId: string): PendingApproval[];
}

interface PermissionRequest {
  approvalId: string;    // = tool_use_id
  toolName: string;
  toolInput: Record<string, unknown>;
  description: string;   // Human-readable description
}

interface PermissionResponse {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}
```

### Module 6: `permission-callback-server.ts` -- Internal HTTP Server

Responsibilities:
- Listen on a random localhost port
- Receive HTTP POST requests from the internal permission handler MCP server
- Forward to the permission manager
- Block until the permission is resolved
- Return the allow/deny response

```typescript
// POST /permission-check
// Body: { sessionId: string, tool_use_id: string, tool_name: string, input: object }
// Response: { behavior: "allow" | "deny", updatedInput?: object, message?: string }
```

### Module 7: `permission-handler-mcp.ts` -- Internal Permission MCP Server Script

A standalone Node.js script that Claude Code spawns as an MCP server. It:
1. Registers a single tool: `permission_check`
2. When called, HTTP POSTs to the callback server (port passed via env var)
3. Blocks until the HTTP response arrives
4. Returns the allow/deny result to Claude Code

This file is bundled with the package and referenced in the generated `--mcp-config`.

```typescript
// Standalone script, not imported by the main server
// Invoked as: node permission-handler-mcp.mjs
// Env: PERMISSION_CALLBACK_PORT, PERMISSION_SESSION_ID

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const port = process.env.PERMISSION_CALLBACK_PORT;
const sessionId = process.env.PERMISSION_SESSION_ID;

const server = new McpServer({ name: "perm-handler", version: "1.0.0" });

server.tool("permission_check", "Handle permission requests", {
  tool_use_id: z.string(),
  tool_name: z.string(),
  input: z.any(),
}, async ({ tool_use_id, tool_name, input }) => {
  const response = await fetch(`http://127.0.0.1:${port}/permission-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, tool_use_id, tool_name, input }),
  });
  const result = await response.json();
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## Permission Flow Detail

### Flow A: Client Supports Elicitation

```
MCP Client                Our MCP Server              Claude Code CLI          Perm Handler MCP
    │                          │                            │                        │
    │  call create_session     │                            │                        │
    │─────────────────────────►│  spawn claude -p ...       │                        │
    │                          │───────────────────────────►│                        │
    │  { sessionId, running }  │                            │                        │
    │◄─────────────────────────│                            │                        │
    │                          │                            │                        │
    │                          │                            │ wants to Edit file     │
    │                          │                            │──────────────────────►│
    │                          │                            │ call permission_check  │
    │                          │                            │                        │
    │                          │  HTTP POST /permission     │                        │
    │                          │◄───────────────────────────────────────────────────│
    │                          │                            │                        │
    │  elicitation/create      │                            │                        │
    │  "Claude wants to edit   │                            │                        │
    │   src/auth.ts. Allow?"   │                            │                        │
    │◄─────────────────────────│                            │                        │
    │                          │                            │                        │
    │  { action: "accept" }    │                            │                        │
    │─────────────────────────►│                            │                        │
    │                          │                            │                        │
    │                          │  HTTP 200 { allow }        │                        │
    │                          │───────────────────────────────────────────────────►│
    │                          │                            │◄─────────────────────│
    │                          │                            │  { allow }            │
    │                          │                            │                        │
    │                          │                            │ proceeds with edit     │
```

### Flow B: Client Does NOT Support Elicitation

```
MCP Client                Our MCP Server              Claude Code CLI          Perm Handler MCP
    │                          │                            │                        │
    │                          │                            │ wants to Edit file     │
    │                          │                            │──────────────────────►│
    │                          │  HTTP POST /permission     │                        │
    │                          │◄───────────────────────────────────────────────────│
    │                          │                            │                        │
    │                          │  (queues request, blocks   │                        │
    │                          │   HTTP response)           │                        │
    │                          │                            │                        │
    │  call get_status         │                            │                        │
    │─────────────────────────►│                            │                        │
    │  { waiting_for_approval, │                            │                        │
    │    pendingApprovals: [   │                            │                        │
    │      { Edit src/auth.ts }│                            │                        │
    │    ] }                   │                            │                        │
    │◄─────────────────────────│                            │                        │
    │                          │                            │                        │
    │  call approve(id)        │                            │                        │
    │─────────────────────────►│                            │                        │
    │                          │  HTTP 200 { allow }        │                        │
    │                          │───────────────────────────────────────────────────►│
    │                          │                            │◄─────────────────────│
    │                          │                            │  { allow }            │
    │  { approved: true }      │                            │                        │
    │◄─────────────────────────│                            │                        │
```

---

## Session Lifecycle

### State Machine

```
                    create_session
                         │
                         ▼
                    ┌──────────┐
        ┌──────────│  RUNNING  │◄─────────────────────┐
        │          └─────┬─────┘                       │
        │                │                             │
        │    permission  │           approve/deny      │
        │    request     │                             │
        │                ▼                             │
        │   ┌────────────────────────┐                 │
        │   │  WAITING_FOR_APPROVAL  │─────────────────┘
        │   └────────────────────────┘
        │
        │  interrupt
        │  (SIGINT)
        │                ┌──────────────┐   resume_session
        ├───────────────►│  INTERRUPTED  │──────────────────►  RUNNING
        │                └──────────────┘
        │
        │  process exits
        │  successfully
        │                ┌──────────────┐   resume_session
        ├───────────────►│  COMPLETED    │──────────────────►  RUNNING
        │                └──────────────┘
        │
        │  process crashes
        │  or error
        │                ┌──────────────┐   resume_session
        └───────────────►│  ERROR        │──────────────────►  RUNNING
                         └──────────────┘
```

Any terminal state (INTERRUPTED, COMPLETED, ERROR) can transition back to RUNNING via `resume_session` or `send_message`, which spawns a new process with `--resume`.

### Session Reconnection

When the MCP server restarts (e.g., client reconnects), it starts with no active sessions. However, if a client provides a session ID from a previous run, we can resume it:

1. Client calls `claude_resume_session` with an old session ID
2. We create a new Session object with that ID
3. Spawn `claude -p --resume <sessionId> --output-format stream-json ...`
4. Claude Code loads the session history from its own persistence (`.claude/` directory)
5. The session is now live again

This works because Claude Code's `--resume` loads the full conversation history from disk. Our MCP server doesn't need to persist anything -- Claude Code handles it.

---

## Process Management Detail

### Spawning a Claude Code Process

```typescript
const args = [
  "-p", prompt,
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--verbose",
];

if (config.resumeSessionId) {
  args.push("--resume", config.resumeSessionId);
}
if (config.model) {
  args.push("--model", config.model);
}
if (config.allowedTools?.length) {
  args.push("--allowedTools", ...config.allowedTools);
}
if (config.maxTurns) {
  args.push("--max-turns", String(config.maxTurns));
}
if (config.maxBudgetUsd) {
  args.push("--max-budget-usd", String(config.maxBudgetUsd));
}
if (config.systemPrompt) {
  args.push("--append-system-prompt", config.systemPrompt);
}

// Permission handling
const mcpConfig = {
  mcpServers: {
    perm: {
      command: "node",
      args: [permissionHandlerScriptPath],
      env: {
        PERMISSION_CALLBACK_PORT: String(config.permissionCallbackPort),
        PERMISSION_SESSION_ID: sessionId,
      },
    },
  },
};
args.push("--mcp-config", JSON.stringify(mcpConfig));
args.push("--permission-prompt-tool", "mcp__perm__permission_check");

const child = spawn("claude", args, {
  cwd: config.workingDirectory,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});
```

### Sending Messages to a Running Process

When using `--input-format stream-json`, messages sent to stdin follow this format:

```json
{"type":"user","message":{"role":"user","content":"Follow-up message"},"session_id":"<session_id>"}
```

### Interrupt via SIGINT

```typescript
// Equivalent to pressing Escape in interactive mode
child.kill("SIGINT");
```

Claude Code should emit a result event with `status: "interrupted"` before exiting.

### Process Exit Handling

```typescript
child.on("exit", (code, signal) => {
  if (signal === "SIGINT") {
    session.status = "interrupted";
  } else if (code === 0) {
    session.status = "completed";
  } else {
    session.status = "error";
    session.error = `Process exited with code ${code}`;
  }
  session.process = null;
});
```

---

## Event Buffer Design

Each session maintains a ring buffer of recent events for the `get_status` tool.

```typescript
class EventBuffer {
  private events: StreamEvent[] = [];
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  push(event: StreamEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  getRecent(n: number): StreamEvent[] {
    return this.events.slice(-n);
  }

  // Extract text content from recent events
  getRecentText(n: number): string[] {
    return this.events
      .filter(e => e.type === "stream_event" && e.event?.delta?.text)
      .slice(-n)
      .map(e => e.event.delta.text!);
  }
}
```

---

## File Structure

```
packages/claude-code-mcp/
├── package.json
├── tsconfig.json
├── PLAN.md                              # This file
├── src/
│   ├── index.ts                         # Entry point, starts MCP server
│   ├── mcp-server.ts                    # MCP server setup, tool registration
│   ├── session-manager.ts               # Session lifecycle management
│   ├── process-manager.ts               # Claude Code CLI process spawning/management
│   ├── stream-parser.ts                 # NDJSON stream parsing, event typing
│   ├── permission-manager.ts            # Permission handling (elicitation + queue)
│   ├── permission-callback-server.ts    # Internal HTTP server for permission callbacks
│   ├── permission-handler-mcp.ts        # Standalone MCP server script for Claude Code
│   └── types.ts                         # Shared type definitions
├── test/
│   ├── mock-claude-cli.ts               # Mock Claude Code CLI for testing
│   ├── stream-parser.test.ts            # Stream parser unit tests
│   ├── session-manager.test.ts          # Session manager unit tests
│   ├── permission-manager.test.ts       # Permission manager unit tests
│   ├── process-manager.test.ts          # Process manager integration tests
│   ├── mcp-server.test.ts              # MCP tool handler tests
│   └── e2e.test.ts                      # End-to-end tests (optional, needs real CLI)
```

---

## Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x",
    "zod": "^3.x",
    "split2": "^4.x"
  },
  "devDependencies": {
    "typescript": "^5.9",
    "vitest": "^3.x",
    "@types/split2": "^4.x",
    "@types/node": "^22.x"
  }
}
```

---

## Testing Strategy

### 1. Mock Claude Code CLI (`test/mock-claude-cli.ts`)

A standalone Node.js script that simulates Claude Code's stream-json behavior. This is the foundation for all non-E2E tests.

**Capabilities:**
- Accepts the same flags as real Claude Code (`-p`, `--output-format`, `--input-format`, `--resume`, etc.)
- Emits `init` event with a session ID
- Emits `stream_event` events with configurable text content
- Emits `result` event on completion
- Supports permission requests (emits control_request or calls permission-prompt-tool)
- Responds to SIGINT by emitting interrupted result
- Can simulate delays, errors, and multi-turn conversations
- Behavior controlled via environment variables or a config file

```typescript
// Example: mock-claude-cli.ts
// MOCK_BEHAVIOR=success|error|permission_request|slow|hang
// MOCK_RESULT="The task is complete"
// MOCK_PERMISSION_TOOL="Bash"

// Reads from stdin (stream-json format), writes to stdout (stream-json format)
```

### 2. Unit Tests

**`stream-parser.test.ts`**
- Parses valid NDJSON lines into typed events
- Handles malformed JSON gracefully (skips, logs)
- Handles partial lines (buffering)
- Handles backpressure
- Correctly discriminates event types (init, stream_event, result)

**`session-manager.test.ts`**
- Creates sessions with correct initial state
- State transitions (running → waiting_for_approval → running → completed)
- Tracks multiple concurrent sessions
- Handles session not found errors
- Cleans up sessions on process exit
- Resume creates new process with correct flags

**`permission-manager.test.ts`**
- Queues permission requests when elicitation unavailable
- Resolves pending approvals on approve/deny
- Attempts elicitation when client supports it
- Times out stale permission requests
- Handles concurrent permission requests for same session

### 3. Integration Tests

**`process-manager.test.ts`**
- Spawns mock CLI, captures init event and session ID
- Sends messages via stdin, receives responses
- Interrupt via SIGINT produces interrupted status
- Handles process crash (non-zero exit)
- Handles process hang (timeout)
- Permission flow via internal HTTP callback

**`mcp-server.test.ts`**
- Tests each tool handler with mock session manager
- Validates input schema enforcement
- Tests error responses for invalid session IDs
- Tests elicitation flow with mock MCP client

### 4. End-to-End Tests (`e2e.test.ts`)

Gated behind `CLAUDE_CODE_E2E=true` environment variable. Requires real Claude Code CLI installed and `ANTHROPIC_API_KEY` set.

- Creates a real session with a simple prompt
- Checks status until completion
- Resumes a completed session
- Interrupts a running session
- Permission approval flow

### 5. Test Infrastructure

**Test runner:** Vitest (fast, native TypeScript/ESM support, good async handling)

**Test scripts in package.json:**
```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:e2e": "CLAUDE_CODE_E2E=true vitest run test/e2e.test.ts"
}
```

---

## Implementation Phases

### Phase 1: Foundation
- [ ] Set up dependencies (MCP SDK, zod, split2, vitest)
- [ ] Implement `types.ts` with all shared types
- [ ] Implement `stream-parser.ts` with NDJSON parsing
- [ ] Write `stream-parser.test.ts`
- [ ] Create `mock-claude-cli.ts`

### Phase 2: Process Management
- [ ] Implement `process-manager.ts` (spawn, parse events, send messages, signal)
- [ ] Write `process-manager.test.ts` using mock CLI
- [ ] Verify bidirectional stream-json communication works

### Phase 3: Session Management
- [ ] Implement `session-manager.ts` (lifecycle, state machine, event buffer)
- [ ] Write `session-manager.test.ts`
- [ ] Implement session resume logic

### Phase 4: Permission Handling
- [ ] Implement `permission-callback-server.ts` (internal HTTP server)
- [ ] Implement `permission-handler-mcp.ts` (standalone script)
- [ ] Implement `permission-manager.ts` (elicitation + queue)
- [ ] Write `permission-manager.test.ts`

### Phase 5: MCP Server & Tools
- [ ] Implement `mcp-server.ts` with all 8 tools
- [ ] Implement `index.ts` entry point
- [ ] Write `mcp-server.test.ts`
- [ ] Test elicitation detection and flow

### Phase 6: Integration & Polish
- [ ] Write E2E tests
- [ ] Handle edge cases (concurrent sessions, rapid create/interrupt, process leaks)
- [ ] Implement graceful shutdown (kill all child processes)
- [ ] Add stderr logging throughout
- [ ] Build and verify the package works end-to-end

---

## Configuration

The MCP server itself is configured by the MCP client that launches it. Example client configuration:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "node",
      "args": ["./node_modules/@localrouter/claude-code-mcp/dist/index.js"],
      "env": {
        "CLAUDE_CODE_PATH": "/usr/local/bin/claude",
        "DEFAULT_WORKING_DIR": "/home/user/projects",
        "PERMISSION_TIMEOUT_MS": "300000",
        "MAX_SESSIONS": "10",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_CODE_PATH` | `"claude"` | Path to the Claude Code CLI binary |
| `DEFAULT_WORKING_DIR` | `process.cwd()` | Default working directory for new sessions |
| `PERMISSION_TIMEOUT_MS` | `300000` (5 min) | Timeout for pending permission requests |
| `MAX_SESSIONS` | `10` | Maximum concurrent sessions |
| `LOG_LEVEL` | `"info"` | Logging level (debug, info, warn, error) |
| `EVENT_BUFFER_SIZE` | `500` | Number of events to retain per session |

---

## Open Questions & Risks

### Known Issues to Watch

1. **`--input-format stream-json` multi-turn reliability**: There are reported issues with hanging after the second message (GitHub #3187, marked resolved) and duplicate session log entries (#5034, cosmetic only). Need to verify these are fully resolved in current CLI versions.

2. **`--permission-prompt-tool` event emission**: A bug was reported (SDK issue #469) where `control_request` events were not emitted in some CLI versions. Our architecture using a separate MCP server for permissions (rather than inline control_request/control_response) should be more robust.

3. **SIGINT behavior on Windows**: `subprocess.kill('SIGINT')` on Windows causes immediate forceful termination. May need IPC-based interrupt signaling for Windows support.

### Design Alternatives Considered

1. **Agent SDK instead of CLI**: Using `@anthropic-ai/claude-agent-sdk` directly would give cleaner hooks and streaming, but the user specifically requested CLI wrapping, and the CLI approach keeps the MCP server independent of API key management.

2. **PTY-based interactive session**: Using `node-pty` to run Claude Code interactively was considered but rejected. Parsing ANSI terminal output is fragile, stdout/stderr are merged in PTY, and `stream-json` provides structured data natively.

3. **Inline `control_request`/`control_response`**: Using `--permission-prompt-tool stdio` for inline permission handling through the same stdin/stdout channel was considered. While simpler (no HTTP server needed), it has known reliability issues and mixes permission protocol with the streaming output protocol.

### Future Enhancements

- **Persistent session index**: Store a session index file to survive MCP server restarts without the client needing to remember session IDs.
- **Cost tracking**: Aggregate and report cost across sessions.
- **Tool filtering UI**: Let MCP clients configure allowed/denied tools through a resource or prompt.
- **Multiple working directories**: Support sessions that span multiple project directories.
- **Session forking**: Use `--fork-session` to branch sessions for experimentation.

---

## Appendix: Lessons from Existing CLI Wrappers

Analysis of two existing Claude Code wrapper projects informed several design decisions.

### From `RichardAtCT/claude-code-openai-wrapper` (Python, Agent SDK)

This project wraps Claude Code behind an OpenAI-compatible REST API using the Python Agent SDK (not CLI subprocess). Despite the different approach, several lessons apply directly:

1. **`permissionMode: "bypassPermissions"` is essential for headless operation.** Without it, the SDK/CLI tries to interactively prompt for approval, which hangs in a server context. This was their biggest bug -- tools appeared "enabled" but never executed because the SDK was silently waiting for interactive approval. Our `--permission-prompt-tool` approach solves this differently (we route approvals programmatically rather than bypassing them), but we must ensure Claude Code never falls back to interactive prompting.

2. **SDK/CLI message format instability across versions.** Their code is littered with dual-format handling (`hasattr(block, "text")` vs `isinstance(block, dict)`) because the Agent SDK changed its return types between versions. Our stream-json parser should be defensive about message shapes and handle unknown event types gracefully rather than crashing.

3. **System prompt must be structured.** The SDK requires `{"type": "text", "text": "..."}` (or `{"type": "preset", "preset": "claude_code"}`), not plain strings. Verify whether the CLI's `--append-system-prompt` flag handles this automatically or if we need structured formatting.

4. **Working directory isolation is critical.** Without an explicit working directory, Claude Code operates in the server's own directory and could read/modify the MCP server's source code. Every session must have an explicit `cwd` set.

5. **`max_turns=1` when tools are disabled prevents wasted loops.** If a session is configured without tools, setting `--max-turns 1` avoids multi-turn reasoning loops where Claude tries to use tools that don't exist.

6. **Session management can be in-memory with TTL.** Their sessions use a 1-hour TTL with a background cleanup task every 5 minutes. Since Claude Code persists sessions to disk (`.claude/`), our in-memory session tracking can be lightweight -- we just need enough state to manage the process lifecycle. If a session expires from our tracker, the client can always resume it via `claude_resume_session` with the session ID.

7. **Token/cost estimation is approximate.** The SDK doesn't always provide exact token counts. When not available, they use a rough `len(text) / 4` heuristic. We should extract `cost_usd` from the `result` event when available but not depend on it.

8. **Factory pattern for mock/real implementations aids testing.** When `node-pty` is not available (e.g., in CI), they fall back to a mock implementation. We should use dependency injection for the process manager to enable the same pattern with our mock CLI.

### From `jasonpaulso/claude-cli-lib` (TypeScript, node-pty)

This project is a generic PTY-based CLI process spawner. While it lacks Claude Code-specific features, it provides important anti-patterns and validation of our design choices:

1. **PTY is the wrong tool for structured JSON communication.** Their use of `node-pty` means stdout and stderr are merged into a single stream, there's no way to write to stdin separately, and all output contains raw ANSI escape codes. Our decision to use `child_process.spawn` with piped stdio is validated -- structured NDJSON is fundamentally incompatible with PTY.

2. **No stdin writing = no interactivity.** Their library has literally no method to write to the spawned process's stdin. This means no follow-up messages, no permission responses, no structured input. This is the direct consequence of using PTY without building a terminal emulator. Our `--input-format stream-json` approach avoids this entirely.

3. **Process lifecycle cleanup in `finally` blocks.** Their pattern of cleaning up PTY handles in `finally` blocks is correct. We should do the same for our child processes -- ensure stdin is closed, output handlers are removed, and process references are cleared regardless of how the process ends.

4. **Ring buffer for output storage.** Their `OutputStreamer` uses an array with a configurable max size and FIFO eviction, which matches our `EventBuffer` design. A max size of 500-1000 entries is reasonable.

5. **The `CommandSanitizer` concept is useful but applies differently.** Their sanitizer blocks shell metacharacters, path traversal, and API key exposure in command arguments. For our MCP server, sanitization happens at a different level -- the MCP client sends prompts and tool parameters, and we validate those before passing them to Claude Code. We should still validate that prompts don't contain injection attempts and that working directories are within allowed paths.

6. **Kill sends SIGHUP, not SIGINT.** PTY's `kill()` sends SIGHUP by default, which is different from SIGINT. With `child_process.spawn`, we have explicit control and should use `SIGINT` for graceful interrupt (equivalent to Escape) and `SIGTERM`/`SIGKILL` for forced termination.

### Summary of Design Validations

| Decision | Validated By |
|---|---|
| Use `child_process.spawn`, not `node-pty` | `claude-cli-lib` shows PTY limitations (no stdin, merged streams) |
| Use `--permission-prompt-tool`, not `bypassPermissions` | `openai-wrapper` shows bypass works but loses all safety |
| Defensive stream parsing with graceful error handling | `openai-wrapper` encountered SDK format changes between versions |
| In-memory sessions with TTL cleanup | `openai-wrapper` uses same pattern successfully |
| Explicit working directory per session | `openai-wrapper` learned this the hard way (security issue) |
| Ring buffer for event storage | Both projects use bounded output buffers |
| Factory/DI pattern for testability | `claude-cli-lib` uses factory for mock/real implementations |
