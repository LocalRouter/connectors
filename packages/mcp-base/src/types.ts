import type { ChildProcess } from "node:child_process";

// --- Session Status ---

export type BaseSessionStatus =
  | "active"
  | "awaiting_input"
  | "done"
  | "error"
  | "interrupted";

// --- Question Model ---

export interface QuestionItem {
  question: string;
  options: string[];
}

export interface BasePendingQuestion {
  id: string;
  type: string;
  questions: QuestionItem[];
  resolve: (response: unknown) => void;
}

// --- Environment Config ---

export interface BaseEnvConfig {
  cliPath: string;
  approvalTimeoutMs: number;
  maxSessions: number;
  logLevel: string;
  eventBufferSize: number;
}

// --- Base Session ---

export interface BaseSession<TEvent, TStatus extends string = BaseSessionStatus> {
  id: string;
  status: TStatus;
  process: ChildProcess | null;
  createdAt: Date;
  workingDirectory: string;
  config: Record<string, unknown>;
  pendingQuestion: BasePendingQuestion | null;
  result?: string;
  error?: string;
}
