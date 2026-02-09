# Codex MCP Server - Revised Implementation Plan

## Overview

An MCP server wrapping the OpenAI Codex CLI, exposing it as tools over STDIO transport. This is the second connector in the `@localrouter/connectors` monorepo, following the completed Claude Code MCP implementation.

This revised plan is based on lessons learned from implementing `@localrouter/claude-code-mcp` and identifies concrete opportunities for code reuse via a shared `@localrouter/mcp-base` library.

### Why Not Use the Built-in `codex mcp-server`?

Codex ships with `codex mcp-server` (2 tools: `codex` and `codex-reply`). Our wrapper adds:

1. **Rich status polling**: Event history with ring buffer, item tracking, usage stats
2. **Session interrupt**: SIGINT support (built-in server has none)
3. **Session discovery**: List and resume sessions across projects, including user-created interactive sessions
4. **Granular configuration**: Per-session approval policy, sandbox mode, model, profiles
5. **Unified connector pattern**: Consistent interface with Claude Code MCP for multi-tool orchestration

---

## Architecture: What Changed Since V1

### Lessons from Claude Code MCP Implementation

Having fully implemented Claude Code MCP (9 modules, 1786 lines, 92+ tests), several patterns emerged that reshape this plan:

1. **The permission complexity is Claude Code-specific.** Claude Code MCP required 2 extra modules (`permission-callback-server.ts` at 87 lines, `permission-handler-mcp.ts` at 117 lines) plus an internal HTTP server solely to work around `--permission-prompt-tool`'s callback-based design. Codex's `--ask-for-approval` flag handles this natively via process I/O -- **204 lines of infrastructure we don't need**.

2. **70%+ of session-manager.ts is connector-agnostic.** Session tracking, state machine transitions, event buffering, the wait-for-ID polling pattern, graceful shutdown, `waitForExit` -- all of these are identical across connectors. Only event handling, session discovery, and process spawning differ.

3. **The MCP tool registration pattern is pure boilerplate.** Every tool handler follows the same try/catch → `JSON.stringify(result)` → `{ content: [{ type: "text", text }] }` pattern, with `isError: true` on failure. The 6-tool structure (`_start`, `_say`, `_status`, `_respond`, `_interrupt`, `_list`) is identical.

4. **`parseAnswer()` is connector-agnostic.** The "split on first colon" logic for extracting decisions and reasons is shared verbatim.

5. **The event buffer is a universal pattern.** Ring buffer with configurable max size, push/shift, get-recent-N. Only the text extraction logic differs per connector.

### Design Trade-off: Claude Code vs Codex Permission Architecture

| Aspect | Claude Code MCP | Codex MCP |
|---|---|---|
| **How CLI signals approvals** | `--permission-prompt-tool` calls an internal MCP tool | `--ask-for-approval` blocks process, writes to stderr |
| **Infrastructure needed** | HTTP callback server + internal MCP server (204 lines) | Read stderr, write to stdin (inline in process-manager) |
| **Approval granularity** | Per-tool: allow/deny with reason, input modification | Per-action: approve/deny commands and patches |
| **Question types** | `tool_approval`, `plan_approval`, `question` | `command_approval`, `patch_approval` |
| **Complexity driver** | `--permission-prompt-tool` requires MCP-to-HTTP bridge | Native process I/O -- no bridge needed |

This is a design trade-off, not a quality difference. Claude Code's `--permission-prompt-tool` enables richer control (input modification, multi-question AskUserQuestion) but requires more infrastructure. Codex's approach is simpler because the CLI handles approval routing natively.

---

## Shared Library: `@localrouter/mcp-base`

Before implementing Codex MCP, we extract the connector-agnostic patterns from Claude Code MCP into a shared package. This package becomes the foundation for both connectors (and any future ones).

### What Goes Into `mcp-base`

```
packages/mcp-base/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                    # Re-exports all public API
    ├── types.ts                    # Shared base types
    ├── event-buffer.ts             # Ring buffer for events
    ├── answer-parser.ts            # Parse "decision: reason" answers
    ├── question-manager.ts         # Timeout management for pending questions
    ├── stream-parser.ts            # split2-based NDJSON parser
    ├── mcp-tool-handler.ts         # Tool registration helpers
    └── session-base.ts             # Base session state machine
```

### Module-by-Module Extraction

#### 1. `types.ts` -- Shared Base Types

Types that are identical across connectors:

```typescript
// Session status (shared state machine)
export type BaseSessionStatus =
  | "active"
  | "awaiting_input"     // Claude Code: awaiting_input, Codex: awaiting_approval
  | "done"
  | "error"
  | "interrupted";

// Question model (shared structure)
export interface QuestionItem {
  question: string;
  options: string[];
}

export interface BasePendingQuestion {
  id: string;
  type: string;              // Connector defines specific types
  questions: QuestionItem[];
  resolve: (response: unknown) => void;
}

// Environment config (shared fields)
export interface BaseEnvConfig {
  cliPath: string;            // Path to CLI binary
  approvalTimeoutMs: number;  // Timeout for pending questions
  maxSessions: number;
  logLevel: string;
  eventBufferSize: number;
}

// Base session (connector extends with specific fields)
export interface BaseSession<TEvent, TStatus extends string = BaseSessionStatus> {
  id: string;
  status: TStatus;
  process: import("node:child_process").ChildProcess | null;
  createdAt: Date;
  workingDirectory: string;
  config: Record<string, unknown>;
  eventBuffer: TEvent[];
  pendingQuestion: BasePendingQuestion | null;
  result?: string;
  error?: string;
}
```

