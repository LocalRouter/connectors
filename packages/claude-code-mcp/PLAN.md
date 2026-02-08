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
          │   │  │    --verbose --include-partial-messages      │
          │   │  │    --permission-prompt-tool mcp__perm__check │
          │   │  │    --mcp-config <generated-config>           │
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
          │   │  │  - Also handles ExitPlanMode & AskUserQuestion│
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

3. **`--permission-prompt-tool` via internal MCP server**: Claude Code delegates permission checks to an MCP tool. We run a small internal MCP server (spawned by Claude Code via `--mcp-config`) that forwards permission requests back to our main process via HTTP on localhost. This gives us full control over the approval flow. This same mechanism handles `ExitPlanMode` and `AskUserQuestion` in plan mode.

4. **MCP Elicitation with fallback**: When the MCP client supports elicitation, permission requests are forwarded directly to the human. When it doesn't, requests are queued and exposed via the `claude_respond` tool.

5. **CLI defaults respected**: Optional parameters like `model`, `maxTurns`, `maxBudgetUsd` are not set unless explicitly provided -- Claude Code CLI's own configuration (from `settings.json`, environment, etc.) takes precedence.

6. **No session storage of our own**: Session persistence is Claude Code's responsibility (`~/.claude/`). Our MCP server only tracks in-memory state for active process handles. `claude_list_sessions` reads directly from `~/.claude/history.jsonl`. Any session (including user-created interactive sessions) can be resumed.

---

## MCP Tools

