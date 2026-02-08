# Codex MCP Server - Implementation Plan

## Overview

An MCP (Model Context Protocol) server that wraps the OpenAI Codex CLI, exposing it as a set of tools over STDIO transport. This enables any MCP client (Claude Desktop, other AI agents, custom tooling) to programmatically operate Codex sessions -- starting coding tasks, monitoring progress, sending follow-ups, managing approvals, and interrupting execution.

### Why Not Use the Built-in `codex mcp-server`?

Codex ships with `codex mcp-server`, which exposes two tools (`codex` and `codex-reply`). Our wrapper adds significant value:

1. **Rich status polling**: Event history with ring buffer, item tracking, usage stats -- clients can poll at their own pace
2. **Session interrupt**: Ability to stop a running session (the built-in server has no interrupt mechanism)
3. **Session discovery**: List and resume sessions across all projects, including user-created interactive sessions
4. **Granular configuration**: Per-session control over approval policy, sandbox mode, model, and config overrides
5. **Unified connector pattern**: Consistent interface with our Claude Code MCP wrapper, enabling agents to orchestrate multiple coding tools uniformly

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
│  Codex MCP Server  (@localrouter/codex)                         │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ MCP Server   │  │ Session      │  │ Approval               │ │
│  │ (tools,      │  │ Manager      │  │ Manager                │ │
│  │  elicitation)│  │              │  │ (elicitation + queue)  │ │
│  └──────┬───┬──┘  └──────┬───────┘  └───────────┬────────────┘ │
│         │   │            │                       │              │
│         │   │     ┌──────┴───────┐               │              │
│         │   │     │ Process      ├───────────────┘              │
│         │   │     │ Manager      │                              │
│         │   │     └──────┬───────┘                              │
│         │   │            │                                      │
└─────────┼───┼────────────┼──────────────────────────────────────┘
          │   │            │
          │   │    spawn   │  For each session turn:
          │   │            ▼
          │   │  ┌─────────────────────────────────────────────┐
          │   │  │  codex exec --json "<prompt>"               │
          │   │  │    --ask-for-approval <policy>               │
          │   │  │    --sandbox <mode>                          │
          │   │  │    --model <model>                           │
          │   │  │                                              │
          │   │  │  stdout ──► JSONL events (thread, turn,      │
          │   │  │             item lifecycle)                   │
          │   │  │  stderr ──► Progress/debug output            │
          │   │  └──────────────────────────────────────────────┘
          │   │
          │   │  For follow-ups (after turn completes):
          │   │  ┌─────────────────────────────────────────────┐
          │   │  │  codex exec resume <session_id> --json      │
          │   │  │    "<follow-up message>"                     │
          │   │  └─────────────────────────────────────────────┘
          │   │
          │   └── MCP Elicitation (if client supports it)
          │        - Forwards approval prompts to human
          │        - Returns approve/deny response
          │
          └── Tool Results (JSON-RPC responses)