**What stays connector-specific:**
- Claude Code: `PermissionMode`, `PermissionResponse`, `PermissionCallbackRequest`, `SpawnConfig` (with `permissionCallbackPort`), `StreamEvent` inner structure, `ToolUseEvent`, `costUsd`, `turnCount`
- Codex: `ApprovalPolicy`, `SandboxMode`, `SpawnConfig` (with `approvalPolicy`, `sandbox`, `fullAuto`, etc.), `CodexEvent` union, `ItemType`, `usage` object shape

#### 2. `event-buffer.ts` -- Ring Buffer

Extracted from the inline pattern in `session-manager.ts`:

```typescript
export class EventBuffer<T> {
  private events: T[] = [];
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  push(event: T): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  getRecent(n: number): T[] {
    return this.events.slice(-n);
  }

  getAll(): T[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }

  /**
   * Extract items matching a predicate, returning at most `count`.
   * Connector provides the filter/map logic for its event type.
   */
  extract<R>(fn: (event: T) => R | undefined, count: number): R[] {
    const results: R[] = [];
    for (const event of this.events) {
      const result = fn(event);
      if (result !== undefined) results.push(result);
    }
    return results.slice(-count);
  }
}
```

**Current Claude Code MCP code this replaces** (from `session-manager.ts:422-427`):
```typescript
session.eventBuffer.push(event);
if (session.eventBuffer.length > this.envConfig.eventBufferSize) {
  session.eventBuffer.shift();
}
```

And from `stream-parser.ts:38-49`:
```typescript
export function extractTextFromEvents(events: ParsedEvent[], count: number): string[] { ... }
```

#### 3. `answer-parser.ts` -- Decision Parsing

Extracted verbatim from `permission-manager.ts:80-87`:

```typescript
export function parseAnswer(answer: string): { decision: string; reason?: string } {
  const colonIndex = answer.indexOf(":");
  if (colonIndex === -1) return { decision: answer.trim() };
  return {
    decision: answer.slice(0, colonIndex).trim(),
    reason: answer.slice(colonIndex + 1).trim(),
  };
}
```

Used identically in both Claude Code MCP's `translateAnswer()` and Codex MCP's approval response translation.

#### 4. `question-manager.ts` -- Timeout Management

Extracted from `PermissionManager` class (`permission-manager.ts:158-231`), keeping only the connector-agnostic parts:

```typescript
export class QuestionManager {
  private timeoutMs: number;
  private pendingTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Register a pending question with timeout.
   * Returns a promise that resolves when the question is answered or times out.
   */
  register<T>(
    questionId: string,
    onTimeout: () => T,
  ): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolveOuter!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
      resolveOuter = resolve;

      const timeout = setTimeout(() => {
        this.pendingTimeouts.delete(questionId);
        resolve(onTimeout());
      }, this.timeoutMs);

      this.pendingTimeouts.set(questionId, timeout);
    });

    return { promise, resolve: resolveOuter };
  }

  clearTimeout(questionId: string): void {
    const timeout = this.pendingTimeouts.get(questionId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingTimeouts.delete(questionId);
    }
  }

  cleanup(): void {
    for (const timeout of this.pendingTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.pendingTimeouts.clear();
  }
}
```

#### 5. `stream-parser.ts` -- NDJSON Parser

Extracted from `stream-parser.ts:1-11` (the `createStreamParser` function is identical for any NDJSON stream):

```typescript
import split2 from "split2";
import type { Transform } from "node:stream";

export function createNdjsonParser(): Transform {
  return split2(JSON.parse);
}
```

The `parseEvent()` type discrimination stays connector-specific since event shapes differ completely.

#### 6. `mcp-tool-handler.ts` -- Tool Registration Helpers

Reduces boilerplate in MCP server setup. Every tool handler in Claude Code MCP follows this exact pattern:

```typescript
async (args) => {
  try {
    const result = await handler(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
```

Extracted as:

```typescript
export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function wrapToolHandler<T>(
  handler: (args: T) => Promise<unknown> | unknown,
): (args: T) => Promise<ToolResult> {
  return async (args: T) => {
    try {
      const result = await handler(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };
}

export function log(module: string, level: string, message: string): void {
  process.stderr.write(`[${module}] [${level}] ${message}\n`);
}
```

#### 7. `session-base.ts` -- Base Session Utilities

Reusable polling/wait patterns from `session-manager.ts`:

