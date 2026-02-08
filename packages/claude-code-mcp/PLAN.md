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

6. **No session storage of our own**: Session persistence is Claude Code's responsibility (`~/.claude/`). Our MCP server only tracks in-memory state for active process handles. `claude_list` reads directly from `~/.claude/history.jsonl`. Any session (including user-created interactive sessions) can be resumed.

7. **Unified question/answer model**: All three types of user input -- tool approval, plan approval, and user questions -- are surfaced as "questions with options" in `claude_status`. The client responds using a single `claude_respond` tool with an array of selected answers. The response format is identical regardless of whether it's a permission, plan review, or question.

---

## MCP Tools

Six tools total. Tools use CLI defaults for all optional parameters -- if not specified, Claude Code's own configuration applies.

### 1. `claude_start`

Start a new Claude Code session with an initial prompt.

```typescript
{
  name: "claude_start",
  description: "Start a new Claude Code CLI session with an initial prompt",
  inputSchema: {
    type: "object",
    properties: {
      prompt:           { type: "string", description: "The initial task/prompt for Claude Code" },
      workingDirectory: { type: "string", description: "Working directory for the session" },

      // All optional -- CLI defaults apply when omitted
      model:            { type: "string", description: "Model override (e.g. 'sonnet', 'opus', or full model ID)" },
      permissionMode:   { type: "string", enum: ["default", "acceptEdits", "plan", "bypassPermissions"],
                          description: "Permission mode. 'plan' = read-only analysis then plan review. Default: CLI's configured mode" },
      allowedTools:     { type: "array", items: { type: "string" },
                          description: "Tools to pre-approve without prompting (e.g. ['Read', 'Glob', 'Bash(git diff *)'])" },
      disallowedTools:  { type: "array", items: { type: "string" },
                          description: "Tools to explicitly block" },
      maxTurns:         { type: "number", description: "Maximum agentic turns. Default: unlimited" },
      maxBudgetUsd:     { type: "number", description: "Maximum spend in USD. Default: unlimited" },
      systemPrompt:     { type: "string", description: "System prompt text to append via --append-system-prompt" },
      dangerouslySkipPermissions: { type: "boolean",
                          description: "Skip all permission checks. Default: false" },
    },
    required: ["prompt"]
  }
}
```

**Returns:** `{ sessionId: string, status: "active" }`

**Behavior:**
- Spawns a new `claude -p` process with `--output-format stream-json --input-format stream-json --verbose --include-partial-messages`
- Captures the `session_id` from the `init` event
- Returns immediately (session runs asynchronously)
- Only passes optional flags when explicitly provided; omitted = use CLI defaults

### 2. `claude_say`

Send a message to an existing session. Handles both active sessions (process alive) and inactive sessions (auto-resumes). Optionally switches the permission mode.

```typescript
{
  name: "claude_say",
  description: "Send a message to a Claude Code session. Automatically resumes the session if it has ended.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId:      { type: "string", description: "The session ID" },
      message:        { type: "string", description: "The message to send" },
      permissionMode: { type: "string", enum: ["default", "acceptEdits", "plan", "bypassPermissions"],
                        description: "Switch permission mode for this and subsequent turns. If the session is currently active, it will be interrupted and resumed with the new mode." },
    },
    required: ["sessionId", "message"]
  }
}
```

**Returns:** `{ sessionId: string, status: "active" }`

**Behavior:**
- **Process alive, no mode change:** writes a user message to stdin in stream-json format
- **Process alive, mode change requested:** sends SIGINT, waits for exit, then resumes with `--resume <sessionId> --permission-mode <newMode>` and the message as prompt
- **Process exited (completed, interrupted, error):** spawns a new process with `--resume <sessionId>` and the message as prompt, preserving original session config. If `permissionMode` specified, uses the new mode.
- **Session ID unknown (e.g., user-created session):** creates a new tracked session and spawns with `--resume`

### 3. `claude_status`

Check the current status of a session and retrieve output.

