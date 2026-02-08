import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  spawnClaudeProcess,
  sendMessage,
  interruptProcess,
} from "./process-manager.js";
import { extractTextFromEvents } from "./stream-parser.js";
import { PermissionCallbackServer } from "./permission-callback-server.js";
import { PermissionManager } from "./permission-manager.js";
import type {
  Session,
  SessionStatus,
  SessionConfig,
  SpawnConfig,
  ParsedEvent,
  PendingQuestion,
  ToolUseEvent,
  EnvConfig,
  HistoryEntry,
  PermissionMode,
  StreamEvent,
} from "./types.js";

/**
 * Manages the full lifecycle of Claude Code sessions:
 * creation, messaging, status queries, interruption, and listing.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private callbackServer: PermissionCallbackServer;
  private permissionManager: PermissionManager;
  private envConfig: EnvConfig;

  constructor(envConfig: EnvConfig) {
    this.envConfig = envConfig;
    this.permissionManager = new PermissionManager(envConfig);
    this.callbackServer = new PermissionCallbackServer(async (request) => {
      const session = this.findSessionForPermission(request.sessionId);
      if (!session) {
        return { behavior: "deny", message: "Unknown session" };
      }
      return this.permissionManager.handlePermissionRequest(
        request,
        (q) => {
          session.pendingQuestion = q;
        },
        (status) => {
          session.status = status;
        },
      );
    });
  }

  async start(): Promise<void> {
    await this.callbackServer.start();
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
    this.permissionManager.cleanup();
    await this.callbackServer.stop();
  }

  // --- Tool Handlers ---

  async startSession(params: {
    prompt: string;
    workingDirectory?: string;
    model?: string;
    permissionMode?: PermissionMode;
    allowedTools?: string[];
    disallowedTools?: string[];
    maxTurns?: number;
    maxBudgetUsd?: number;
    systemPrompt?: string;
    dangerouslySkipPermissions?: boolean;
  }): Promise<{ sessionId: string; status: SessionStatus }> {
    if (this.getActiveSessionCount() >= this.envConfig.maxSessions) {
      throw new Error(
        `Maximum concurrent sessions (${this.envConfig.maxSessions}) reached`,
      );
    }

    const workingDirectory = params.workingDirectory || process.cwd();
    const config: SessionConfig = {
      workingDirectory,
      model: params.model,
      permissionMode: params.permissionMode,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      maxTurns: params.maxTurns,
      maxBudgetUsd: params.maxBudgetUsd,
      systemPrompt: params.systemPrompt,
      dangerouslySkipPermissions: params.dangerouslySkipPermissions,
    };

    // Temporary ID until the init event gives us the real session ID
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const session: Session = {
      id: tempId,
      status: "active",
      process: null,
      createdAt: new Date(),
      workingDirectory,
      config,
      eventBuffer: [],
      pendingQuestion: null,
      toolUseEvents: [],
    };

    this.sessions.set(tempId, session);

    const spawnConfig: SpawnConfig = {
      prompt: params.prompt,
      workingDirectory,
      model: params.model,
      permissionMode: params.permissionMode,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      maxTurns: params.maxTurns,
      maxBudgetUsd: params.maxBudgetUsd,
      systemPrompt: params.systemPrompt,
      dangerouslySkipPermissions: params.dangerouslySkipPermissions,
      permissionCallbackPort: this.callbackServer.getPort(),
    };

    const child = spawnClaudeProcess(
      spawnConfig,
      this.envConfig,
      (event) => this.handleEvent(session, event),
      (code, signal) => this.handleExit(session, code, signal),
    );

    session.process = child;

    // Wait briefly for the init event to capture the real session ID
    const realId = await this.waitForSessionId(session, 10000);

    return { sessionId: realId, status: "active" };
  }

  async sayToSession(params: {
    sessionId: string;
    message: string;
    permissionMode?: PermissionMode;
  }): Promise<{ sessionId: string; status: SessionStatus }> {
    let session = this.sessions.get(params.sessionId);

    if (!session) {
      // Unknown session -- could be a user-created session. Track it and resume.
      session = this.createTrackedSession(params.sessionId);
    }

    const needsModeChange =
      params.permissionMode !== undefined &&
      params.permissionMode !== session.config.permissionMode;

    if (session.process && session.status === "active") {
      if (needsModeChange) {
        // Interrupt current process, then resume with new mode
        interruptProcess(session.process);
        await this.waitForExit(session, 5000);
        session.config.permissionMode = params.permissionMode;
        await this.resumeSession(session, params.message);
      } else {
        // Send directly via stdin
        sendMessage(session.process, session.id, params.message);
      }
    } else {
      // Process is dead -- resume
      if (needsModeChange) {
        session.config.permissionMode = params.permissionMode;
      }
      await this.resumeSession(session, params.message);
    }

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
    toolUseEvents: ToolUseEvent[];
    costUsd?: number;
    turnCount?: number;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const recentOutput = extractTextFromEvents(session.eventBuffer, outputLines);

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
      toolUseEvents: ToolUseEvent[];
      costUsd?: number;
      turnCount?: number;
    } = {
      sessionId: session.id,
      status: session.status,
      recentOutput,
      toolUseEvents: session.toolUseEvents,
    };

    if (session.result) result.result = session.result;
    if (session.costUsd !== undefined) result.costUsd = session.costUsd;
    if (session.turnCount !== undefined) result.turnCount = session.turnCount;

    if (session.pendingQuestion && session.status === "awaiting_input") {
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

    this.permissionManager.resolveQuestion(
      session.pendingQuestion,
      params.answers,
      (q) => {
        session.pendingQuestion = q;
      },
    );

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
      projectDirectory: string;
      displayText: string;
      timestamp: string;
      isActive: boolean;
      activeStatus?: SessionStatus;
    }>;
  } {
    const limit = params?.limit || 50;
    const historyPath = path.join(os.homedir(), ".claude", "history.jsonl");

    const entries: Array<{
      sessionId: string;
      projectDirectory: string;
      displayText: string;
      timestamp: string;
    }> = [];

    // Read history file if it exists
    try {
      const content = fs.readFileSync(historyPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as HistoryEntry;
          if (entry.session_id) {
            if (
              params?.workingDirectory &&
              entry.project !== params.workingDirectory
            ) {
              continue;
            }
            entries.push({
              sessionId: entry.session_id,
              projectDirectory: entry.project || "",
              displayText: entry.display || "",
              timestamp: entry.timestamp || "",
            });
          }
        } catch {
          // Skip malformed lines -- parse defensively
        }
      }
    } catch {
      // File doesn't exist or isn't readable
    }

    // Include any active sessions not already in history
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
            projectDirectory: session.workingDirectory,
            displayText: "",
            timestamp: session.createdAt.toISOString(),
          });
        }
      }
    }

    // Sort by timestamp descending (most recent first)
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

  private findSessionForPermission(
    permSessionId: string,
  ): Session | undefined {
    // Exact match
    const exact = this.sessions.get(permSessionId);
    if (exact) return exact;

    // "__pending__" means the session hasn't received its init event yet
    if (permSessionId === "__pending__") {
      for (const session of this.sessions.values()) {
        if (session.id.startsWith("temp_") && session.status === "active") {
          return session;
        }
      }
    }

    // Fallback: return the most recently created active session
    let latest: Session | undefined;
    for (const session of this.sessions.values()) {
      if (
        session.status === "active" ||
        session.status === "awaiting_input"
      ) {
        if (!latest || session.createdAt > latest.createdAt) {
          latest = session;
        }
      }
    }
    return latest;
  }

  private handleEvent(session: Session, event: ParsedEvent): void {
    // Buffer the event (ring buffer)
    session.eventBuffer.push(event);
    if (session.eventBuffer.length > this.envConfig.eventBufferSize) {
      session.eventBuffer.shift();
    }

    if (event.type === "init") {
      const initEvt = event as import("./types.js").InitEvent;
      const oldId = session.id;
      const newId = initEvt.session_id;
      if (oldId !== newId) {
        this.sessions.delete(oldId);
        session.id = newId;
        this.sessions.set(newId, session);
      }
    } else if (event.type === "stream_event") {
      this.handleStreamEvent(session, event);
    } else if (event.type === "result") {
      const resultEvt = event as import("./types.js").ResultEvent;
      if (resultEvt.status === "success") {
        session.status = "done";
        session.result = resultEvt.result;
      } else if (resultEvt.status === "interrupted") {
        session.status = "interrupted";
      } else {
        session.status = "error";
        session.error = resultEvt.result || "Unknown error";
      }
      if (resultEvt.cost_usd !== undefined) session.costUsd = resultEvt.cost_usd;
      if (resultEvt.turns !== undefined) session.turnCount = resultEvt.turns;
    }
  }

  private handleStreamEvent(session: Session, event: ParsedEvent): void {
    if (event.type !== "stream_event") return;

    const se = event as StreamEvent;
    const innerEvent = se.event;
    if (!innerEvent) return;

    // Track tool use starts
    if (
      innerEvent.type === "content_block_start" &&
      innerEvent.content_block?.type === "tool_use"
    ) {
      session.toolUseEvents.push({
        toolName: innerEvent.content_block.name || "unknown",
        status: "running",
      });
    }

    // Track tool use completions
    if (innerEvent.type === "content_block_stop") {
      const lastRunning = [...session.toolUseEvents]
        .reverse()
        .find((t) => t.status === "running");
      if (lastRunning) {
        lastRunning.status = "completed";
      }
    }
  }

  private handleExit(
    session: Session,
    code: number | null,
    signal: string | null,
  ): void {
    session.process = null;

    // Only update status if not already set by a result event
    if (session.status === "active" || session.status === "awaiting_input") {
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
  ): Promise<void> {
    if (this.getActiveSessionCount() >= this.envConfig.maxSessions) {
      throw new Error(
        `Maximum concurrent sessions (${this.envConfig.maxSessions}) reached`,
      );
    }

    const spawnConfig: SpawnConfig = {
      prompt: message,
      workingDirectory: session.workingDirectory,
      resumeSessionId: session.id,
      model: session.config.model,
      permissionMode: session.config.permissionMode,
      allowedTools: session.config.allowedTools,
      disallowedTools: session.config.disallowedTools,
      maxTurns: session.config.maxTurns,
      maxBudgetUsd: session.config.maxBudgetUsd,
      systemPrompt: session.config.systemPrompt,
      dangerouslySkipPermissions: session.config.dangerouslySkipPermissions,
      permissionCallbackPort: this.callbackServer.getPort(),
    };

    const child = spawnClaudeProcess(
      spawnConfig,
      this.envConfig,
      (event) => this.handleEvent(session, event),
      (code, signal) => this.handleExit(session, code, signal),
    );

    session.process = child;
    session.status = "active";
  }

  private createTrackedSession(sessionId: string): Session {
    const session: Session = {
      id: sessionId,
      status: "done", // Will be overridden by resume
      process: null,
      createdAt: new Date(),
      workingDirectory: process.cwd(),
      config: { workingDirectory: process.cwd() },
      eventBuffer: [],
      pendingQuestion: null,
      toolUseEvents: [],
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private waitForSessionId(
    session: Session,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const check = (): void => {
        if (!session.id.startsWith("temp_")) {
          resolve(session.id);
          return;
        }
        if (Date.now() - startTime > timeoutMs) {
          // Return temp ID on timeout
          resolve(session.id);
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  private waitForExit(
    session: Session,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      if (!session.process) {
        resolve();
        return;
      }
      const startTime = Date.now();
      const check = (): void => {
        if (!session.process) {
          resolve();
          return;
        }
        if (Date.now() - startTime > timeoutMs) {
          try {
            session.process.kill("SIGKILL");
          } catch {
            // ignore
          }
          session.process = null;
          resolve();
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  private getActiveSessionCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.process) count++;
    }
    return count;
  }
}