```typescript
import type { ChildProcess } from "node:child_process";

/**
 * Poll until a condition is met or timeout expires.
 */
export function pollUntil(
  check: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const poll = (): void => {
      if (check()) { resolve(true); return; }
      if (Date.now() - startTime > timeoutMs) { resolve(false); return; }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

/**
 * Wait for a process to exit, force-killing after timeout.
 */
export async function waitForProcessExit(
  process: ChildProcess | null,
  timeoutMs: number,
): Promise<void> {
  if (!process) return;
  const exited = await pollUntil(() => process.exitCode !== null || process.killed, timeoutMs);
  if (!exited) {
    try { process.kill("SIGKILL"); } catch { /* ignore */ }
  }
}

/**
 * Count sessions with active processes.
 */
export function countActiveSessions<T extends { process: ChildProcess | null }>(
  sessions: Map<string, T>,
): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.process) count++;
  }
  return count;
}
```

### Impact on Claude Code MCP

After extracting `mcp-base`, Claude Code MCP's source shrinks:

| Module | Before | After | Change |
|---|---|---|---|
| `types.ts` | 165 lines | ~100 lines | Base types moved to mcp-base |
| `stream-parser.ts` | 50 lines | ~30 lines | `createStreamParser` → `createNdjsonParser` import |
| `permission-manager.ts` | 231 lines | ~160 lines | `parseAnswer` + timeout management → mcp-base |
| `session-manager.ts` | 617 lines | ~520 lines | Event buffer, wait patterns → mcp-base |
| `mcp-server.ts` | 347 lines | ~280 lines | `wrapToolHandler` reduces each tool by ~10 lines |
| **Total** | **1786** | **~1460** | **~18% reduction** |

The refactor is backward-compatible -- all public APIs remain unchanged.

---

## Codex MCP Architecture

### High-Level Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  MCP Client (Claude Desktop, AI agent, etc.)                      │
└───────────────────────────┬──────────────────────────────────────┘
                            │ STDIO (JSON-RPC 2.0)
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  Codex MCP Server  (@localrouter/codex)                           │
│                                                                   │
│  ┌────────────────┐  ┌───────────────┐  ┌──────────────────────┐ │
│  │ MCP Server      │  │ Session       │  │ Approval             │ │
│  │ (6 tools)       │  │ Manager       │  │ Manager              │ │
│  │                 │  │               │  │ (elicitation + queue)│ │
│  │ uses:           │  │ uses:         │  │                      │ │
│  │ wrapToolHandler │  │ EventBuffer   │  │ uses:                │ │
│  │ from mcp-base   │  │ pollUntil     │  │ QuestionManager      │ │
│  │                 │  │ from mcp-base │  │ parseAnswer          │ │
│  └────────┬───────┘  └──────┬────────┘  │ from mcp-base        │ │
│           │                 │           └──────────┬───────────┘ │
│           │          ┌──────┴────────┐             │             │
│           │          │ Process       ├─────────────┘             │
│           │          │ Manager       │                           │
│           │          │               │                           │
│           │          │ uses:         │                           │
│           │          │ createNdjson  │                           │
│           │          │ from mcp-base │                           │
│           │          └──────┬────────┘                           │
│           │                 │                                    │
└───────────┼─────────────────┼────────────────────────────────────┘
            │                 │
            │    spawn/resume │  For each turn:
            │                 ▼
            │  ┌──────────────────────────────────────────────────┐
            │  │  codex exec --json "<prompt>"                    │
            │  │    [--ask-for-approval <policy>]                 │
            │  │    [--sandbox <mode>]                            │
            │  │                                                  │
            │  │  stdout ──► JSONL events                         │
            │  │  stderr ──► Approval requests + debug output     │
            │  │  stdin  ◄── Approval responses                   │
            │  └──────────────────────────────────────────────────┘
            │
            └── Tool Results (JSON-RPC responses)