Six tools total. Tools use CLI defaults for all optional parameters -- if not specified, Claude Code's own configuration applies.

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
      workingDirectory: { type: "string", description: "Working directory for the session" },

      // All optional -- CLI defaults apply when omitted
      model:            { type: "string", description: "Model override (e.g. 'sonnet', 'opus', or full model ID)" },
      permissionMode:   { type: "string", enum: ["default", "acceptEdits", "plan", "bypassPermissions"],
                          description: "Permission mode. 'plan' starts in planning mode (read-only analysis, then ExitPlanMode). Default: CLI's configured mode" },
      allowedTools:     { type: "array", items: { type: "string" },
                          description: "Tools to pre-approve without prompting (e.g. ['Read', 'Glob', 'Bash(git diff *)'])" },
      disallowedTools:  { type: "array", items: { type: "string" },
                          description: "Tools to explicitly block" },
      maxTurns:         { type: "number", description: "Maximum agentic turns. Default: unlimited" },
      maxBudgetUsd:     { type: "number", description: "Maximum spend in USD. Default: unlimited" },
      systemPrompt:     { type: "string", description: "System prompt text to append via --append-system-prompt" },
      dangerouslySkipPermissions: { type: "boolean",
                          description: "Skip all permission checks. Requires acknowledgment of risks. Default: false" },
    },
    required: ["prompt"]
  }
}
```

**Returns:** `{ sessionId: string, status: "running" }`

**Behavior:**
- Spawns a new `claude -p` process with `--output-format stream-json --input-format stream-json --verbose --include-partial-messages`
- Captures the `session_id` from the `init` event
- Returns immediately (session runs asynchronously)
- Only passes optional flags when explicitly provided; omitted = use CLI defaults
- When `permissionMode: "plan"`, Claude enters read-only analysis mode and produces a plan via `ExitPlanMode`

### 2. `claude_send_message`

Send a message to an existing session. Handles both active sessions (process alive) and inactive sessions (auto-resumes).

```typescript
{
  name: "claude_send_message",
  description: "Send a message to a Claude Code session. Automatically resumes the session if it has ended.",
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
- If process has exited (completed, interrupted, error): spawns a new process with `--resume <sessionId>` and the message as prompt, preserving the original session config (model, permission mode, etc.)
- If the session ID is unknown to our server (e.g., a user-created interactive session): creates a new tracked session and spawns with `--resume`
- This single tool replaces separate "resume" and "send message" tools

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
  status: "running" | "waiting_for_input" | "completed" | "error" | "interrupted",
  result?: string,              // Final result text if completed
  recentOutput: string[],       // Recent text output events
  pendingInputs: Array<{        // Pending permission/plan/question requests
    inputId: string,
    type: "permission" | "plan_review" | "user_question",
    toolName: string,           // e.g. "Edit", "Bash", "ExitPlanMode", "AskUserQuestion"
    toolInput: object,          // The tool's input parameters
    description: string,        // Human-readable summary
  }>,
  toolUseEvents: Array<{       // Tools that have been used
    toolName: string,
    status: "running" | "completed" | "denied",
  }>,
  costUsd?: number,             // Current cost if available
  turnCount?: number,           // Number of agentic turns so far
}
```

**Note on `pendingInputs`:** This unified list includes three types of requests that all flow through the `--permission-prompt-tool` mechanism:
- **`permission`**: Standard tool approval (Edit, Bash, etc.)
- **`plan_review`**: An `ExitPlanMode` call -- Claude has finished planning and is presenting the plan for review
- **`user_question`**: An `AskUserQuestion` call -- Claude is asking for clarification (may include multiple-choice options)

### 4. `claude_respond`

Respond to a pending permission request, plan review, or user question. Replaces separate approve/deny tools.

```typescript
{
  name: "claude_respond",
  description: "Respond to a pending request in a Claude Code session (permission approval, plan review, or question answer)",
  inputSchema: {
    type: "object",
    properties: {
      sessionId:     { type: "string", description: "The session ID" },
      inputId:       { type: "string", description: "The pending input request ID (from get_status pendingInputs)" },
      decision:      { type: "string", enum: ["allow", "deny"],
                       description: "Whether to allow or deny the request" },
      reason:        { type: "string", description: "Reason for the decision (shown to Claude on deny)" },
      updatedInput:  { type: "object", description: "Modified tool input (e.g., sanitized command). Used with 'allow'." },
    },
    required: ["sessionId", "inputId", "decision"]
  }
}
```

**Returns:** `{ sessionId: string, status: "running" | "waiting_for_input" }`

**Behavior for different request types:**

- **Permission request (`type: "permission"`):**
  - `allow` → `{ behavior: "allow", updatedInput }` sent to Claude Code
  - `deny` → `{ behavior: "deny", message: reason }` sent to Claude Code

- **Plan review (`type: "plan_review"`, toolName: `"ExitPlanMode"`):**
  - `allow` → approves the plan, Claude exits plan mode and begins execution
  - `deny` → rejects with `reason` as feedback, Claude revises the plan

- **User question (`type: "user_question"`, toolName: `"AskUserQuestion"`):**
  - `allow` with `updatedInput` containing answers → Claude receives the answers
  - `deny` → Claude proceeds without answers (best-effort)

### 5. `claude_interrupt`

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
- Process should emit a result event with `status: "interrupted"` before exiting
- Session can be resumed later with `claude_send_message`

### 6. `claude_list_sessions`

List all Claude Code sessions from the global session history. Lists sessions from any directory, including user-created interactive sessions.

```typescript
{
  name: "claude_list_sessions",
  description: "List all Claude Code sessions across all projects. Includes both programmatic and interactive user-created sessions.",
  inputSchema: {
    type: "object",
    properties: {
      projectDirectory: { type: "string", description: "Filter sessions by project directory path. If omitted, lists all sessions." },
      limit:            { type: "number", description: "Maximum number of sessions to return (default: 50, most recent first)" },
    },
  }
}
```

**Returns:**
```typescript
{
  sessions: Array<{
    sessionId: string,
    projectDirectory: string,  // Working directory where the session was created
    displayText: string,       // Summary/topic of the conversation
    timestamp: string,         // ISO timestamp
    isActive: boolean,         // Whether this server currently has an active process for this session
    activeStatus?: "running" | "waiting_for_input" | "completed" | "error" | "interrupted",
  }>
}
```

**Behavior:**
- Reads `~/.claude/history.jsonl` and parses entries
- Each line contains: `{ timestamp, project, display, session_id?, ... }`
- Optionally filters by `projectDirectory`
- Sorts by timestamp descending (most recent first)
- Annotates entries with `isActive: true` if our server currently has an active process for that session
- Any returned session can be resumed via `claude_send_message` with its `sessionId`, even if it was created interactively by the user

---

## Planning Mode Support

Claude Code's plan mode (`--permission-mode plan`) restricts Claude to read-only tools and produces a plan via `ExitPlanMode`. This integrates naturally with our architecture because both `ExitPlanMode` and `AskUserQuestion` go through the `--permission-prompt-tool` mechanism.

### How It Works

1. Client creates a session with `permissionMode: "plan"`:
   ```
   claude_create_session({ prompt: "Analyze the auth module and propose a refactoring plan", permissionMode: "plan" })
   ```

2. Claude reads code, analyzes the codebase (using only read-only tools like Read, Grep, Glob).

3. Claude may call `AskUserQuestion` for clarification. This arrives as a `pendingInput` with `type: "user_question"`. The `toolInput` contains a `questions` array:
   ```json
   {
     "inputId": "q-123",
     "type": "user_question",
     "toolName": "AskUserQuestion",
     "toolInput": {
       "questions": [
         { "question": "Which auth provider should I target?", "options": ["OAuth2", "SAML", "Both"] }
       ]
     }
   }
   ```
   Client responds via `claude_respond`:
   ```
   claude_respond({ sessionId, inputId: "q-123", decision: "allow", updatedInput: { questions: [...], answers: ["OAuth2"] } })
   ```

4. Claude writes the plan and calls `ExitPlanMode`. This arrives as a `pendingInput` with `type: "plan_review"`:
   ```json
   {
     "inputId": "plan-456",
     "type": "plan_review",
     "toolName": "ExitPlanMode",
     "toolInput": { "plan": "..." },
     "description": "Claude has completed a plan and is requesting approval to proceed with implementation"
   }
   ```

5. Client reviews the plan (visible in `toolInput`) and responds:
   - `claude_respond({ ..., decision: "allow" })` → Claude exits plan mode, switches to execution mode, implements the plan
   - `claude_respond({ ..., decision: "deny", reason: "Also consider the session management module" })` → Claude revises the plan

### Permission Mode Transitions

When a plan is approved, Claude Code internally transitions from `plan` mode to `acceptEdits` (or whichever mode is appropriate for execution). Our MCP server doesn't need to manage this transition -- the CLI handles it.

---

## Core Modules

### Module 1: `mcp-server.ts` -- MCP Server Setup

Responsibilities:
- Initialize the MCP server with STDIO transport
- Register all 6 tools
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
- Auto-resume on `send_message` to inactive sessions
- List all global sessions by parsing `~/.claude/history.jsonl`

```typescript
interface Session {
  id: string;
  status: SessionStatus;
  process: ChildProcess | null;
  createdAt: Date;
  workingDirectory: string;
  config: SessionConfig;       // Original config for re-spawning on resume