```typescript
{
  name: "claude_status",
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
  status: "active" | "awaiting_input" | "done" | "error" | "interrupted",
  result?: string,              // Final result text when status is "done"
  recentOutput: string[],       // Recent text output

  // Present when status is "awaiting_input"
  pendingQuestion?: {
    id: string,
    // Informational context -- response format is always the same
    type: "tool_approval" | "plan_approval" | "question",
    questions: Array<{
      question: string,       // Human-readable question text
      options: string[],      // Available answers to choose from
    }>,
  },

  toolUseEvents: Array<{       // Tools used so far
    toolName: string,
    status: "running" | "completed" | "denied",
  }>,
  costUsd?: number,
  turnCount?: number,
}
```

**How `pendingQuestion` is populated for each type:**

**Tool approval** (e.g., Claude wants to run `Edit` on a file):
```json
{
  "id": "tu_abc123",
  "type": "tool_approval",
  "questions": [
    { "question": "Claude wants to use Edit on file src/auth.ts", "options": ["allow", "deny"] }
  ]
}
```

**Plan approval** (Claude finished planning, presenting the plan via `ExitPlanMode`):
```json
{
  "id": "tu_def456",
  "type": "plan_approval",
  "questions": [
    { "question": "Claude has completed a plan:\n\n1. Refactor auth module\n2. Add unit tests\n3. Update docs\n\nApprove this plan and begin implementation?", "options": ["approve", "reject"] }
  ]
}
```

**User question** (Claude is asking for clarification via `AskUserQuestion`):
```json
{
  "id": "tu_ghi789",
  "type": "question",
  "questions": [
    { "question": "Which auth provider should I target?", "options": ["OAuth2", "SAML", "Both"] },
    { "question": "Should I include integration tests?", "options": ["Yes", "No"] }
  ]
}
```

### 4. `claude_respond`

Respond to a pending question. Works identically for tool approvals, plan approvals, and user questions -- just pick the answer(s) from the provided options.

```typescript
{
  name: "claude_respond",
  description: "Respond to a pending question in a Claude Code session. Provide one answer per question from the options shown in claude_status.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "The session ID" },
      id:        { type: "string", description: "The question ID from pendingQuestion.id in claude_status" },
      answers:   { type: "array", items: { type: "string" },
                   description: "One answer per question, selected from the options (e.g. ['allow'], ['approve'], ['OAuth2', 'Yes'])" },
    },
    required: ["sessionId", "id", "answers"]
  }
}
```

**Returns:** `{ sessionId: string, status: "active" | "awaiting_input" }`

**Examples:**
```
// Approve a tool
claude_respond({ sessionId: "...", id: "tu_abc123", answers: ["allow"] })

// Reject a plan
claude_respond({ sessionId: "...", id: "tu_def456", answers: ["reject"] })

// Answer multiple questions
claude_respond({ sessionId: "...", id: "tu_ghi789", answers: ["OAuth2", "Yes"] })
```

**Internal translation** (invisible to the client):

Our permission manager translates answers back to the `--permission-prompt-tool` response format based on the tool name:

| Tool Name | Answer | Permission Response |
|---|---|---|
| Any tool (Edit, Bash, etc.) | `["allow"]` | `{ behavior: "allow" }` |
| Any tool | `["deny"]` | `{ behavior: "deny" }` |
| `ExitPlanMode` | `["approve"]` | `{ behavior: "allow", updatedInput: <original> }` |
| `ExitPlanMode` | `["reject"]` | `{ behavior: "deny" }` |
| `AskUserQuestion` | `["OAuth2", "Yes"]` | `{ behavior: "allow", updatedInput: { questions: <orig>, answers: ["OAuth2", "Yes"] } }` |

If the user rejects a plan and wants to provide feedback on what to change, they can send a follow-up message via `claude_say` after the rejection.

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
- Session can be resumed later with `claude_say`

### 6. `claude_list`

List all Claude Code sessions from the global session history. Lists sessions from any directory, including user-created interactive sessions.