```

### Module Comparison: Claude Code MCP vs Codex MCP

| Module | Claude Code MCP | Codex MCP | Shared via mcp-base |
|---|---|---|---|
| `types.ts` | 165 lines | ~120 lines | Base types (status, question, env config, session) |
| `stream-parser.ts` | 50 lines | ~45 lines | `createNdjsonParser()` |
| `process-manager.ts` | 150 lines | ~130 lines | -- (CLI interfaces differ too much) |
| `session-manager.ts` | 617 lines | ~400 lines | `EventBuffer`, `pollUntil`, `waitForProcessExit`, `countActiveSessions` |
| `permission-manager.ts` | 231 lines | -- | `parseAnswer()`, `QuestionManager` |
| `approval-manager.ts` | -- | ~130 lines | `parseAnswer()`, `QuestionManager` |
| `permission-callback-server.ts` | 87 lines | -- | -- (not needed) |
| `permission-handler-mcp.ts` | 117 lines | -- | -- (not needed) |
| `mcp-server.ts` | 347 lines | ~300 lines | `wrapToolHandler()` |
| `index.ts` | 22 lines | ~22 lines | -- |
| **Total** | **1786 lines** | **~1147 lines** | **~300 lines in mcp-base** |

**Codex MCP is ~36% smaller** because:
- No permission callback server or handler MCP script (204 lines eliminated)
- One process per turn simplifies session management (no bidirectional stdin messaging for active sessions)
- Shared utilities reduce duplication

---

## File Structure

```
packages/
├── mcp-base/                               # NEW: shared library
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                         # Re-exports
│       ├── types.ts                         # Base types
│       ├── event-buffer.ts                  # Ring buffer
│       ├── answer-parser.ts                 # "decision: reason" parsing
│       ├── question-manager.ts              # Timeout-managed question queue
│       ├── stream-parser.ts                 # NDJSON via split2
│       ├── mcp-tool-handler.ts              # wrapToolHandler, log
│       └── session-base.ts                  # pollUntil, waitForProcessExit, countActiveSessions
│
├── codex/                                   # THIS PACKAGE
│   ├── package.json
│   ├── tsconfig.json
│   ├── PLAN.md
│   ├── src/
│   │   ├── index.ts                         # Entry point
│   │   ├── types.ts                         # Codex-specific types (extends mcp-base types)
│   │   ├── stream-parser.ts                 # Codex event type discrimination
│   │   ├── process-manager.ts               # codex exec spawning, approval I/O
│   │   ├── session-manager.ts               # Session lifecycle (uses EventBuffer, pollUntil)
│   │   ├── approval-manager.ts              # Classify approvals, translate answers
│   │   └── mcp-server.ts                    # 6 MCP tools (uses wrapToolHandler)
│   └── test/
│       ├── mock-codex-cli.mjs               # Mock CLI script
│       ├── stream-parser.test.ts
│       ├── process-manager.test.ts
│       ├── session-manager.test.ts
│       ├── approval-manager.test.ts
│       ├── mcp-server.test.ts
│       └── e2e.test.ts
│
└── claude-code-mcp/                         # EXISTING: refactored to use mcp-base
```

---

## MCP Tools

Six tools, mirroring the Claude Code MCP pattern with Codex-specific parameters.

### 1. `codex_start`

```typescript
{
  name: "codex_start",
  inputSchema: {
    prompt:            z.string(),
    workingDirectory:  z.string().optional(),

    // All optional -- CLI defaults apply when omitted
    model:             z.string().optional(),
    approvalPolicy:    z.enum(["untrusted", "on-failure", "on-request", "never"]).optional(),
    sandbox:           z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    fullAuto:          z.boolean().optional(),
    profile:           z.string().optional(),
    config:            z.record(z.string(), z.string()).optional(),
    baseInstructions:  z.string().optional(),
    images:            z.array(z.string()).optional(),
    skipGitRepoCheck:  z.boolean().optional(),
    dangerouslyBypassApprovalsAndSandbox: z.boolean().optional(),
  }
}
```

**Returns:** `{ sessionId: string, status: "active" }`

### 2. `codex_say`

```typescript
{
  name: "codex_say",
  inputSchema: {
    sessionId: z.string(),
    message:   z.string(),
    images:    z.array(z.string()).optional(),
  }
}
```

**Returns:** `{ sessionId: string, status: "active" }`

**Key difference from Claude Code MCP:** Cannot send to a running process. If the current turn is still active, returns an error. The client should poll with `codex_status` until the turn completes, then call `codex_say` which spawns a new `codex exec resume` process.

### 3. `codex_status`

```typescript
{
  name: "codex_status",
  inputSchema: {
    sessionId:   z.string(),
    outputLines: z.number().optional(),  // default: 50
  }
}
```

**Returns:**
```typescript
{
  sessionId: string,
  status: "active" | "awaiting_approval" | "done" | "error" | "interrupted",
  result?: string,
  recentOutput: string[],
  pendingQuestion?: {
    id: string,
    type: "command_approval" | "patch_approval",
    questions: Array<{ question: string, options: string[] }>,
  },
  itemEvents: Array<{
    itemType: string,
    status: "started" | "in_progress" | "completed" | "failed",
    summary?: string,
  }>,
  usage?: { inputTokens?: number, cachedInputTokens?: number, outputTokens?: number },
  turnCount?: number,
}
```

### 4. `codex_respond`

```typescript
{
  name: "codex_respond",
  inputSchema: {
    sessionId: z.string(),
    id:        z.string(),
    answers:   z.array(z.string()),  // e.g. ["approve"] or ["deny: too risky"]
  }
}
```

**Returns:** `{ sessionId: string, status: "active" | "awaiting_approval" }`

### 5. `codex_interrupt`

```typescript
{
  name: "codex_interrupt",
  inputSchema: {
    sessionId: z.string(),
  }
}
```

**Returns:** `{ sessionId: string, status: "interrupted" }`

### 6. `codex_list`

```typescript
{
  name: "codex_list",
  inputSchema: {
    workingDirectory: z.string().optional(),
    limit:            z.number().optional(),  // default: 50
  }
}
```

**Returns:**
```typescript
{
  sessions: Array<{
    sessionId: string,
    directory?: string,
    summary?: string,
    timestamp: string,
    isActive: boolean,
    activeStatus?: string,
  }>
}
```

---

## Core Modules (Codex-Specific)

### Module 1: `types.ts` -- Codex-Specific Types

Extends base types from `@localrouter/mcp-base`:

```typescript
import type { BaseSession, BaseEnvConfig, BasePendingQuestion } from "@localrouter/mcp-base";

// Codex-specific session status
export type SessionStatus =
  | "active"
  | "awaiting_approval"
  | "done"
  | "error"
  | "interrupted";

// Approval types
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalType = "command_approval" | "patch_approval";