  // Event buffer (ring buffer of recent events)
  eventBuffer: StreamEvent[];

  // Pending inputs (permissions, plan reviews, questions)
  pendingInputs: Map<string, PendingInput>;

  // Final result
  result?: string;
  error?: string;

  // Metrics
  costUsd?: number;
  turnCount?: number;
}

type SessionStatus =
  | "running"
  | "waiting_for_input"
  | "completed"
  | "error"
  | "interrupted";

interface PendingInput {
  inputId: string;
  type: "permission" | "plan_review" | "user_question";
  toolName: string;
  toolInput: Record<string, unknown>;
  description: string;
  resolve: (response: PermissionResponse) => void;  // Resolves the HTTP callback
}
```

### Module 3: `process-manager.ts` -- Claude Code CLI Process

Responsibilities:
- Spawn Claude Code CLI with correct flags
- Parse NDJSON output stream into typed events
- Send NDJSON messages via stdin
- Handle process lifecycle (spawn, signal, exit)
- Generate `--mcp-config` for the internal permission server
- Always pass `--include-partial-messages` for streaming output

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
  interrupt(): void;
  kill(): void;
}

interface SpawnConfig {
  prompt: string;
  workingDirectory?: string;
  resumeSessionId?: string;

  // All optional -- only passed to CLI when explicitly set
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  dangerouslySkipPermissions?: boolean;

  // Internal
  permissionCallbackPort: number;
}
```