```typescript
{
  name: "claude_list",
  description: "List all Claude Code sessions across all projects. Includes both programmatic and interactive user-created sessions.",
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
    projectDirectory: string,  // Working directory where the session was created
    displayText: string,       // Summary/topic of the conversation
    timestamp: string,         // ISO timestamp
    isActive: boolean,         // Whether this server currently has an active process for this session
    activeStatus?: "active" | "awaiting_input" | "done" | "error" | "interrupted",
  }>
}
```

**Behavior:**
- Reads `~/.claude/history.jsonl` and parses entries
- Each line contains: `{ timestamp, project, display, session_id?, ... }`
- Optionally filters by `workingDirectory`
- Sorts by timestamp descending (most recent first)
- Annotates entries with `isActive: true` if our server currently has an active process for that session
- Any listed session can be resumed via `claude_say` with its `sessionId`, even if it was created interactively by the user

---

## Planning Mode Support

Claude Code's plan mode (`--permission-mode plan`) restricts Claude to read-only tools and produces a plan via `ExitPlanMode`. This integrates naturally with our architecture because both `ExitPlanMode` and `AskUserQuestion` go through the `--permission-prompt-tool` mechanism and are surfaced as `pendingQuestion` entries.

### Typical Planning Flow

```
1. claude_start({ prompt: "Refactor the auth module", permissionMode: "plan" })
   → { sessionId: "abc", status: "active" }

2. (Claude reads code, analyzes codebase using read-only tools...)

3. claude_status({ sessionId: "abc" })
   → {
       status: "awaiting_input",
       pendingQuestion: {
         id: "tu_xyz",
         type: "plan_approval",
         questions: [{
           question: "Claude has completed a plan:\n\n1. Extract auth logic...\n2. Add OAuth2...\n\nApprove?",
           options: ["approve", "reject"]
         }]
       }
     }

4a. claude_respond({ sessionId: "abc", id: "tu_xyz", answers: ["approve"] })
    → Claude exits plan mode, begins implementation

4b. claude_respond({ sessionId: "abc", id: "tu_xyz", answers: ["reject"] })
    → Claude knows plan was rejected
    claude_say({ sessionId: "abc", message: "Also cover the session management module" })
    → Claude revises the plan with the new feedback
```

### Switching Modes Mid-Session

Use `claude_say` with `permissionMode` to switch modes at any time:

```
// Start in plan mode
claude_start({ prompt: "Analyze and improve the codebase", permissionMode: "plan" })

// After reviewing the plan, switch to acceptEdits for implementation
claude_say({ sessionId: "abc", message: "Approved, go ahead", permissionMode: "acceptEdits" })

// Later, switch back to plan mode for a different area
claude_say({ sessionId: "abc", message: "Now plan the database migration", permissionMode: "plan" })
```

If the session's process is still active when a mode change is requested, it is interrupted first (SIGINT), then resumed with the new mode and the message.

---

## Session Lifecycle

### State Machine

```
                      claude_start
                           │
                           ▼
                    ┌──────────┐
        ┌──────────│  ACTIVE   │◄─────────────────────┐
        │          └─────┬─────┘                       │
        │                │                             │
        │   tool/plan/   │         claude_respond       │
        │   question     │                             │
        │                ▼                             │
        │   ┌────────────────────────┐                 │
        │   │  AWAITING_INPUT        │─────────────────┘
        │   └────────────────────────┘
        │
        │  interrupt
        │  (SIGINT)
        │                ┌──────────────┐   claude_say
        ├───────────────►│  INTERRUPTED  │──────────────────►  ACTIVE
        │                └──────────────┘   (auto-resume)
        │
        │  process exits
        │  successfully
        │                ┌──────────────┐   claude_say
        ├───────────────►│  DONE         │──────────────────►  ACTIVE
        │                └──────────────┘   (auto-resume)
        │
        │  process crashes
        │  or error
        │                ┌──────────────┐   claude_say
        └───────────────►│  ERROR        │──────────────────►  ACTIVE
                         └──────────────┘   (auto-resume)
```

