import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  EventBuffer,
  pollUntil,
  waitForProcessExit,
  countActiveSessions,
  QuestionManager,
  log,
} from "@localrouter/mcp-base";
import { spawnCodexProcess, sendApprovalResponse, interruptProcess } from "./process-manager.js";
import { extractTextFromEvents } from "./stream-parser.js";
import { buildQuestion, translateAnswer } from "./approval-manager.js";
import type {
  Session,
  SessionStatus,
  SessionConfig,
  SpawnConfig,
  CodexEvent,
  EnvConfig,
  PendingQuestion,
  ItemEvent,
  ApprovalResponse,
} from "./types.js";

/**
 * Manages the full lifecycle of Codex sessions:
 * creation, messaging, status queries, approval handling, interruption, and listing.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private questionManager: QuestionManager;
  private envConfig: EnvConfig;

  constructor(envConfig: EnvConfig) {
    this.envConfig = envConfig;
    this.questionManager = new QuestionManager(envConfig.approvalTimeoutMs);
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.process) {
        try {
          session.process.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
    this.questionManager.cleanup();
  }

  // --- Tool Handlers ---

  async startSession(params: {
    prompt: string;
    workingDirectory?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    fullAuto?: boolean;
    profile?: string;
    config?: Record<string, string>;
    baseInstructions?: string;
    images?: string[];
    skipGitRepoCheck?: boolean;
    dangerouslyBypassApprovalsAndSandbox?: boolean;
  }): Promise<{ sessionId: string; status: SessionStatus }> {
    if (countActiveSessions(this.sessions) >= this.envConfig.maxSessions) {
      throw new Error(
        `Maximum concurrent sessions (${this.envConfig.maxSessions}) reached`,
      );
    }

    const workingDirectory = params.workingDirectory || process.cwd();
    const config: SessionConfig = {
      workingDirectory,
      model: params.model,
      approvalPolicy: params.approvalPolicy as SessionConfig["approvalPolicy"],
      sandbox: params.sandbox as SessionConfig["sandbox"],
      fullAuto: params.fullAuto,
      profile: params.profile,
      config: params.config,
      baseInstructions: params.baseInstructions,
      images: params.images,
      skipGitRepoCheck: params.skipGitRepoCheck,
      dangerouslyBypassApprovalsAndSandbox: params.dangerouslyBypassApprovalsAndSandbox,
    };

    // Temporary ID until the thread.started event gives us the real session ID
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const session: Session = {
      id: tempId,
      status: "active",
      process: null,
      createdAt: new Date(),
      workingDirectory,
      config,
      eventBuffer: new EventBuffer<CodexEvent>(this.envConfig.eventBufferSize),
      pendingQuestion: null,
      itemEvents: new Map(),
      turnCount: 0,
    };

    this.sessions.set(tempId, session);

    const spawnConfig: SpawnConfig = {
      prompt: params.prompt,
      workingDirectory,
      model: params.model,
      approvalPolicy: config.approvalPolicy,
      sandbox: config.sandbox,
      fullAuto: params.fullAuto,
      profile: params.profile,
      config: params.config,
      baseInstructions: params.baseInstructions,
      images: params.images,
      skipGitRepoCheck: params.skipGitRepoCheck,
      dangerouslyBypassApprovalsAndSandbox: params.dangerouslyBypassApprovalsAndSandbox,
    };

    const child = spawnCodexProcess(
      spawnConfig,
      this.envConfig,
      (event) => this.handleEvent(session, event),
      (request) => this.handleApprovalRequest(session, request),
      (code, signal) => this.handleExit(session, code, signal),
    );

    session.process = child;

    // Wait briefly for the thread.started event to capture the real session ID
    await pollUntil(() => !session.id.startsWith("temp_"), 10000);

    return { sessionId: session.id, status: "active" };
  }

  async sayToSession(params: {
    sessionId: string;
    message: string;
    images?: string[];
  }): Promise<{ sessionId: string; status: SessionStatus }> {
    let session = this.sessions.get(params.sessionId);

    if (!session) {
      session = this.createTrackedSession(params.sessionId);
    }

    // Cannot send to a running process -- Codex uses one process per turn
    if (session.process && session.status === "active") {
      throw new Error(
        `Session ${params.sessionId} is still processing. Wait for it to complete or interrupt it first.`,
      );
    }

    // Spawn a new resume process
    await this.resumeSession(session, params.message, params.images);

    return { sessionId: session.id, status: session.status };
  }

  getSessionStatus(
    sessionId: string,
    outputLines = 50,
  ): {
    sessionId: string;
    status: SessionStatus;
    result?: string;
    recentOutput: string[];
    pendingQuestion?: {
      id: string;
      type: string;
      questions: Array<{ question: string; options: string[] }>;
    };
    itemEvents: ItemEvent[];
    usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };
    turnCount?: number;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const recentOutput = extractTextFromEvents(
      session.eventBuffer.getAll(),
      outputLines,
    );

    const result: {
      sessionId: string;
      status: SessionStatus;
      result?: string;
      recentOutput: string[];
      pendingQuestion?: {
        id: string;
        type: string;
        questions: Array<{ question: string; options: string[] }>;
      };
      itemEvents: ItemEvent[];
      usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };
      turnCount?: number;
    } = {
      sessionId: session.id,
      status: session.status,
      recentOutput,
      itemEvents: Array.from(session.itemEvents.values()),
    };

    if (session.result) result.result = session.result;
    if (session.usage) result.usage = session.usage;
    if (session.turnCount > 0) result.turnCount = session.turnCount;

    if (session.pendingQuestion && session.status === "awaiting_approval") {
      result.pendingQuestion = {
        id: session.pendingQuestion.id,
        type: session.pendingQuestion.type,
        questions: session.pendingQuestion.questions,
      };
    }

    return result;
  }

  respondToQuestion(params: {
    sessionId: string;
    id: string;
    answers: string[];
  }): { sessionId: string; status: SessionStatus } {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    if (!session.pendingQuestion) {
      throw new Error(`No pending question for session: ${params.sessionId}`);
    }

    if (session.pendingQuestion.id !== params.id) {
      throw new Error(
        `Question ID mismatch. Expected: ${session.pendingQuestion.id}, got: ${params.id}`,
      );
    }

    const response = translateAnswer(params.answers);

    // Clear timeout
    this.questionManager.clearTimeout(params.id);

    // Send response to CLI process
    if (session.process) {
      sendApprovalResponse(session.process, response);
    }

    // Resolve the pending question
    session.pendingQuestion.resolve(response);
    session.pendingQuestion = null;
    session.status = "active";

    return { sessionId: session.id, status: session.status };
  }

  interruptSession(
    sessionId: string,
  ): { sessionId: string; status: SessionStatus } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    if (!session.process) {
      throw new Error(`Session ${sessionId} has no active process`);
    }

    interruptProcess(session.process);
    session.status = "interrupted";
    return { sessionId: session.id, status: "interrupted" };
  }

  listSessions(params?: {
    workingDirectory?: string;
    limit?: number;
  }): {
    sessions: Array<{
      sessionId: string;
      directory?: string;
      summary?: string;
      timestamp: string;
      isActive: boolean;
      activeStatus?: SessionStatus;
    }>;
  } {
    const limit = params?.limit || 50;

    const entries: Array<{
      sessionId: string;
      directory?: string;
      summary?: string;
      timestamp: string;
    }> = [];

    // Scan $CODEX_HOME/sessions/ for session files
    const sessionsDir = path.join(this.envConfig.codexHome, "sessions");
    try {
      this.scanSessionDirectory(sessionsDir, entries, params?.workingDirectory);
    } catch {
      // Directory doesn't exist or isn't readable
    }

    // Include any active sessions not already discovered
    for (const session of this.sessions.values()) {
      if (!session.id.startsWith("temp_")) {
        const exists = entries.some((e) => e.sessionId === session.id);
        if (!exists) {
          if (
            params?.workingDirectory &&
            session.workingDirectory !== params.workingDirectory
          ) {
            continue;
          }
          entries.push({
            sessionId: session.id,
            directory: session.workingDirectory,
            timestamp: session.createdAt.toISOString(),
          });
        }
      }
    }

    // Sort by timestamp descending
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // Apply limit and annotate with active status
    const result = entries.slice(0, limit).map((entry) => {
      const activeSession = this.sessions.get(entry.sessionId);
      const isActive = activeSession?.process != null;
      return {
        ...entry,
        isActive,
        activeStatus: activeSession?.status,
      };
    });

    return { sessions: result };
  }

  // --- Private ---

  private handleEvent(session: Session, event: CodexEvent): void {
    session.eventBuffer.push(event);

    switch (event.type) {
      case "thread.started": {
        const oldId = session.id;
        const newId = event.thread_id;
        if (oldId !== newId) {
          this.sessions.delete(oldId);
          session.id = newId;
          this.sessions.set(newId, session);
        }
        break;
      }

      case "turn.started":
        session.turnCount++;
        break;

      case "turn.completed":
        session.status = "done";
        if (event.usage) {
          session.usage = {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            outputTokens: event.usage.output_tokens,
          };
        }
        break;

      case "turn.failed":
        session.status = "error";
        session.error = event.error || "Turn failed";
        break;

      case "item.started":
        session.itemEvents.set(event.item.id, {
          itemType: event.item.type,
          status: "started",
        });
        break;

      case "item.updated":
        if (session.itemEvents.has(event.item.id)) {
          session.itemEvents.get(event.item.id)!.status = "in_progress";
        }
        break;

      case "item.completed": {
        const itemEvent = session.itemEvents.get(event.item.id);
        if (itemEvent) {
          itemEvent.status = event.item.status === "failed" ? "failed" : "completed";
          // Capture summary from completed agent messages
          if (event.item.type === "agent_message" && event.item.text) {
            itemEvent.summary = event.item.text.slice(0, 200);
          } else if (event.item.type === "command_execution" && event.item.command) {
            itemEvent.summary = event.item.command;
          }
        }
        // Capture the last agent_message text as the result
        if (event.item.type === "agent_message" && event.item.text) {
          session.result = event.item.text;
        }
        break;
      }

      case "error":
        log("session-manager", "warn", `Stream error: ${event.message}`);
        break;
    }
  }

  private handleApprovalRequest(session: Session, requestText: string): void {
    const requestId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const questionData = buildQuestion(requestText, requestId);

    const { resolve } = this.questionManager.register<ApprovalResponse>(
      requestId,
      () => {
        // Timeout: auto-deny
        session.pendingQuestion = null;
        session.status = "active";
        if (session.process) {
          sendApprovalResponse(session.process, { approved: false, reason: "Approval timed out" });
        }
        return { approved: false, reason: "Approval timed out" };
      },
    );

    const fullQuestion: PendingQuestion = {
      ...questionData,
      resolve,
    };

    session.pendingQuestion = fullQuestion;
    session.status = "awaiting_approval";
  }

  private handleExit(
    session: Session,
    code: number | null,
    signal: string | null,
  ): void {
    session.process = null;

    // Only update status if not already set by an event
    if (session.status === "active" || session.status === "awaiting_approval") {
      if (signal === "SIGINT") {
        session.status = "interrupted";
      } else if (code === 0) {
        session.status = "done";
      } else {
        session.status = "error";
        session.error = `Process exited with code ${code}`;
      }
    }
  }

  private async resumeSession(
    session: Session,
    message: string,
    images?: string[],
  ): Promise<void> {
    if (countActiveSessions(this.sessions) >= this.envConfig.maxSessions) {
      throw new Error(
        `Maximum concurrent sessions (${this.envConfig.maxSessions}) reached`,
      );
    }

    const spawnConfig: SpawnConfig = {
      prompt: message,
      workingDirectory: session.workingDirectory,
      resumeSessionId: session.id,
      model: session.config.model,
      approvalPolicy: session.config.approvalPolicy,
      sandbox: session.config.sandbox,
      fullAuto: session.config.fullAuto,
      profile: session.config.profile,
      config: session.config.config,
      baseInstructions: session.config.baseInstructions,
      images: images || session.config.images,
      skipGitRepoCheck: session.config.skipGitRepoCheck,
      dangerouslyBypassApprovalsAndSandbox: session.config.dangerouslyBypassApprovalsAndSandbox,
    };

    const child = spawnCodexProcess(
      spawnConfig,
      this.envConfig,
      (event) => this.handleEvent(session, event),
      (request) => this.handleApprovalRequest(session, request),
      (code, signal) => this.handleExit(session, code, signal),
    );

    session.process = child;
    session.status = "active";
  }

  private createTrackedSession(sessionId: string): Session {
    const session: Session = {
      id: sessionId,
      status: "done",
      process: null,
      createdAt: new Date(),
      workingDirectory: process.cwd(),
      config: { workingDirectory: process.cwd() },
      eventBuffer: new EventBuffer<CodexEvent>(this.envConfig.eventBufferSize),
      pendingQuestion: null,
      itemEvents: new Map(),
      turnCount: 0,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Recursively scan $CODEX_HOME/sessions/ for session JSONL files.
   * Directory structure: sessions/YYYY/MM/DD/rollout-*.jsonl
   */
  private scanSessionDirectory(
    dir: string,
    entries: Array<{
      sessionId: string;
      directory?: string;
      summary?: string;
      timestamp: string;
    }>,
    filterDir?: string,
  ): void {
    let items: string[];
    try {
      items = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const item of items) {
      const fullPath = path.join(dir, item);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        this.scanSessionDirectory(fullPath, entries, filterDir);
      } else if (item.endsWith(".jsonl")) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const firstLine = content.split("\n")[0];
          if (!firstLine) continue;
          const parsed = JSON.parse(firstLine) as Record<string, unknown>;
          if (parsed.type === "thread.started" && parsed.thread_id) {
            entries.push({
              sessionId: parsed.thread_id as string,
              timestamp: stat.mtime.toISOString(),
            });
          }
        } catch {
          // Parse defensively
        }
      }
    }
  }
}