// Spawn configuration
export interface SpawnConfig {
  prompt: string;
  workingDirectory?: string;
  resumeSessionId?: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  fullAuto?: boolean;
  profile?: string;
  config?: Record<string, string>;
  baseInstructions?: string;
  images?: string[];
  skipGitRepoCheck?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
}

// Session config (stored for re-spawning on resume)
export interface SessionConfig {
  workingDirectory: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  fullAuto?: boolean;
  profile?: string;
  config?: Record<string, string>;
  baseInstructions?: string;
  images?: string[];
  skipGitRepoCheck?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
}

// Codex JSONL event types
export interface ThreadStartedEvent { type: "thread.started"; thread_id: string; }
export interface TurnStartedEvent { type: "turn.started"; }
export interface TurnCompletedEvent {
  type: "turn.completed";
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; };
}
export interface TurnFailedEvent { type: "turn.failed"; error?: string; }
export interface ItemStartedEvent {
  type: "item.started";
  item: { id: string; type: ItemType; [key: string]: unknown; };
}
export interface ItemUpdatedEvent {
  type: "item.updated";
  item: { id: string; type: ItemType; [key: string]: unknown; };
}
export interface ItemCompletedEvent {
  type: "item.completed";
  item: {
    id: string; type: ItemType; text?: string; command?: string;
    changes?: unknown[]; server?: string; tool?: string; status?: string;
    [key: string]: unknown;
  };
}
export interface StreamErrorEvent { type: "error"; message: string; }

export type ItemType =
  | "agent_message" | "reasoning" | "command_execution" | "file_change"
  | "mcp_tool_call" | "web_search" | "todo_list" | "error" | "unknown";

export type CodexEvent =
  | ThreadStartedEvent | TurnStartedEvent | TurnCompletedEvent | TurnFailedEvent
  | ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent | StreamErrorEvent;

// Item tracking for status
export interface ItemEvent {
  itemType: string;
  status: "started" | "in_progress" | "completed" | "failed";
  summary?: string;
}

// Session state
export interface Session extends BaseSession<CodexEvent, SessionStatus> {
  config: SessionConfig;
  itemEvents: Map<string, ItemEvent>;
  usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; };
  turnCount: number;
}

// Environment config
export interface EnvConfig extends BaseEnvConfig {
  codexHome: string;  // $CODEX_HOME for session discovery
}

// Pending question (extends base)
export interface PendingQuestion extends BasePendingQuestion {
  type: ApprovalType;
  resolve: (response: ApprovalResponse) => void;
}

export interface ApprovalResponse {
  approved: boolean;
  reason?: string;
}
```

### Module 2: `stream-parser.ts` -- Event Type Discrimination

Uses `createNdjsonParser()` from mcp-base, adds Codex-specific event typing:

```typescript
import { createNdjsonParser } from "@localrouter/mcp-base";
import type { CodexEvent } from "./types.js";

export { createNdjsonParser };

const KNOWN_TYPES = new Set([
  "thread.started", "turn.started", "turn.completed", "turn.failed",
  "item.started", "item.updated", "item.completed", "error",
]);

export function parseEvent(data: unknown): CodexEvent {
  if (typeof data !== "object" || data === null || !("type" in data)) {
    return { type: "error", message: `Unparseable event: ${JSON.stringify(data)}` };
  }
  const obj = data as Record<string, unknown>;
  if (KNOWN_TYPES.has(obj.type as string)) {
    return obj as unknown as CodexEvent;
  }
  return { type: "error", message: `Unknown event type: ${obj.type}` };
}

export function extractTextFromEvents(events: CodexEvent[], count: number): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      event.item?.text
    ) {
      texts.push(event.item.text);
    }
  }
  return texts.slice(-count);
}
```

### Module 3: `process-manager.ts` -- Codex CLI Process

Spawns `codex exec` processes. Key difference from Claude Code MCP: **no bidirectional messaging** during a turn. Each turn is a separate process. Approval I/O happens via stderr/stdin.

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { createNdjsonParser } from "@localrouter/mcp-base";
import { parseEvent } from "./stream-parser.js";
import type { SpawnConfig, CodexEvent, EnvConfig, ApprovalResponse } from "./types.js";

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
    parser.on("error", (err: Error) => log("warn", `Stream parse error: ${err.message}`));
  }

  // Monitor stderr for approval requests and debug output
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (isApprovalRequest(text)) {
        onApprovalRequest(text);
      } else {
        log("debug", `[codex stderr] ${text}`);
      }
    });
  }

  child.on("exit", (code, signal) => onExit(code, signal));
  child.on("error", (err) => { log("error", `Process error: ${err.message}`); onExit(1, null); });

  return child;
}

export function sendApprovalResponse(child: ChildProcess, response: ApprovalResponse): void {
  if (!child.stdin || child.stdin.destroyed) {
    throw new Error("Process stdin is not available");
  }
  // Format TBD -- depends on actual codex exec approval I/O protocol
  const payload = response.approved ? "y\n" : "n\n";
  child.stdin.write(payload);
}

export function interruptProcess(child: ChildProcess): void {
  child.kill("SIGINT");
}

function isApprovalRequest(text: string): boolean {
  // Heuristic -- exact pattern depends on codex exec behavior
  return /\b(allow|approve|apply|permit)\b.*\?/i.test(text);
}

function log(level: string, message: string): void {
  process.stderr.write(`[process-manager] [${level}] ${message}\n`);
}
```