Any terminal state (INTERRUPTED, DONE, ERROR) can transition back to ACTIVE via `claude_say`, which automatically spawns a new process with `--resume`.

### Session Discovery & Reconnection

Our MCP server does NOT maintain its own session index. Instead:

1. **`claude_list`** reads `~/.claude/history.jsonl` directly. This file is maintained by Claude Code itself and contains all sessions from all directories, whether created interactively or programmatically.

2. **Any session can be resumed** via `claude_say(sessionId, message)`. If we don't have an active process for that session, we spawn `claude -p --resume <sessionId>`. This works for:
   - Sessions we created earlier in this server lifetime
   - Sessions from a previous server lifetime
   - Interactive sessions the user created in the terminal

3. **Server restart** loses only the in-memory process handles. All session data survives in Claude Code's own persistence. Clients just need to call `claude_say` with the session ID.

---

## Permission Flow Detail

### Flow A: Client Supports Elicitation

```
MCP Client                Our MCP Server              Claude Code CLI          Perm Handler MCP
    │                          │                            │                        │
    │  call claude_start       │                            │                        │
    │─────────────────────────►│  spawn claude -p ...       │                        │
    │                          │───────────────────────────►│                        │
    │  { sessionId, active }   │                            │                        │
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
    │  "Allow Edit on          │                            │                        │
    │   src/auth.ts?"          │                            │                        │
    │  options: allow/deny     │                            │                        │
    │◄─────────────────────────│                            │                        │
    │                          │                            │                        │
    │  { action: "accept",     │                            │                        │
    │    content: {ans:"allow"}}                            │                        │
    │─────────────────────────►│                            │                        │
    │                          │                            │                        │
    │                          │  HTTP 200 { allow }        │                        │
    │                          │───────────────────────────────────────────────────►│
    │                          │                            │◄─────────────────────│
    │                          │                            │  { allow }            │
    │                          │                            │                        │
    │                          │                            │ proceeds with edit     │
```

### Flow B: Client Does NOT Support Elicitation (polling + respond)

```
MCP Client                Our MCP Server              Claude Code CLI          Perm Handler MCP
    │                          │                            │                        │
    │                          │                            │ wants to Edit file     │
    │                          │                            │──────────────────────►│
    │                          │  HTTP POST /permission     │                        │
    │                          │◄───────────────────────────────────────────────────│
    │                          │                            │                        │
    │                          │  (queues question, blocks  │                        │
    │                          │   HTTP response)           │                        │
    │                          │                            │                        │
    │  call claude_status      │                            │                        │
    │─────────────────────────►│                            │                        │
    │  { status: awaiting_input│                            │                        │
    │    pendingQuestion: {    │                            │                        │
    │      id: "tu_123",       │                            │                        │
    │      type: tool_approval,│                            │                        │
    │      questions: [{       │                            │                        │
    │        question: "Allow  │                            │                        │
    │         Edit on auth.ts?"│                            │                        │
    │        options:          │                            │                        │
    │         [allow, deny]    │                            │                        │
    │      }]                  │                            │                        │
    │    }                     │                            │                        │
    │  }                       │                            │                        │
    │◄─────────────────────────│                            │                        │
    │                          │                            │                        │
    │  call claude_respond     │                            │                        │
    │  { id: "tu_123",         │                            │                        │
    │    answers: ["allow"] }  │                            │                        │
    │─────────────────────────►│                            │                        │
    │                          │  HTTP 200 { allow }        │                        │
    │                          │───────────────────────────────────────────────────►│
    │                          │                            │◄─────────────────────│
    │                          │                            │  { allow }            │
    │  { status: "active" }    │                            │                        │
    │◄─────────────────────────│                            │                        │
```

### Flow C: Plan Mode (ExitPlanMode)