```

### Key Design Decisions

1. **`codex exec --json` as the primary interface**: The `--json` flag gives us structured JSONL events for every lifecycle event (thread, turn, item). This is richer than the built-in `codex mcp-server` output and gives us full control over session management.

2. **One process per turn, not a persistent process**: Unlike Claude Code which supports bidirectional stdin/stdout streaming within a single long-lived process, Codex's `exec` mode is fire-and-forget. Each turn is a separate `codex exec` invocation. Follow-ups use `codex exec resume <sessionId>`. This is simpler but means we spawn a new process for each message.

3. **Approval policy as a session parameter**: Codex uses `--ask-for-approval` (untrusted, on-failure, on-request, never) and `--sandbox` (read-only, workspace-write, danger-full-access) flags. These are set at session creation and applied to each `codex exec` invocation. No complex internal permission routing is needed -- this is a significant simplification compared to Claude Code MCP.

4. **Interactive approval support via process I/O**: When `codex exec` encounters an action requiring approval (based on the approval policy), it blocks and writes an approval request to stderr. Our approval manager reads these, surfaces them as `pendingQuestion` entries (identical model to Claude Code MCP), and either forwards via MCP elicitation or queues for `codex_respond`. The response is written to the process's stdin.

5. **CLI defaults respected**: Optional parameters like `model`, `approvalPolicy`, `sandbox` are not set unless explicitly provided -- Codex CLI's own configuration (from `~/.codex/config.toml`, profiles, etc.) takes precedence.

6. **No session storage of our own**: Session persistence is Codex's responsibility (`$CODEX_HOME/sessions/`). Our MCP server only tracks in-memory state for active process handles. `codex_list` reads directly from the session directory. Any session can be resumed.

7. **Unified question/answer model**: Approval requests from Codex are surfaced as "questions with options" in `codex_status`. The client responds using a single `codex_respond` tool with selected answers. This is identical to the Claude Code MCP pattern, providing a consistent interface across connectors.

---

## MCP Tools

Six tools total, mirroring the Claude Code MCP pattern. Tools use CLI defaults for all optional parameters.

### 1. `codex_start`

Start a new Codex session with an initial prompt.

```typescript
{
  name: "codex_start",
  description: "Start a new Codex CLI session with an initial prompt",
  inputSchema: {
    type: "object",
    properties: {
      prompt:           { type: "string", description: "The initial task/prompt for Codex" },
      workingDirectory: { type: "string", description: "Working directory for the session (must be a git repo unless skipGitRepoCheck is true)" },

      // All optional -- CLI defaults apply when omitted
      model:            { type: "string", description: "Model override (e.g. 'gpt-5-codex', 'gpt-5.3-codex', 'o3', 'o4-mini')" },
      approvalPolicy:   { type: "string", enum: ["untrusted", "on-failure", "on-request", "never"],
                          description: "When to pause for human approval. 'never' auto-approves all. Default: CLI's configured policy" },
      sandbox:          { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"],
                          description: "Sandbox policy for model-generated commands. Default: CLI's configured sandbox" },
      fullAuto:         { type: "boolean",
                          description: "Shortcut for on-request approvals + workspace-write sandbox. Default: false" },
      profile:          { type: "string", description: "Configuration profile from config.toml" },
      config:           { type: "object", additionalProperties: { type: "string" },
                          description: "Inline configuration overrides (key-value pairs, passed as -c flags)" },
      baseInstructions: { type: "string", description: "Custom instruction set override" },
      images:           { type: "array", items: { type: "string" },
                          description: "Paths to image files to attach to the prompt" },
      skipGitRepoCheck: { type: "boolean",
                          description: "Allow running outside a git repository. Default: false" },
      dangerouslyBypassApprovalsAndSandbox: { type: "boolean",
                          description: "Skip all approvals and sandboxing (--yolo). Only use in isolated environments. Default: false" },
    },
    required: ["prompt"]
  }
}
```

**Returns:** `{ sessionId: string, status: "active" }`

**Behavior:**
- Spawns a new `codex exec --json` process with the provided prompt and flags
- Captures the `threadId` from the `thread.started` event (this becomes our `sessionId`)
- Returns immediately (session runs asynchronously)
- Only passes optional flags when explicitly provided; omitted = use CLI defaults

### 2. `codex_say`

Send a follow-up message to an existing session. Handles both active sessions (process running on a turn) and inactive sessions (turn completed, auto-resumes).

```typescript
{
  name: "codex_say",
  description: "Send a follow-up message to a Codex session. Automatically resumes the session if the previous turn has ended.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId:      { type: "string", description: "The session ID (thread ID)" },
      message:        { type: "string", description: "The follow-up message to send" },
      images:         { type: "array", items: { type: "string" },
                        description: "Paths to image files to attach" },
    },
    required: ["sessionId", "message"]
  }
}
```

**Returns:** `{ sessionId: string, status: "active" }`

**Behavior:**
- **Process not running (turn completed, interrupted, or error):** spawns a new process with `codex exec resume <sessionId> --json "<message>"`, preserving original session config (approval policy, sandbox, etc.)
- **Process still running:** returns an error indicating the session is busy -- the client should wait for the current turn to complete or use `codex_interrupt` first
- **Session ID unknown:** creates a new tracked session and spawns with `codex exec resume <sessionId>`, discovering the session from Codex's own storage

### 3. `codex_status`

Check the current status of a session and retrieve output.

```typescript
{
  name: "codex_status",
  description: "Get the current status and recent output of a Codex session",
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
  status: "active" | "awaiting_approval" | "done" | "error" | "interrupted",
  result?: string,              // Final agent message when status is "done"
  recentOutput: string[],       // Recent text output from agent messages

  // Present when status is "awaiting_approval"
  pendingQuestion?: {
    id: string,
    type: "command_approval" | "patch_approval",
    questions: Array<{
      question: string,       // Human-readable description of what needs approval
      options: string[],      // Available answers (e.g. ["approve", "deny"])
    }>,
  },

  itemEvents: Array<{          // Items processed so far in current turn
    itemType: string,          // "agent_message" | "command_execution" | "file_change" | "mcp_tool_call" | "web_search" | "todo_list"
    status: "started" | "in_progress" | "completed" | "failed",
    summary?: string,          // Brief description (command text, file path, etc.)
  }>,

  usage?: {
    inputTokens?: number,
    cachedInputTokens?: number,
    outputTokens?: number,
  },
  turnCount?: number,
}
```

**How `pendingQuestion` is populated:**

**Command approval** (Codex wants to execute a shell command):
```json
{
  "id": "approval_abc123",
  "type": "command_approval",
  "questions": [
    { "question": "Codex wants to execute: npm test", "options": ["approve", "deny"] }
  ]
}
```

**Patch approval** (Codex wants to apply file changes):
```json
{
  "id": "approval_def456",
  "type": "patch_approval",
  "questions": [
    { "question": "Codex wants to modify src/auth.ts:\n\n+import { OAuth2 } from './oauth';\n...", "options": ["approve", "deny"] }
  ]
}
```

### 4. `codex_respond`

Respond to a pending approval request. Works identically for command approvals and patch approvals -- just pick the answer from the provided options.

Answers can include a reason after a colon (e.g. `"deny: this command is destructive"`). The part before the colon is matched against the options; the part after is passed as feedback.

```typescript
{
  name: "codex_respond",
  description: "Respond to a pending approval in a Codex session. Provide one answer per question, selected from the options shown in codex_status. Answers can include a reason after a colon (e.g. 'deny: too risky').",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "The session ID" },
      id:        { type: "string", description: "The approval ID from pendingQuestion.id in codex_status" },
      answers:   { type: "array", items: { type: "string" },
                   description: "One answer per question. Use option value directly (e.g. 'approve') or with reason (e.g. 'deny: too dangerous')" },
    },
    required: ["sessionId", "id", "answers"]
  }
}
```

**Returns:** `{ sessionId: string, status: "active" | "awaiting_approval" }`

**Examples:**
```
// Approve a command
codex_respond({ sessionId: "...", id: "approval_abc123", answers: ["approve"] })