**Open question:** The exact mechanism by which `codex exec --json` surfaces approval requests is not fully documented for non-interactive use. The `isApprovalRequest` heuristic and `sendApprovalResponse` format will need to be validated against the actual CLI behavior in Phase 2. See "Open Questions" section.

### Module 4: `approval-manager.ts` -- Approval Handling

Much simpler than Claude Code MCP's `permission-manager.ts` because no HTTP callback bridge is needed.

```typescript
import { parseAnswer, QuestionManager } from "@localrouter/mcp-base";
import type { PendingQuestion, ApprovalType, ApprovalResponse } from "./types.js";

export { parseAnswer };

export function classifyApproval(requestText: string): ApprovalType {
  if (/\b(patch|file|change|modify|write|create|delete)\b/i.test(requestText)) {
    return "patch_approval";
  }
  return "command_approval";
}

export function buildQuestion(
  requestText: string,
  requestId: string,
): Omit<PendingQuestion, "resolve"> {
  const type = classifyApproval(requestText);
  return {
    id: requestId,
    type,
    questions: [{
      question: requestText,
      options: ["approve", "deny"],
    }],
  };
}

export function translateAnswer(answers: string[]): ApprovalResponse {
  const { decision, reason } = parseAnswer(answers[0] || "deny");
  return {
    approved: decision === "approve" || decision === "allow" || decision === "yes",
    reason,
  };
}
```

**Comparison with Claude Code MCP's `permission-manager.ts`:**
- No `PermissionManager` class (timeout management delegated to `QuestionManager` from mcp-base)
- No `PermissionResponse` with `behavior`/`updatedInput` (Codex just needs approve/deny)
- No `summarizeInput` (approval text comes from the CLI itself)
- 3 functions vs 5 functions + 1 class

### Module 5: `session-manager.ts` -- Session Lifecycle

Follows the same structure as Claude Code MCP but is simpler:

```typescript
import {
  EventBuffer, pollUntil, waitForProcessExit, countActiveSessions, QuestionManager,
} from "@localrouter/mcp-base";
import { spawnCodexProcess, sendApprovalResponse, interruptProcess } from "./process-manager.js";
import { extractTextFromEvents } from "./stream-parser.js";
import { buildQuestion, translateAnswer } from "./approval-manager.js";
import type {
  Session, SessionStatus, SessionConfig, SpawnConfig, CodexEvent,
  EnvConfig, PendingQuestion, ItemEvent,
} from "./types.js";
```

**Key behavioral differences from Claude Code MCP's SessionManager:**

1. **`sayToSession`**: Cannot send to a running process. Returns error if process is active. When process is dead, spawns `codex exec resume <sessionId>`.

2. **No permission callback server**: Approvals arrive via the `onApprovalRequest` callback in `spawnCodexProcess`, not via HTTP. The callback directly creates a `PendingQuestion`.

3. **Event handling**: Handles `thread.started` (→ session ID), `turn.completed` (→ done + usage), `turn.failed` (→ error), and `item.*` events (→ item tracking). No `stream_event` wrapper -- Codex events are top-level.

4. **Session discovery**: Scans `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` instead of reading `~/.claude/history.jsonl`. Uses recursive directory scanning.

### Module 6: `mcp-server.ts` -- MCP Server

Uses `wrapToolHandler` from mcp-base to reduce boilerplate:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapToolHandler, log } from "@localrouter/mcp-base";
import { SessionManager } from "./session-manager.js";
import type { EnvConfig } from "./types.js";

export function createMcpServer(envConfig: EnvConfig) {
  const sessionManager = new SessionManager(envConfig);
  const mcpServer = new McpServer(
    { name: "codex-mcp", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false }, logging: {} } },
  );

  mcpServer.registerTool("codex_start", {
    description: "Start a new Codex CLI session with an initial prompt",
    inputSchema: { /* ... zod schemas ... */ },
  }, wrapToolHandler((args) => sessionManager.startSession(args)));

  // ... remaining 5 tools follow same pattern ...

  return { mcpServer, sessionManager };
}
```

Each tool registration is ~15 lines instead of ~30 lines in Claude Code MCP.

---

## Session Lifecycle

### State Machine

```
                      codex_start
                           │
                           ▼
                    ┌──────────┐
        ┌──────────│  ACTIVE   │◄──────────────────────┐
        │          └─────┬─────┘                        │
        │                │                              │
        │   approval     │           codex_respond      │
        │   requested    │                              │
        │                ▼                              │
        │   ┌────────────────────────┐                  │
        │   │  AWAITING_APPROVAL     │──────────────────┘
        │   └────────────────────────┘
        │
        │  interrupt / turn completes / error
        │                ┌──────────────┐   codex_say
        ├───────────────►│ INTERRUPTED  │──────────────►  ACTIVE
        │                │ DONE         │   (new process)
        │                │ ERROR        │
        │                └──────────────┘