```
MCP Client                Our MCP Server              Claude Code CLI          Perm Handler MCP
    │                          │                            │                        │
    │  claude_start            │                            │                        │
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
    │  claude_status           │                            │                        │
    │─────────────────────────►│                            │                        │
    │  { status: awaiting_input│                            │                        │
    │    pendingQuestion: {    │                            │                        │
    │      type: plan_approval,│                            │                        │
    │      questions: [{       │                            │                        │
    │        question: "Plan:  │                            │                        │
    │         1. Refactor...   │                            │                        │
    │         Approve?",       │                            │                        │
    │        options:          │                            │                        │
    │         [approve,reject] │                            │                        │
    │      }]                  │                            │                        │
    │  }}                      │                            │                        │
    │◄─────────────────────────│                            │                        │
    │                          │                            │                        │
    │  claude_respond          │                            │                        │
    │  { answers: ["approve"]} │                            │                        │
    │─────────────────────────►│  HTTP 200 { allow }        │                        │
    │                          │───────────────────────────────────────────────────►│
    │                          │                            │◄─────────────────────│
    │                          │                            │                        │
    │                          │                            │ exits plan mode        │
    │                          │                            │ begins implementation  │
```

---

## Core Modules

### Module 1: `mcp-server.ts` -- MCP Server Setup

Responsibilities:
- Initialize the MCP server with STDIO transport
- Register all 6 tools (`claude_start`, `claude_say`, `claude_status`, `claude_respond`, `claude_interrupt`, `claude_list`)
- Detect client elicitation capability during initialization
- Route tool calls to the session manager
- Handle graceful shutdown

### Module 2: `session-manager.ts` -- Session Lifecycle

Responsibilities:
- Create, track, and clean up sessions
- Map session IDs to process handles and state
- Provide session state queries
- Handle session reconnection (process died but session ID is valid)
- Auto-resume on `claude_say` to inactive sessions
- Handle mode switching (interrupt + resume with new mode)
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

  // Pending question (at most one at a time since the CLI blocks)
  pendingQuestion: PendingQuestion | null;

  // Final result
  result?: string;
  error?: string;

  // Metrics
  costUsd?: number;
  turnCount?: number;
}

type SessionStatus =
  | "active"
  | "awaiting_input"
  | "done"
  | "error"
  | "interrupted";

