import type { ChildProcess } from "node:child_process";

// --- Session Status ---

export type SessionStatus =
  | "active"
  | "awaiting_input"
  | "done"
  | "error"
  | "interrupted";

// --- Permission Mode ---

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

// --- Question Classification ---

export type QuestionType = "tool_approval" | "plan_approval" | "question";

export interface QuestionItem {
  question: string;
  options: string[];
}

export interface PendingQuestion {
  id: string;
  type: QuestionType;
  questions: QuestionItem[];
  toolName: string;
  toolInput: Record<string, unknown>;
  resolve: (response: PermissionResponse) => void;
}

// --- Permission Response ---

export interface PermissionResponse {
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
}

// --- Spawn Configuration ---

export interface SpawnConfig {
  prompt: string;
  workingDirectory?: string;
  resumeSessionId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  dangerouslySkipPermissions?: boolean;
  permissionCallbackPort: number;
}

// --- Session Configuration (stored for re-spawning on resume) ---

export interface SessionConfig {
  workingDirectory: string;
  model?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  dangerouslySkipPermissions?: boolean;
}

// --- Tool Use Tracking ---

export interface ToolUseEvent {
  toolName: string;
  status: "running" | "completed" | "denied";
}

// --- CLI Stream Events ---

export interface InitEvent {
  type: "init";
  session_id: string;
  timestamp: string;
}

export interface StreamEvent {
  type: "stream_event";
  event: {
    type: string;
    delta?: { type: string; text?: string };
    content_block?: { type: string; name?: string; id?: string };
    index?: number;
  };
}

export interface ResultEvent {
  type: "result";
  status: "success" | "error" | "interrupted";
  result?: string;
  session_id: string;
  cost_usd?: number;
  duration_ms?: number;
  turns?: number;
}

export interface UnknownEvent {
  type: string;
  [key: string]: unknown;
}

export type ParsedEvent = InitEvent | StreamEvent | ResultEvent | UnknownEvent;

// --- Session State ---

export interface Session {
  id: string;
  status: SessionStatus;
  process: ChildProcess | null;
  createdAt: Date;
  workingDirectory: string;
  config: SessionConfig;
  eventBuffer: ParsedEvent[];
  pendingQuestion: PendingQuestion | null;
  result?: string;
  error?: string;
  costUsd?: number;
  turnCount?: number;
  toolUseEvents: ToolUseEvent[];
}

// --- History ---

export interface HistoryEntry {
  timestamp: string;
  project?: string;
  display?: string;
  session_id?: string;
  [key: string]: unknown;
}

// --- Environment Configuration ---

export interface EnvConfig {
  claudeCodePath: string;
  permissionTimeoutMs: number;
  maxSessions: number;
  logLevel: string;
  eventBufferSize: number;
}

// --- Permission Callback ---

export interface PermissionCallbackRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
}