```

**Process model comparison:**

Codex (one process per turn):
```
codex_start  →  spawn codex exec --json "prompt"          →  process exits (DONE)
codex_say    →  spawn codex exec resume <id> --json "msg"  →  process exits (DONE)
codex_say    →  spawn codex exec resume <id> --json "msg"  →  process exits (DONE)
```

Claude Code (persistent process):
```
claude_start →  spawn claude -p "prompt" --stream-json     →  process stays alive
claude_say   →  write to stdin                             →  process continues
claude_say   →  write to stdin                             →  process continues
```

---

## Approval Flow Detail

### Flow A: No Approvals (`approvalPolicy: "never"`)

No approval flow needed. `codex exec` auto-approves everything.

### Flow B: Approvals with Elicitation

```
MCP Client               Codex MCP Server              codex exec process
    │                          │                            │
    │                          │     approval prompt on     │
    │                          │     stderr                 │
    │                          │◄───────────────────────────│
    │                          │                            │
    │  MCP elicitation         │                            │
    │  "Codex wants to run:    │                            │
    │   npm test"              │                            │
    │  options: approve/deny   │                            │
    │◄─────────────────────────│                            │
    │                          │                            │
    │  { action: "accept",     │                            │
    │    content: "approve" }  │                            │
    │─────────────────────────►│  writes "y\n" to stdin     │
    │                          │───────────────────────────►│
    │                          │                            │ continues
```

### Flow C: Approvals with Polling (no elicitation)

```
MCP Client               Codex MCP Server              codex exec process
    │                          │                            │
    │                          │     approval prompt        │
    │                          │◄───────────────────────────│
    │                          │  (queues pendingQuestion)  │
    │                          │                            │
    │  codex_status            │                            │
    │─────────────────────────►│                            │
    │  { status:               │                            │
    │    awaiting_approval,    │                            │
    │    pendingQuestion: {..} │                            │
    │  }                       │                            │
    │◄─────────────────────────│                            │
    │                          │                            │
    │  codex_respond           │                            │
    │  { answers: ["approve"]} │                            │
    │─────────────────────────►│  writes response to stdin  │
    │                          │───────────────────────────►│
    │  { status: "active" }    │                            │
    │◄─────────────────────────│                            │ continues
```

---

## Session Discovery

Scans `$CODEX_HOME/sessions/` directory tree for session JSONL files.

```typescript
// Directory structure:
// $CODEX_HOME/sessions/
//   2025/
//     01/
//       15/
//         rollout-abc123.jsonl
//         rollout-def456.jsonl

function discoverSessions(codexHome: string): SessionEntry[] {
  const sessionsDir = path.join(codexHome, "sessions");
  // Recursive scan for *.jsonl files
  // Parse first line of each for thread.started event → extract thread_id, timestamp
  // Return sorted by timestamp descending
}
```

**Difference from Claude Code MCP:** Claude Code reads a single flat file (`~/.claude/history.jsonl`). Codex sessions are spread across a date-based directory tree, requiring recursive scanning.

---

## Dependencies

```json
{
  "dependencies": {
    "@localrouter/mcp-base": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.26.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "typescript": "^5.9",
    "vitest": "^3.x",
    "@types/node": "^25.x"
  }
}
```

**Notable:** No direct `split2` dependency -- it comes transitively through `@localrouter/mcp-base`.

---

## Testing Strategy

### Mock CLI (`test/mock-codex-cli.mjs`)

Simulates `codex exec --json` behavior:

```javascript
// Environment controls:
// MOCK_THREAD_ID        - Thread ID (default: mock-thread-<timestamp>)
// MOCK_DELAY_MS         - Delay between events (default: 10ms)
// MOCK_RESULT           - Agent message text (default: "Mock result")
// MOCK_ERROR            - If "true", emit turn.failed
// MOCK_APPROVAL         - If "true", emit approval request on stderr, wait for stdin
// MOCK_ITEMS            - Comma-separated item types to emit (default: "agent_message")
// MOCK_USAGE            - JSON string of usage object