// Deny a command with reason
codex_respond({ sessionId: "...", id: "approval_abc123", answers: ["deny: this modifies production config"] })
```

**Answer parsing:** Each answer is split on the first `:` to extract the decision and optional reason:
```typescript
function parseAnswer(answer: string): { decision: string; reason?: string } {
  const colonIndex = answer.indexOf(":");
  if (colonIndex === -1) return { decision: answer.trim() };
  return {
    decision: answer.slice(0, colonIndex).trim(),
    reason: answer.slice(colonIndex + 1).trim(),
  };
}
```

### 5. `codex_interrupt`

Interrupt a running session.

```typescript
{
  name: "codex_interrupt",
  description: "Interrupt a running Codex session",
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
- Sends `SIGINT` to the Codex exec process
- Process should emit remaining events and exit
- Session can be resumed later with `codex_say`

### 6. `codex_list`

List all Codex sessions from the session history. Lists sessions from any directory, including user-created interactive sessions.

```typescript
{
  name: "codex_list",
  description: "List all Codex sessions across all projects. Includes both programmatic and interactive user-created sessions.",
  inputSchema: {
    type: "object",
    properties: {
      workingDirectory: { type: "string", description: "Filter to sessions created in this directory. If omitted, lists all sessions." },
      limit:            { type: "number", description: "Maximum sessions to return (default: 50, most recent first)" },
    },
  }
}
```

**Returns:**
```typescript
{
  sessions: Array<{
    sessionId: string,
    directory?: string,         // Working directory where the session ran
    summary?: string,           // First prompt or topic
    timestamp: string,          // ISO timestamp
    isActive: boolean,          // Whether this server currently has an active process for this session
    activeStatus?: "active" | "awaiting_approval" | "done" | "error" | "interrupted",
  }>
}
```

**Behavior:**
- Scans `$CODEX_HOME/sessions/` directory tree for session JSONL files
- Parses session metadata from the `thread.started` events
- Sorts by timestamp descending (most recent first)
- Annotates entries with `isActive: true` if our server currently has an active process for that session
- Any listed session can be resumed via `codex_say` with its `sessionId`

---

## Session Lifecycle

### State Machine

```
                      codex_start
                           │
                           ▼
                    ┌──────────┐
        ┌──────────│  ACTIVE   │◄─────────────────────┐
        │          └─────┬─────┘                       │
        │                │                             │
        │   approval     │           codex_respond     │
        │   requested    │                             │
        │                ▼                             │
        │   ┌────────────────────────┐                 │
        │   │  AWAITING_APPROVAL     │─────────────────┘
        │   └────────────────────────┘
        │
        │  interrupt
        │  (SIGINT)
        │                ┌──────────────┐   codex_say
        ├───────────────►│  INTERRUPTED  │──────────────────►  ACTIVE
        │                └──────────────┘   (auto-resume)
        │
        │  turn completes
        │  successfully
        │                ┌──────────────┐   codex_say
        ├───────────────►│  DONE         │──────────────────►  ACTIVE
        │                └──────────────┘   (auto-resume)
        │
        │  process crashes
        │  or turn fails
        │                ┌──────────────┐   codex_say
        └───────────────►│  ERROR        │──────────────────►  ACTIVE
                         └──────────────┘   (auto-resume)
```

Any terminal state (INTERRUPTED, DONE, ERROR) can transition back to ACTIVE via `codex_say`, which spawns a new `codex exec resume` process.

**Key difference from Claude Code MCP:** In Claude Code MCP, the process stays alive across multiple messages (bidirectional stdin/stdout). In Codex MCP, each turn is a separate `codex exec` process. The "ACTIVE" state means a `codex exec` process is currently running. When it finishes (DONE), you send the next message via `codex_say` which spawns a new `codex exec resume` process.

### Session Discovery & Reconnection

Our MCP server does NOT maintain its own session index. Instead:

1. **`codex_list`** scans `$CODEX_HOME/sessions/` directly. This directory is maintained by Codex itself and contains JSONL session logs organized as `YYYY/MM/DD/rollout-*.jsonl`.

2. **Any session can be resumed** via `codex_say(sessionId, message)`. If we don't have an active process for that session, we spawn `codex exec resume <sessionId> --json`. This works for:
   - Sessions we created earlier in this server lifetime
   - Sessions from a previous server lifetime
   - Interactive sessions the user created in the terminal

3. **Server restart** loses only the in-memory process handles. All session data survives in Codex's own persistence. Clients just need to call `codex_say` with the session ID.

---

## Approval Flow Detail

### Flow A: Non-Interactive (approval policy handles everything)

When `approvalPolicy` is `"never"` (or `dangerouslyBypassApprovalsAndSandbox` is true), Codex auto-approves all actions. No approval flow is needed. This is the simplest mode.

```
MCP Client                Our MCP Server              Codex exec --json
    │                          │                            │
    │  call codex_start        │                            │
    │  approvalPolicy: "never" │                            │
    │─────────────────────────►│  spawn codex exec --json   │
    │                          │  --ask-for-approval never   │
    │                          │───────────────────────────►│
    │  { sessionId, active }   │                            │
    │◄─────────────────────────│                            │
    │                          │                            │
    │  call codex_status       │                            │
    │─────────────────────────►│  (reads from event buffer) │
    │  { status: "active",     │                            │
    │    itemEvents: [...] }   │                            │
    │◄─────────────────────────│                            │
    │                          │                            │
    │                          │  turn.completed            │
    │                          │◄───────────────────────────│
    │                          │                            │
    │  call codex_status       │                            │
    │─────────────────────────►│                            │
    │  { status: "done",       │                            │
    │    result: "..." }       │                            │
    │◄─────────────────────────│                            │
```

### Flow B: Interactive Approvals with Elicitation

When the approval policy requires human approval and the MCP client supports elicitation, approval requests are forwarded directly to the human.

```
MCP Client                Our MCP Server              Codex exec process
    │                          │                            │
    │                          │                            │ wants to run command
    │                          │  (approval request on      │
    │                          │   stderr / blocked stdout) │
    │                          │◄───────────────────────────│
    │                          │                            │
    │  elicitation/create      │                            │
    │  "Codex wants to run:    │                            │
    │   npm test"              │                            │
    │  options: approve/deny   │                            │
    │◄─────────────────────────│                            │
    │                          │                            │
    │  { action: "accept",     │                            │
    │    content: "approve" }  │                            │
    │─────────────────────────►│                            │
    │                          │  (writes approval to stdin)│
    │                          │───────────────────────────►│
    │                          │                            │
    │                          │                            │ proceeds with command
```

### Flow C: Interactive Approvals with Polling (no elicitation)

When the MCP client does NOT support elicitation, approvals are queued and exposed via `codex_status` / `codex_respond`.

```
MCP Client                Our MCP Server              Codex exec process
    │                          │                            │
    │                          │                            │ wants to run command
    │                          │  (approval request)        │
    │                          │◄───────────────────────────│
    │                          │  (queues, blocks process)  │
    │                          │                            │
    │  call codex_status       │                            │
    │─────────────────────────►│                            │
    │  { status:               │                            │
    │    awaiting_approval,    │                            │
    │    pendingQuestion: {    │                            │
    │      id: "approval_123", │                            │
    │      type: command_      │                            │
    │        approval,         │                            │
    │      questions: [{       │                            │
    │        question: "Run    │                            │
    │          npm test?",     │                            │
    │        options:          │                            │
    │          [approve,deny]  │                            │
    │      }]                  │                            │
    │    }                     │                            │
    │  }                       │                            │
    │◄─────────────────────────│                            │
    │                          │                            │
    │  call codex_respond      │                            │
    │  { answers: ["approve"]} │                            │
    │─────────────────────────►│  (writes approval to stdin)│
    │                          │───────────────────────────►│
    │                          │                            │
    │  { status: "active" }    │                            │
    │◄─────────────────────────│                            │
```

---

## Core Modules

### Module 1: `mcp-server.ts` -- MCP Server Setup

Responsibilities:
- Initialize the MCP server with STDIO transport
- Register all 6 tools (`codex_start`, `codex_say`, `codex_status`, `codex_respond`, `codex_interrupt`, `codex_list`)
- Detect client elicitation capability during initialization
- Route tool calls to the session manager
- Handle graceful shutdown

### Module 2: `session-manager.ts` -- Session Lifecycle

Responsibilities:
- Create, track, and clean up sessions
- Map session IDs to process handles and state
- Provide session state queries
- Handle session reconnection (process exited but session ID is valid)
- Auto-resume on `codex_say` to inactive sessions
- List all sessions by scanning `$CODEX_HOME/sessions/`

```typescript
interface Session {
  id: string;                     // Codex thread ID
  status: SessionStatus;
  process: ChildProcess | null;
  createdAt: Date;
  workingDirectory: string;
  config: SessionConfig;          // Original config for re-spawning on resume

  // Event buffer (ring buffer of recent events)
  eventBuffer: CodexEvent[];

  // Pending approval (at most one at a time since exec blocks)
  pendingQuestion: PendingQuestion | null;

  // Final result
  result?: string;
  error?: string;

  // Metrics (from turn.completed events)
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  };
  turnCount: number;
}

type SessionStatus =
  | "active"
  | "awaiting_approval"
  | "done"
  | "error"
  | "interrupted";

interface PendingQuestion {
  id: string;
  type: "command_approval" | "patch_approval";
  questions: Array<{
    question: string;
    options: string[];
  }>;
  resolve: (response: ApprovalResponse) => void;  // Resolves the blocked process
}
```

### Module 3: `process-manager.ts` -- Codex CLI Process

Responsibilities:
- Spawn Codex CLI with correct flags
- Parse JSONL output stream into typed events
- Handle process lifecycle (spawn, signal, exit)
- Read approval requests from process stderr/stdout
- Write approval responses to process stdin

```typescript
interface SpawnConfig {
  prompt: string;
  workingDirectory?: string;
  resumeSessionId?: string;

  // All optional -- only passed to CLI when explicitly set
  model?: string;
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  fullAuto?: boolean;
  profile?: string;
  config?: Record<string, string>;
  baseInstructions?: string;
  images?: string[];
  skipGitRepoCheck?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
}
```

### Module 4: `stream-parser.ts` -- JSONL Stream Parser

Responsibilities:
- Transform raw stdout bytes into parsed JSON objects
- Type-discriminate events (thread.started, turn.*, item.*, error)
- Handle malformed lines gracefully (log to stderr, skip)
- Handle unknown event types defensively (don't crash)

```typescript
// Top-level event types from codex exec --json
interface ThreadStartedEvent {
  type: "thread.started";
  thread_id: string;
}

interface TurnStartedEvent {
  type: "turn.started";
}

interface TurnCompletedEvent {
  type: "turn.completed";
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

interface TurnFailedEvent {
  type: "turn.failed";
  error?: string;
}

interface ItemStartedEvent {
  type: "item.started";
  item: {
    id: string;
    type: ItemType;
    [key: string]: unknown;
  };
}

interface ItemUpdatedEvent {
  type: "item.updated";
  item: {
    id: string;
    type: ItemType;
    [key: string]: unknown;
  };
}

interface ItemCompletedEvent {
  type: "item.completed";
  item: {
    id: string;
    type: ItemType;
    text?: string;              // For agent_message
    command?: string;           // For command_execution
    changes?: FileChange[];     // For file_change
    server?: string;            // For mcp_tool_call
    tool?: string;              // For mcp_tool_call
    status?: string;            // Item-level status
    [key: string]: unknown;
  };
}

interface StreamErrorEvent {
  type: "error";
  message: string;
}

type ItemType =
  | "agent_message"
  | "reasoning"
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "web_search"
  | "todo_list"
  | "error"
  | "unknown";

type CodexEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | StreamErrorEvent;
```

### Module 5: `approval-manager.ts` -- Approval Handling

Responsibilities:
- Detect approval requests from the Codex process (via stderr patterns or process blocking behavior)
- Build human-readable questions with options
- Attempt MCP elicitation if client supports it
- Fall back to queueing as `pendingQuestion` if elicitation unavailable
- Translate `codex_respond` answers back to the process stdin format
- Timeout handling for stale requests

```typescript
function classifyApproval(request: ApprovalRequest): "command_approval" | "patch_approval" {
  if (request.type === "exec" || request.type === "command") return "command_approval";
  if (request.type === "patch" || request.type === "file_change") return "patch_approval";
  return "command_approval"; // default
}

function buildQuestion(request: ApprovalRequest): PendingQuestion {
  switch (classifyApproval(request)) {
    case "command_approval":
      return {
        type: "command_approval",
        questions: [{
          question: `Codex wants to execute: ${request.command}`,
          options: ["approve", "deny"],
        }],
      };
    case "patch_approval":
      return {
        type: "patch_approval",
        questions: [{
          question: `Codex wants to modify files:\n\n${request.diff || request.description}`,
          options: ["approve", "deny"],
        }],
      };
  }
}
```

### Module 6: `types.ts` -- Shared Type Definitions

All shared interfaces, enums, and constants used across modules.

---

## Process Management Detail

### Spawning a New Session

```typescript
const args = ["exec", "--json"];

if (config.resumeSessionId) {
  args.splice(1, 0, "resume", config.resumeSessionId);
  // args = ["exec", "resume", "<sessionId>", "--json"]
}

// Only pass optional flags when explicitly set (otherwise CLI defaults apply)
if (config.model !== undefined) {
  args.push("--model", config.model);
}
if (config.approvalPolicy !== undefined) {
  args.push("--ask-for-approval", config.approvalPolicy);
}
if (config.sandbox !== undefined) {
  args.push("--sandbox", config.sandbox);
}
if (config.fullAuto) {
  args.push("--full-auto");
}
if (config.profile !== undefined) {
  args.push("--profile", config.profile);
}
if (config.config) {
  for (const [key, value] of Object.entries(config.config)) {
    args.push("-c", `${key}=${value}`);
  }
}
if (config.baseInstructions !== undefined) {
  args.push("-c", `instructions.base_instructions=${JSON.stringify(config.baseInstructions)}`);
}
if (config.images?.length) {
  args.push("--image", config.images.join(","));
}
if (config.skipGitRepoCheck) {
  args.push("--skip-git-repo-check");
}
if (config.dangerouslyBypassApprovalsAndSandbox) {
  args.push("--dangerously-bypass-approvals-and-sandbox");
}

// Add the prompt last (for new sessions; resume uses positional arg)
if (!config.resumeSessionId) {
  args.push(config.prompt);
} else if (config.prompt) {
  args.push(config.prompt);  // Follow-up message for resume
}

const child = spawn(cliPath, args, {
  cwd: config.workingDirectory || process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});
```

### Resuming a Session

When `codex_say` is called on a session whose process has exited:

```typescript
// Spawn: codex exec resume <sessionId> --json "<message>"
const args = [
  "exec", "resume", sessionId, "--json",
  ...originalConfigFlags,  // Preserved from session creation
  message,
];
```

### Interrupt via SIGINT

```typescript
child.kill("SIGINT");
```

### Process Exit Handling

```typescript
child.on("exit", (code, signal) => {
  if (signal === "SIGINT" || signal === "SIGTERM") {
    session.status = "interrupted";
  } else if (code === 0) {
    session.status = "done";
  } else {
    session.status = "error";
    session.error = `Process exited with code ${code}`;
  }
  session.process = null;
});
```

---

## Event Buffer Design

Each session maintains a ring buffer of recent events for the `codex_status` tool.

```typescript
class EventBuffer {
  private events: CodexEvent[] = [];
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  push(event: CodexEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  getRecent(n: number): CodexEvent[] {
    return this.events.slice(-n);
  }

  getRecentText(n: number): string[] {
    return this.events
      .filter(e =>
        e.type === "item.completed" &&
        (e as ItemCompletedEvent).item?.type === "agent_message" &&
        (e as ItemCompletedEvent).item?.text
      )
      .slice(-n)
      .map(e => (e as ItemCompletedEvent).item.text!);
  }

  getItemEvents(): Array<{ itemType: string; status: string; summary?: string }> {
    const items = new Map<string, { itemType: string; status: string; summary?: string }>();

    for (const event of this.events) {
      if (event.type === "item.started") {
        items.set(event.item.id, {
          itemType: event.item.type,
          status: "started",
        });
      } else if (event.type === "item.updated") {
        const existing = items.get(event.item.id);
        if (existing) {
          existing.status = "in_progress";
        }
      } else if (event.type === "item.completed") {
        const existing = items.get(event.item.id);
        if (existing) {
          existing.status = "completed";
          existing.summary = event.item.text || event.item.command || event.item.tool;
        }
      }
    }

    return Array.from(items.values());
  }
}
```

---

## File Structure

```
packages/codex/
├── package.json
├── tsconfig.json
├── PLAN.md                              # This file
├── src/
│   ├── index.ts                         # Entry point, starts MCP server
│   ├── mcp-server.ts                    # MCP server setup, tool registration
│   ├── session-manager.ts               # Session lifecycle management
│   ├── process-manager.ts               # Codex CLI process spawning/management
│   ├── stream-parser.ts                 # JSONL stream parsing, event typing
│   ├── approval-manager.ts              # Approval handling (elicitation + queue)
│   └── types.ts                         # Shared type definitions
├── test/
│   ├── mock-codex-cli.ts               # Mock Codex CLI for testing
│   ├── stream-parser.test.ts            # Stream parser unit tests
│   ├── session-manager.test.ts          # Session manager unit tests
│   ├── approval-manager.test.ts         # Approval manager unit tests
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

### 1. Mock Codex CLI (`test/mock-codex-cli.ts`)

A standalone Node.js script that simulates Codex's `exec --json` behavior. This is the foundation for all non-E2E tests.

**Capabilities:**
- Accepts the same flags as real Codex exec
- Emits `thread.started`, `turn.started`, `item.*`, `turn.completed` events in JSONL format
- Can simulate approval requests (blocks, waits for stdin)
- Responds to SIGINT with clean exit
- Can simulate delays, errors, multi-turn conversations (via resume)
- Behavior controlled via environment variables

### 2. Unit Tests

**`stream-parser.test.ts`**
- Parses valid JSONL lines into typed events
- Correctly types all event variants (thread.started, turn.*, item.*)
- Handles malformed JSON gracefully (skips, logs)
- Handles unknown event types without crashing
- Handles unknown item types defensively

**`session-manager.test.ts`**
- Creates sessions with correct initial state
- State transitions (active → done → active via resume)
- Auto-resume on `codex_say` with correct flags
- Handles unknown session IDs (creates on-the-fly for user sessions)
- Lists sessions by scanning `$CODEX_HOME/sessions/`
- Error state handling (turn.failed, process crash)

**`approval-manager.test.ts`**
- Classifies requests: command_approval vs patch_approval
- Builds correct questions/options for each type
- Queues requests when elicitation unavailable
- Attempts elicitation when client supports it
- Parses answer strings (with and without reasons)
- Times out stale requests

### 3. Integration Tests

**`process-manager.test.ts`**
- Spawns mock CLI, captures thread.started event and session ID
- Streams item events correctly
- Interrupt via SIGINT
- Handles process crash/hang
- Resume spawns correctly with session ID
- Verifies only explicitly-set flags are passed to CLI

**`mcp-server.test.ts`**
- Tests each tool handler with mock session manager
- Validates input schema enforcement
- Tests error responses for invalid session IDs
- Tests polling flow: start → status(active) → status(done)
- Tests resume flow: start → done → say → active

### 4. End-to-End Tests (`e2e.test.ts`)

Gated behind `CODEX_E2E=true`. Requires real Codex CLI and API key.

- Creates a real session with a simple prompt
- Checks status until completion
- Sends follow-up message (auto-resume)
- Interrupts a running session
- Lists sessions, verifies created session appears

### 5. Test Infrastructure

**Test runner:** Vitest

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:e2e": "CODEX_E2E=true vitest run test/e2e.test.ts"
}
```

---

## Implementation Phases

### Phase 1: Foundation
- [ ] Set up dependencies (MCP SDK, zod, split2, vitest)
- [ ] Implement `types.ts` with all shared types
- [ ] Implement `stream-parser.ts` with JSONL parsing for Codex event types
- [ ] Write `stream-parser.test.ts`
- [ ] Create `mock-codex-cli.ts`

### Phase 2: Process Management
- [ ] Implement `process-manager.ts` (spawn codex exec, parse JSONL events, signal)
- [ ] Write `process-manager.test.ts` using mock CLI
- [ ] Verify JSONL event stream parsing end-to-end
- [ ] Verify resume spawning works correctly

### Phase 3: Session Management
- [ ] Implement `session-manager.ts` (lifecycle, state machine, event buffer)
- [ ] Implement `codex_list` (scan `$CODEX_HOME/sessions/`)
- [ ] Write `session-manager.test.ts`
- [ ] Implement auto-resume in `codex_say`

### Phase 4: Approval Handling
- [ ] Implement `approval-manager.ts` (detect approval requests, queue, elicitation)
- [ ] Write `approval-manager.test.ts`
- [ ] Test elicitation flow with mock MCP client
- [ ] Test polling/respond flow

### Phase 5: MCP Server & Tools
- [ ] Implement `mcp-server.ts` with all 6 tools
- [ ] Implement `index.ts` entry point
- [ ] Write `mcp-server.test.ts`
- [ ] Test elicitation detection and flow

### Phase 6: Integration & Polish
- [ ] Write E2E tests
- [ ] Handle edge cases (concurrent sessions, rapid start/interrupt, process leaks)
- [ ] Implement graceful shutdown (kill all child processes)
- [ ] Add stderr logging throughout
- [ ] Build and verify the package works end-to-end

---

## Configuration

Example MCP client configuration:

```json
{
  "mcpServers": {
    "codex": {
      "command": "node",
      "args": ["./node_modules/@localrouter/codex/dist/index.js"],
      "env": {
        "CODEX_CLI_PATH": "codex",
        "CODEX_HOME": "~/.codex",
        "APPROVAL_TIMEOUT_MS": "300000",
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
| `CODEX_CLI_PATH` | `"codex"` | Path to the Codex CLI binary |
| `CODEX_HOME` | `"~/.codex"` | Codex home directory (for session discovery) |
| `APPROVAL_TIMEOUT_MS` | `300000` (5 min) | Timeout for pending approval requests |
| `MAX_SESSIONS` | `10` | Maximum concurrent active sessions (processes) |
| `LOG_LEVEL` | `"info"` | Logging level (debug, info, warn, error) |
| `EVENT_BUFFER_SIZE` | `500` | Number of events to retain per session |

---

## Comparison with Claude Code MCP

| Aspect | Claude Code MCP | Codex MCP |
|---|---|---|
| **CLI interface** | `claude -p --output-format stream-json --input-format stream-json` | `codex exec --json` |
| **Process model** | Long-lived process, bidirectional stdin/stdout | One process per turn, resume for follow-ups |
| **Permission routing** | `--permission-prompt-tool` via internal MCP server + HTTP callbacks | `--ask-for-approval` policy flag + process I/O for interactive approvals |
| **Internal MCP server** | Yes (permission-handler-mcp.ts, permission-callback-server.ts) | No (not needed) |
| **Modules** | 7 (+ permission handler + callback server) | 6 (simpler architecture) |
| **Session storage** | `~/.claude/history.jsonl` | `$CODEX_HOME/sessions/YYYY/MM/DD/*.jsonl` |
| **Resume mechanism** | `--resume <sessionId>` flag on same process | `codex exec resume <sessionId>` (new process) |
| **Sandbox** | N/A (part of permission mode) | Separate `--sandbox` flag (read-only, workspace-write, danger-full-access) |
| **Approval types** | tool_approval, plan_approval, question | command_approval, patch_approval |
| **Plan mode** | `--permission-mode plan` with ExitPlanMode | `--include-plan-tool` flag (todo_list items) |
| **Config format** | settings.json, environment | config.toml, profiles |

### Shared Patterns (Consistent Across Connectors)

1. **6 MCP tools** with matching semantics: `_start`, `_say`, `_status`, `_respond`, `_interrupt`, `_list`
2. **Unified question/answer model** for approval handling via `_respond`
3. **MCP elicitation with fallback** to polling + respond
4. **Ring buffer** for event storage
5. **In-memory session tracking** with no persistent storage of our own
6. **CLI defaults respected** -- only pass flags when explicitly set
7. **Auto-resume** on `_say` to inactive sessions
8. **Session discovery** from the tool's own storage

---

## Open Questions & Risks

### Known Issues to Watch

1. **`codex exec --json` event format stability**: The JSONL schema has changed between versions (e.g., `item_type` → `type`, `assistant_message` → `agent_message`). Parse defensively and handle unknown fields/types gracefully.

2. **Approval request detection in `codex exec`**: The exact mechanism by which `codex exec` signals approval requests is not fully documented for non-interactive use. May require experimentation or reading Codex source to determine whether approval requests appear on stderr, as special JSONL events, or via process blocking. Phase 4 may need to be adjusted based on findings.

3. **Session directory format stability**: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` is not a documented public API. Parse defensively.

4. **SIGINT behavior on Windows**: Like Claude Code, `subprocess.kill('SIGINT')` on Windows may cause forceful termination. May need IPC-based interrupt for Windows.

5. **`codex exec --json` image flag bug**: Known issue (#5773) where `--json` hangs when `--image` flag is used. May need workaround.

6. **No bidirectional streaming**: Unlike Claude Code, we can't send messages to a running `codex exec` process. Each follow-up requires a new process. This adds latency but simplifies the architecture.

### Design Alternatives Considered

1. **Wrap built-in `codex mcp-server`**: Rejected -- limited to 2 tools, no status polling, no interrupt, no session listing. Would be an MCP-to-MCP proxy with limited value-add.

2. **Use `codex app-server` (JSON-RPC over stdio)**: More powerful than `codex exec` with full interactive support, but the protocol is less documented and designed for IDE integrations, not headless wrapping. Could be a future enhancement.

3. **Use Codex as a library (codex-core)**: Deepest integration but Codex is written in Rust -- no easy Node.js bindings. CLI wrapping is the pragmatic choice.

4. **Skip approval handling entirely**: Simpler but loses the ability for the outer agent to make informed approval decisions. The unified question/answer model preserves this capability.

### Future Enhancements

- **App Server integration**: Use `codex app-server` for richer interactive sessions with native approval support.
- **Structured output**: Expose `--output-schema` support so agents can request JSON-structured responses.
- **Cloud tasks**: Integrate `codex cloud` for remote execution.
- **Session forking**: Use `codex fork` to branch sessions.
- **Cost tracking**: Aggregate token usage across sessions.
- **MCP Resources**: Expose session output as MCP resources.
- **Shared base library**: Extract common patterns (event buffer, session manager, MCP server setup) into a shared `@localrouter/mcp-base` package used by both Claude Code MCP and Codex MCP.

---

## Appendix: Codex CLI Quick Reference

### Key Subcommands

| Command | Purpose |
|---|---|
| `codex` | Interactive TUI |
| `codex exec` / `codex e` | Non-interactive mode |
| `codex exec resume <id>` | Resume a session non-interactively |
| `codex mcp-server` | Built-in MCP server (2 tools) |
| `codex resume` | Resume interactive session |
| `codex fork` | Fork a session |
| `codex mcp add/list/get` | Manage MCP server configs |

### Approval Policies (`--ask-for-approval`)

| Policy | Behavior |
|---|---|
| `untrusted` | Ask for everything untrusted |
| `on-failure` | Ask only when commands fail |
| `on-request` | Ask only when model explicitly requests |
| `never` | Auto-approve everything |

### Sandbox Modes (`--sandbox`)

| Mode | Behavior |
|---|---|
| `read-only` | No writes allowed |
| `workspace-write` | Writes only within workspace |
| `danger-full-access` | Full filesystem access |

### JSONL Event Types (`codex exec --json`)

| Event | Description |
|---|---|
| `thread.started` | Session initialized, includes `thread_id` |
| `turn.started` | Agent turn begins |
| `turn.completed` | Turn finished, includes `usage` |
| `turn.failed` | Turn encountered error |
| `item.started` | Item processing begins |
| `item.updated` | Item state changed (e.g., plan updates) |
| `item.completed` | Item finished |
| `error` | Stream-level error (may be transient reconnect) |

### Item Types

| Type | Description |
|---|---|
| `agent_message` | Text response from the agent |
| `reasoning` | Reasoning summary (when enabled) |
| `command_execution` | Shell command execution |
| `file_change` | File modification |
| `mcp_tool_call` | Call to an MCP tool |
| `web_search` | Web search operation |
| `todo_list` | Plan/todo updates |
| `error` | Error item |