### Module 4: `stream-parser.ts` -- NDJSON Stream Parser

Responsibilities:
- Transform raw stdout bytes into parsed JSON objects
- Type-discriminate events (init, stream_event, result, etc.)
- Handle malformed lines gracefully (log to stderr, skip)
- Handle unknown event types defensively (don't crash)
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

// Unknown events are captured but not parsed strictly
interface UnknownEvent {
  type: string;
  [key: string]: unknown;
}
```

### Module 5: `permission-manager.ts` -- Permission & Input Handling

Responsibilities:
- Receive requests from the internal HTTP callback server
- Classify requests: permission, plan review (`ExitPlanMode`), or user question (`AskUserQuestion`)
- Attempt MCP elicitation if client supports it
- Fall back to queueing if elicitation unavailable
- Resolve pending inputs when `claude_respond` is called
- Timeout handling for stale requests

```typescript
interface PermissionManager {
  // Called when Claude Code requests any tool approval
  handleRequest(
    sessionId: string,
    request: ToolApprovalRequest
  ): Promise<PermissionResponse>;

  // Called when MCP client responds via claude_respond tool
  respond(sessionId: string, inputId: string, decision: "allow" | "deny",
          reason?: string, updatedInput?: object): void;

  // Check for pending inputs
  getPendingInputs(sessionId: string): PendingInput[];
}

interface ToolApprovalRequest {
  toolUseId: string;    // used as inputId
  toolName: string;     // "Edit", "Bash", "ExitPlanMode", "AskUserQuestion", etc.
  toolInput: Record<string, unknown>;
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
- Block until the input is resolved (by elicitation or by `claude_respond`)
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

This handles ALL types of tool approval requests uniformly: regular permissions, `ExitPlanMode`, and `AskUserQuestion`. The classification into `permission`/`plan_review`/`user_question` happens in our permission manager based on `tool_name`.

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
    │  { waiting_for_input,    │                            │                        │
    │    pendingInputs: [      │                            │                        │
    │      { type: permission, │                            │                        │
    │        Edit src/auth.ts }│                            │                        │
    │    ] }                   │                            │                        │
    │◄─────────────────────────│                            │                        │
    │                          │                            │                        │
    │  call claude_respond     │                            │                        │
    │  { decision: "allow" }   │                            │                        │
    │─────────────────────────►│                            │                        │
    │                          │  HTTP 200 { allow }        │                        │
    │                          │───────────────────────────────────────────────────►│
    │                          │                            │◄─────────────────────│
    │                          │                            │  { allow }            │
    │  { status: "running" }   │                            │                        │
    │◄─────────────────────────│                            │                        │
```

### Flow C: Plan Mode (ExitPlanMode)

```
MCP Client                Our MCP Server              Claude Code CLI          Perm Handler MCP
    │                          │                            │                        │
    │  create_session          │                            │                        │
    │  permissionMode: "plan"  │                            │                        │
    │─────────────────────────►│  spawn claude -p           │                        │
    │                          │  --permission-mode plan    │                        │
    │                          │───────────────────────────►│                        │
    │                          │                            │                        │
    │                          │                            │ reads code, analyzes   │
    │                          │                            │ writes plan            │
    │                          │                            │                        │
    │                          │                            │ calls ExitPlanMode     │
    │                          │                            │──────────────────────►│
    │                          │  HTTP POST /permission     │                        │
    │                          │  tool_name: ExitPlanMode   │                        │
    │                          │◄───────────────────────────────────────────────────│
    │                          │                            │                        │
    │  get_status              │                            │                        │
    │─────────────────────────►│                            │                        │
    │  { pendingInputs: [      │                            │                        │
    │    { type: plan_review,  │                            │                        │
    │      toolInput: {plan}}  │                            │                        │
    │  ]}                      │                            │                        │
    │◄─────────────────────────│                            │                        │
    │                          │                            │                        │
    │  claude_respond          │                            │                        │
    │  { decision: "allow" }   │                            │                        │
    │─────────────────────────►│  HTTP 200 { allow }        │                        │
    │                          │───────────────────────────────────────────────────►│
    │                          │                            │◄─────────────────────│
    │                          │                            │                        │
    │                          │                            │ exits plan mode        │
    │                          │                            │ begins implementation  │
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
        │    tool needs  │          claude_respond      │
        │    approval    │                             │
        │                ▼                             │
        │   ┌────────────────────────┐                 │
        │   │  WAITING_FOR_INPUT     │─────────────────┘
        │   │  (permission, plan     │
        │   │   review, or question) │
        │   └────────────────────────┘
        │
        │  interrupt
        │  (SIGINT)
        │                ┌──────────────┐   send_message
        ├───────────────►│  INTERRUPTED  │──────────────────►  RUNNING
        │                └──────────────┘   (auto-resume)
        │
        │  process exits
        │  successfully
        │                ┌──────────────┐   send_message
        ├───────────────►│  COMPLETED    │──────────────────►  RUNNING
        │                └──────────────┘   (auto-resume)
        │
        │  process crashes
        │  or error
        │                ┌──────────────┐   send_message
        └───────────────►│  ERROR        │──────────────────►  RUNNING
                         └──────────────┘   (auto-resume)
```

Any terminal state (INTERRUPTED, COMPLETED, ERROR) can transition back to RUNNING via `claude_send_message`, which automatically spawns a new process with `--resume`.

### Session Discovery & Reconnection

Our MCP server does NOT maintain its own session index. Instead:

1. **`claude_list_sessions`** reads `~/.claude/history.jsonl` directly. This file is maintained by Claude Code itself and contains all sessions from all directories, whether created interactively or programmatically.

2. **Any session can be resumed** via `claude_send_message(sessionId, message)`. If we don't have an active process for that session, we spawn `claude -p --resume <sessionId>`. This works for:
   - Sessions we created earlier in this server lifetime
   - Sessions from a previous server lifetime
   - Interactive sessions the user created in the terminal

3. **Server restart** loses only the in-memory process handles. All session data survives in Claude Code's own persistence. Clients just need to call `claude_send_message` with the session ID.

---

## Process Management Detail

### Spawning a Claude Code Process

```typescript
const args = [
  "-p", prompt,
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
if (config.allowedTools?.length) {
  args.push("--allowedTools", ...config.allowedTools);
}
if (config.disallowedTools?.length) {
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
}

const child = spawn(cliPath, args, {
  cwd: config.workingDirectory || process.cwd(),
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
│   ├── permission-manager.ts            # Permission/input handling (elicitation + queue)
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
- Accepts the same flags as real Claude Code (`-p`, `--output-format`, `--input-format`, `--resume`, `--permission-mode`, etc.)
- Emits `init` event with a session ID
- Emits `stream_event` events with configurable text content (including partial messages)
- Emits `result` event on completion
- Supports permission requests (calls permission-prompt-tool MCP server)
- Supports plan mode (emits ExitPlanMode request)
- Supports AskUserQuestion
- Responds to SIGINT by emitting interrupted result
- Can simulate delays, errors, and multi-turn conversations
- Behavior controlled via environment variables or a config file

```typescript
// Example: mock-claude-cli.ts
// MOCK_BEHAVIOR=success|error|permission_request|plan_mode|ask_question|slow|hang
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
- Handles unknown event types without crashing

**`session-manager.test.ts`**
- Creates sessions with correct initial state
- State transitions (running → waiting_for_input → running → completed)
- Tracks multiple concurrent sessions
- Handles session not found -- creates on-the-fly for unknown IDs (for resuming user sessions)
- Cleans up sessions on process exit
- send_message auto-resumes with correct flags
- Lists sessions by parsing history.jsonl

**`permission-manager.test.ts`**
- Queues requests when elicitation unavailable
- Resolves pending inputs on `claude_respond`
- Classifies tool requests: permission vs plan_review vs user_question
- Attempts elicitation when client supports it
- Times out stale requests
- Handles concurrent requests for same session
- Plan review flow (ExitPlanMode allow/deny)
- AskUserQuestion flow (answers in updatedInput)

### 3. Integration Tests

**`process-manager.test.ts`**
- Spawns mock CLI, captures init event and session ID
- Sends messages via stdin, receives responses
- Streams partial messages via --include-partial-messages
- Interrupt via SIGINT produces interrupted status
- Handles process crash (non-zero exit)
- Handles process hang (timeout)
- Permission flow via internal HTTP callback
- Plan mode flow via ExitPlanMode
- Verifies only explicitly-set flags are passed to CLI

**`mcp-server.test.ts`**
- Tests each tool handler with mock session manager
- Validates input schema enforcement
- Tests error responses for invalid session IDs
- Tests elicitation flow with mock MCP client
- Tests plan mode end-to-end through MCP tools

### 4. End-to-End Tests (`e2e.test.ts`)

Gated behind `CLAUDE_CODE_E2E=true` environment variable. Requires real Claude Code CLI installed and `ANTHROPIC_API_KEY` set.

- Creates a real session with a simple prompt
- Checks status until completion
- Sends a follow-up message (auto-resumes completed session)
- Interrupts a running session
- Permission approval flow
- Lists sessions and verifies created session appears

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
- [ ] Verify `--include-partial-messages` streaming

### Phase 3: Session Management
- [ ] Implement `session-manager.ts` (lifecycle, state machine, event buffer)
- [ ] Implement `claude_list_sessions` (parse `~/.claude/history.jsonl`)
- [ ] Write `session-manager.test.ts`
- [ ] Implement auto-resume logic in send_message

### Phase 4: Permission & Input Handling
- [ ] Implement `permission-callback-server.ts` (internal HTTP server)
- [ ] Implement `permission-handler-mcp.ts` (standalone script)
- [ ] Implement `permission-manager.ts` (elicitation + queue + request classification)
- [ ] Handle ExitPlanMode and AskUserQuestion as input types
- [ ] Write `permission-manager.test.ts`

### Phase 5: MCP Server & Tools
- [ ] Implement `mcp-server.ts` with all 6 tools
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
| `PERMISSION_TIMEOUT_MS` | `300000` (5 min) | Timeout for pending permission/input requests |
| `MAX_SESSIONS` | `10` | Maximum concurrent active sessions (processes) |
| `LOG_LEVEL` | `"info"` | Logging level (debug, info, warn, error) |
| `EVENT_BUFFER_SIZE` | `500` | Number of events to retain per session |

---

## Open Questions & Risks

### Known Issues to Watch

1. **`--input-format stream-json` multi-turn reliability**: There are reported issues with hanging after the second message (GitHub #3187, marked resolved) and duplicate session log entries (#5034, cosmetic only). Need to verify these are fully resolved in current CLI versions.

2. **`--permission-prompt-tool` event emission**: A bug was reported (SDK issue #469) where `control_request` events were not emitted in some CLI versions. Our architecture using a separate MCP server for permissions (rather than inline control_request/control_response) should be more robust.

3. **SIGINT behavior on Windows**: `subprocess.kill('SIGINT')` on Windows causes immediate forceful termination. May need IPC-based interrupt signaling for Windows support.

4. **`history.jsonl` format stability**: We parse `~/.claude/history.jsonl` to list sessions. This file's format is not officially documented as a public API and could change between CLI versions. We should parse defensively and handle missing fields gracefully.

5. **`ExitPlanMode` via `--permission-prompt-tool`**: Need to verify that `ExitPlanMode` actually routes through the permission-prompt-tool mechanism in non-interactive mode. The docs indicate it goes through `canUseTool` in the SDK, but the CLI behavior may differ.

### Design Alternatives Considered

1. **Agent SDK instead of CLI**: Using `@anthropic-ai/claude-agent-sdk` directly would give cleaner hooks and streaming, but the user specifically requested CLI wrapping, and the CLI approach keeps the MCP server independent of API key management.

2. **PTY-based interactive session**: Using `node-pty` to run Claude Code interactively was considered but rejected. Parsing ANSI terminal output is fragile, stdout/stderr are merged in PTY, and `stream-json` provides structured data natively.

3. **Inline `control_request`/`control_response`**: Using `--permission-prompt-tool stdio` for inline permission handling through the same stdin/stdout channel was considered. While simpler (no HTTP server needed), it has known reliability issues and mixes permission protocol with the streaming output protocol.

4. **Separate approve/deny tools**: Rejected in favor of a single `claude_respond` tool with a `decision` field. Reduces tool count and naturally extends to plan reviews and question answers.

5. **Separate resume/send_message tools**: Rejected in favor of a single `claude_send_message` that auto-resumes when needed. Simpler client experience -- clients don't need to track whether a session is active.

### Future Enhancements

- **Cost tracking**: Aggregate and report cost across sessions.
- **Tool filtering UI**: Let MCP clients configure allowed/denied tools through a resource or prompt.
- **Session forking**: Use `--fork-session` to branch sessions for experimentation.
- **MCP Resources**: Expose session output as MCP resources for richer client integration.

---

## Appendix: Lessons from Existing CLI Wrappers

Analysis of two existing Claude Code wrapper projects informed several design decisions.

### From `RichardAtCT/claude-code-openai-wrapper` (Python, Agent SDK)

This project wraps Claude Code behind an OpenAI-compatible REST API using the Python Agent SDK (not CLI subprocess). Despite the different approach, several lessons apply directly:

1. **`permissionMode: "bypassPermissions"` is essential for headless operation.** Without it, the SDK/CLI tries to interactively prompt for approval, which hangs in a server context. This was their biggest bug -- tools appeared "enabled" but never executed because the SDK was silently waiting for interactive approval. Our `--permission-prompt-tool` approach solves this differently (we route approvals programmatically rather than bypassing them), but we must ensure Claude Code never falls back to interactive prompting.

2. **SDK/CLI message format instability across versions.** Their code is littered with dual-format handling (`hasattr(block, "text")` vs `isinstance(block, dict)`) because the Agent SDK changed its return types between versions. Our stream-json parser should be defensive about message shapes and handle unknown event types gracefully rather than crashing.

3. **System prompt must be structured.** The SDK requires `{"type": "text", "text": "..."}` (or `{"type": "preset", "preset": "claude_code"}`), not plain strings. Verify whether the CLI's `--append-system-prompt` flag handles this automatically or if we need structured formatting.

4. **`max_turns=1` when tools are disabled prevents wasted loops.** If a session is configured without tools, setting `--max-turns 1` avoids multi-turn reasoning loops where Claude tries to use tools that don't exist.

5. **Session management can be in-memory with TTL.** Their sessions use a 1-hour TTL with a background cleanup task every 5 minutes. Since Claude Code persists sessions to disk (`.claude/`), our in-memory session tracking can be lightweight -- we just need enough state to manage the process lifecycle. If a session expires from our tracker, the client can always resume it via `claude_send_message` with the session ID.

6. **Token/cost estimation is approximate.** The SDK doesn't always provide exact token counts. When not available, they use a rough `len(text) / 4` heuristic. We should extract `cost_usd` from the `result` event when available but not depend on it.

7. **Factory pattern for mock/real implementations aids testing.** When `node-pty` is not available (e.g., in CI), they fall back to a mock implementation. We should use dependency injection for the process manager to enable the same pattern with our mock CLI.

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
| Ring buffer for event storage | Both projects use bounded output buffers |
| Factory/DI pattern for testability | `claude-cli-lib` uses factory for mock/real implementations |