// Behavior:
// 1. Emit thread.started with thread_id
// 2. Emit turn.started
// 3. Emit item.started/updated/completed for each MOCK_ITEMS entry
// 4. If MOCK_APPROVAL: write approval prompt to stderr, block on stdin
// 5. Emit turn.completed (or turn.failed if MOCK_ERROR)
// 6. SIGINT handler: exit cleanly
```

### Test Files

| Test File | Tests | Coverage |
|---|---|---|
| `stream-parser.test.ts` | ~15 | All event types, unknown types, malformed JSON |
| `process-manager.test.ts` | ~14 | Spawn with flags, approval I/O, interrupt, resume |
| `session-manager.test.ts` | ~20 | Lifecycle, state transitions, auto-resume, discovery |
| `approval-manager.test.ts` | ~12 | Classify, build question, translate answers |
| `mcp-server.test.ts` | ~9 | Tool registration, error handling |
| `e2e.test.ts` | ~5 | Gated by `CODEX_E2E=true` |
| **Total** | **~75** | |

---

## Implementation Phases

### Phase 0: Shared Library Extraction (prerequisite)
- [ ] Create `packages/mcp-base/` package structure
- [ ] Extract `EventBuffer` from Claude Code MCP's inline pattern
- [ ] Extract `parseAnswer` from `permission-manager.ts`
- [ ] Extract `QuestionManager` from `PermissionManager` class
- [ ] Extract `createNdjsonParser` from `stream-parser.ts`
- [ ] Extract `wrapToolHandler` and `log` helper
- [ ] Extract `pollUntil`, `waitForProcessExit`, `countActiveSessions` from `session-manager.ts`
- [ ] Define base types (`BaseSession`, `BaseEnvConfig`, `BasePendingQuestion`, `QuestionItem`)
- [ ] Write tests for mcp-base (EventBuffer, parseAnswer, QuestionManager, pollUntil)
- [ ] Refactor Claude Code MCP to import from `@localrouter/mcp-base`
- [ ] Verify all existing Claude Code MCP tests still pass

### Phase 1: Foundation
- [ ] Set up `packages/codex/` with dependencies on `@localrouter/mcp-base`
- [ ] Implement `types.ts` (Codex-specific types extending base)
- [ ] Implement `stream-parser.ts` (event type discrimination for Codex events)
- [ ] Write `stream-parser.test.ts`
- [ ] Create `mock-codex-cli.mjs`

### Phase 2: Process Management
- [ ] Implement `process-manager.ts` (spawn `codex exec`, parse JSONL, approval I/O)
- [ ] **Validate approval request detection** against real `codex exec` behavior
- [ ] Write `process-manager.test.ts` using mock CLI
- [ ] Verify resume spawning works correctly

### Phase 3: Session Management + Approval
- [ ] Implement `approval-manager.ts` (classify, build question, translate)
- [ ] Write `approval-manager.test.ts`
- [ ] Implement `session-manager.ts` (lifecycle, state machine, event buffer, discovery)
- [ ] Implement session discovery (scan `$CODEX_HOME/sessions/`)
- [ ] Write `session-manager.test.ts`

### Phase 4: MCP Server & Integration
- [ ] Implement `mcp-server.ts` with all 6 tools using `wrapToolHandler`
- [ ] Implement `index.ts` entry point
- [ ] Write `mcp-server.test.ts`
- [ ] Write E2E test skeleton

### Phase 5: Polish
- [ ] Handle edge cases (concurrent sessions, rapid start/interrupt, process leaks)
- [ ] Graceful shutdown (kill all child processes)
- [ ] Verify full test suite passes
- [ ] Build and verify end-to-end

---

## Configuration

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
        "LOG_LEVEL": "info",
        "EVENT_BUFFER_SIZE": "500"
      }
    }
  }
}
```

---

## Open Questions & Risks

### 1. Approval Request Detection (HIGH PRIORITY)

The exact mechanism by which `codex exec --json` surfaces approval requests in non-interactive mode is not fully documented. Possibilities:
- **Stderr text patterns**: The CLI writes human-readable prompts to stderr
- **Special JSONL events**: Approval requests appear as structured events on stdout
- **Process blocking**: The process simply blocks until stdin is written to

This needs to be validated in Phase 2 by testing against a real Codex CLI. The `isApprovalRequest` heuristic and `sendApprovalResponse` format may need significant adjustment. If approvals appear as structured JSONL events rather than stderr text, the architecture simplifies further.

### 2. Session Directory Format

`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` is not a documented public API. Parse defensively.

### 3. `codex exec --json` Event Schema Stability

The JSONL schema has changed between versions (e.g., `item_type` → `type`, `assistant_message` → `agent_message`). Parse defensively.

### 4. Image Flag Bug

Known Codex issue (#5773) where `--json` hangs when `--image` flag is used. May need workaround.

### 5. No Bidirectional Streaming

Unlike Claude Code, we can't send messages to a running `codex exec` process mid-turn. Each follow-up requires a new process. This adds latency but simplifies architecture.

### Future: `codex app-server` Integration

`codex app-server` (JSON-RPC over stdio) offers richer interactive support with native approval handling. Could replace the `codex exec` approach in a future version.

---

## Appendix: Code Reuse Summary

| Component | Source | Used By |
|---|---|---|
| `EventBuffer<T>` | mcp-base | Both connectors' session managers |
| `parseAnswer()` | mcp-base | Both connectors' approval/permission managers |
| `QuestionManager` | mcp-base | Both connectors for timeout management |
| `createNdjsonParser()` | mcp-base | Both connectors' stream parsers |
| `wrapToolHandler()` | mcp-base | Both connectors' MCP servers |
| `pollUntil()` | mcp-base | Both connectors' session managers |
| `waitForProcessExit()` | mcp-base | Both connectors' session managers |
| `countActiveSessions()` | mcp-base | Both connectors' session managers |
| `log()` | mcp-base | All modules |
| `BaseSession<T>` | mcp-base | Both connectors extend for their session types |
| `BaseEnvConfig` | mcp-base | Both connectors extend for their env config |
| `BasePendingQuestion` | mcp-base | Both connectors extend for their question types |

**Estimated shared code: ~300 lines in mcp-base, saving ~18% in Claude Code MCP and providing ~30% of Codex MCP's foundation.**
