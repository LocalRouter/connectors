import type { ChildProcess } from "node:child_process";
import type { BaseEnvConfig, BasePendingQuestion } from "@localrouter/mcp-base";
import type { EventBuffer } from "@localrouter/mcp-base";

// --- Session Status ---

export type SessionStatus =
  | "active"
  | "awaiting_approval"
  | "done"
  | "error"
  | "interrupted";

// --- Approval Types ---

export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalType = "command_approval" | "patch_approval";

// --- Spawn Configuration ---

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

// --- Session Configuration (stored for re-spawning on resume) ---

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

// --- Codex JSONL Event Types ---

export interface ThreadStartedEvent {
  type: "thread.started";
  thread_id: string;
}

export interface TurnStartedEvent {
  type: "turn.started";
}

export interface TurnCompletedEvent {
  type: "turn.completed";
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

export interface TurnFailedEvent {
  type: "turn.failed";
  error?: string;
}

export interface ItemStartedEvent {
  type: "item.started";
  item: {
    id: string;
    type: ItemType;
    [key: string]: unknown;
  };
}

export interface ItemUpdatedEvent {
  type: "item.updated";
  item: {
    id: string;
    type: ItemType;
    [key: string]: unknown;
  };
}

export interface ItemCompletedEvent {
  type: "item.completed";
  item: {
    id: string;
    type: ItemType;
    text?: string;
    command?: string;
    changes?: unknown[];
    server?: string;
    tool?: string;
    status?: string;
    [key: string]: unknown;
  };
}

export interface StreamErrorEvent {
  type: "error";
  message: string;
}

export type ItemType =
  | "agent_message"
  | "reasoning"
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "web_search"
  | "todo_list"
  | "error"
  | "unknown";

export type CodexEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | StreamErrorEvent;

// --- Item Tracking ---

export interface ItemEvent {
  itemType: string;
  status: "started" | "in_progress" | "completed" | "failed";
  summary?: string;
}

// --- Approval Response ---

export interface ApprovalResponse {
  approved: boolean;
  reason?: string;
}

// --- Pending Question ---

export interface PendingQuestion extends Omit<BasePendingQuestion, "resolve"> {
  type: ApprovalType;
  resolve: (response: ApprovalResponse) => void;
}

// --- Session State ---

export interface Session {
  id: string;
  status: SessionStatus;
  process: ChildProcess | null;
  createdAt: Date;
  workingDirectory: string;
  config: SessionConfig;
  eventBuffer: EventBuffer<CodexEvent>;
  pendingQuestion: PendingQuestion | null;
  result?: string;
  error?: string;
  itemEvents: Map<string, ItemEvent>;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  };
  turnCount: number;
}

// --- Environment Configuration ---

export interface EnvConfig extends BaseEnvConfig {
  codexHome: string;
}