interface PendingQuestion {
  id: string;
  type: "tool_approval" | "plan_approval" | "question";
  questions: Array<{
    question: string;
    options: string[];
  }>;
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
interface InitEvent {
  type: "init";
  session_id: string;
  timestamp: string;
}

interface StreamEvent {
  type: "stream_event";
  event: {
    type: string;
    delta?: { type: string; text?: string };
    content_block?: { type: string; name?: string };
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

interface UnknownEvent {
  type: string;
  [key: string]: unknown;
}
```

### Module 5: `permission-manager.ts` -- Permission & Input Handling

Responsibilities:
- Receive tool approval requests from the internal HTTP callback server
- Classify requests by `tool_name` into `tool_approval`, `plan_approval`, or `question`
- Build human-readable questions with options arrays
- Attempt MCP elicitation if client supports it
- Fall back to queueing as `pendingQuestion` if elicitation unavailable
- Translate `claude_respond` answers back to the `--permission-prompt-tool` response format
- Timeout handling for stale requests

**Request classification logic:**

```typescript
function classifyRequest(toolName: string): "tool_approval" | "plan_approval" | "question" {
  if (toolName === "ExitPlanMode") return "plan_approval";
  if (toolName === "AskUserQuestion") return "question";
  return "tool_approval";
}
```

**Question generation:**

```typescript
function buildQuestion(toolName: string, toolInput: Record<string, unknown>): PendingQuestion {
  switch (classifyRequest(toolName)) {
    case "tool_approval":
      return {
        type: "tool_approval",
        questions: [{
          question: `Claude wants to use ${toolName}: ${summarizeInput(toolName, toolInput)}`,
          options: ["allow", "deny"],
        }],
      };
    case "plan_approval":
      return {
        type: "plan_approval",
        questions: [{
          question: `Claude has completed a plan:\n\n${toolInput.plan || JSON.stringify(toolInput)}\n\nApprove this plan and begin implementation?`,
          options: ["approve", "reject"],
        }],
      };
    case "question":
      return {
        type: "question",
        questions: (toolInput.questions as Array<{ question: string; options: string[] }>).map(q => ({
          question: q.question,
          options: q.options,
        })),
      };
  }
}
```

**Answer translation:**

```typescript
function translateAnswer(
  type: "tool_approval" | "plan_approval" | "question",
  answers: string[],
  originalInput: Record<string, unknown>
): PermissionResponse {
  switch (type) {
    case "tool_approval":
      return { behavior: answers[0] === "allow" ? "allow" : "deny" };
    case "plan_approval":
      return answers[0] === "approve"
        ? { behavior: "allow", updatedInput: originalInput }
        : { behavior: "deny" };
    case "question":
      return {
        behavior: "allow",
        updatedInput: {
          ...(originalInput as any),
          answers: answers,
        },
      };
  }
}
```

### Module 6: `permission-callback-server.ts` -- Internal HTTP Server

Responsibilities:
- Listen on a random localhost port
- Receive HTTP POST requests from the internal permission handler MCP server
- Forward to the permission manager
- Block until the question is answered (by elicitation or by `claude_respond`)
- Return the translated allow/deny response

### Module 7: `permission-handler-mcp.ts` -- Internal Permission MCP Server Script

A standalone Node.js script that Claude Code spawns as an MCP server. Receives ALL tool approval requests (regular tools, `ExitPlanMode`, `AskUserQuestion`) and forwards them via HTTP to the callback server.

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
child.kill("SIGINT"); // Equivalent to pressing Escape
```

### Process Exit Handling

```typescript
child.on("exit", (code, signal) => {
  if (signal === "SIGINT") {
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

Each session maintains a ring buffer of recent events for the `claude_status` tool.

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
- Accepts the same flags as real Claude Code
- Emits `init`, `stream_event`, `result` events
- Supports permission requests, ExitPlanMode, AskUserQuestion
- Responds to SIGINT with interrupted result
- Can simulate delays, errors, multi-turn conversations
- Behavior controlled via environment variables

### 2. Unit Tests

**`stream-parser.test.ts`**
- Parses valid NDJSON lines into typed events
- Handles malformed JSON gracefully (skips, logs)
- Handles partial lines (buffering)
- Handles unknown event types without crashing

**`session-manager.test.ts`**
- Creates sessions with correct initial state
- State transitions (active → awaiting_input → active → done)
- Auto-resume on `claude_say` with correct flags
- Mode switching: interrupt + resume with new mode
- Handles unknown session IDs (creates on-the-fly for user sessions)
- Lists sessions by parsing history.jsonl

**`permission-manager.test.ts`**
- Classifies requests: tool_approval vs plan_approval vs question
- Builds correct questions/options for each type
- Translates answers back to permission responses
- Queues requests when elicitation unavailable
- Attempts elicitation when client supports it
- Times out stale requests

### 3. Integration Tests

**`process-manager.test.ts`**
- Spawns mock CLI, captures init event and session ID
- Sends messages via stdin, receives responses
- Streams partial messages
- Interrupt via SIGINT
- Handles process crash/hang
- Permission flow via internal HTTP callback
- Plan mode flow via ExitPlanMode
- Verifies only explicitly-set flags are passed to CLI

**`mcp-server.test.ts`**
- Tests each tool handler with mock session manager
- Validates input schema enforcement
- Tests error responses for invalid session IDs
- Tests polling flow: start → status(awaiting) → respond
- Tests mode switching via claude_say

### 4. End-to-End Tests (`e2e.test.ts`)

Gated behind `CLAUDE_CODE_E2E=true`. Requires real Claude Code CLI.

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
- [ ] Implement `claude_list` (parse `~/.claude/history.jsonl`)
- [ ] Write `session-manager.test.ts`
- [ ] Implement auto-resume and mode switching in `claude_say`

### Phase 4: Permission & Input Handling
- [ ] Implement `permission-callback-server.ts` (internal HTTP server)
- [ ] Implement `permission-handler-mcp.ts` (standalone script)
- [ ] Implement `permission-manager.ts` (classification, question building, answer translation, elicitation + queue)
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

Example MCP client configuration:

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
| `PERMISSION_TIMEOUT_MS` | `300000` (5 min) | Timeout for pending questions |
| `MAX_SESSIONS` | `10` | Maximum concurrent active sessions (processes) |
| `LOG_LEVEL` | `"info"` | Logging level (debug, info, warn, error) |
| `EVENT_BUFFER_SIZE` | `500` | Number of events to retain per session |

---

## Open Questions & Risks

### Known Issues to Watch

1. **`--input-format stream-json` multi-turn reliability**: Reported issues with hanging after the second message (GitHub #3187, marked resolved) and duplicate session log entries (#5034, cosmetic only). Need to verify in current CLI versions.

2. **`--permission-prompt-tool` event emission**: Bug reported (SDK issue #469) where `control_request` events were not emitted. Our separate MCP server approach should be more robust.

3. **SIGINT behavior on Windows**: `subprocess.kill('SIGINT')` on Windows causes forceful termination. May need IPC-based interrupt for Windows.

4. **`history.jsonl` format stability**: Not a documented public API. Parse defensively.

5. **`ExitPlanMode` via `--permission-prompt-tool`**: Need to verify this routes through the permission-prompt-tool in non-interactive mode. Docs indicate it goes through `canUseTool` in the SDK, CLI behavior may differ.

### Design Alternatives Considered

1. **Agent SDK instead of CLI**: Cleaner hooks but user requested CLI wrapping.
2. **PTY-based interactive session**: Rejected -- fragile ANSI parsing, merged stdout/stderr.
3. **Inline `control_request`/`control_response`**: Known reliability issues.
4. **Separate approve/deny tools**: Replaced with unified question/answer model via `claude_respond`.
5. **Separate resume/send_message tools**: Replaced with `claude_say` which auto-resumes.
6. **Separate fields for approval vs question answers**: Replaced with uniform `answers[]` array.

### Future Enhancements

- **Cost tracking**: Aggregate and report cost across sessions.
- **Session forking**: Use `--fork-session` to branch sessions.
- **MCP Resources**: Expose session output as MCP resources.

---

## Appendix: Lessons from Existing CLI Wrappers

### From `RichardAtCT/claude-code-openai-wrapper` (Python, Agent SDK)

1. **`permissionMode: "bypassPermissions"` is essential for headless operation.** Our `--permission-prompt-tool` approach routes approvals programmatically instead of bypassing them.
2. **SDK/CLI message format instability across versions.** Our stream-json parser must be defensive about message shapes.
3. **System prompt must be structured** in the SDK. Verify `--append-system-prompt` handles this.
4. **`max_turns=1` when tools are disabled** prevents wasted loops.
5. **In-memory sessions with TTL** is the proven pattern.
6. **Factory pattern** for mock/real implementations aids testing.

### From `jasonpaulso/claude-cli-lib` (TypeScript, node-pty)

1. **PTY is wrong for structured JSON** -- validates our `child_process.spawn` approach.
2. **No stdin writing = no interactivity** -- validates our `--input-format stream-json` approach.
3. **Process lifecycle cleanup in `finally` blocks** is correct.
4. **Ring buffer for output storage** matches our EventBuffer design.
5. **Kill sends SIGHUP, not SIGINT** in PTY -- we use explicit `SIGINT` for interrupt.

### Summary of Design Validations

| Decision | Validated By |
|---|---|
| Use `child_process.spawn`, not `node-pty` | `claude-cli-lib` shows PTY limitations |
| Use `--permission-prompt-tool`, not `bypassPermissions` | `openai-wrapper` shows bypass loses safety |
| Defensive stream parsing | `openai-wrapper` hit SDK format changes |
| In-memory sessions with TTL | `openai-wrapper` uses same pattern |
| Ring buffer for event storage | Both projects use bounded buffers |
| Factory/DI pattern for testability | `claude-cli-lib` uses factory pattern |
