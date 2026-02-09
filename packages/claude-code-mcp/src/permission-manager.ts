import { parseAnswer } from "@localrouter/mcp-base";
import type {
  PendingQuestion,
  PermissionResponse,
  PermissionCallbackRequest,
  QuestionType,
  EnvConfig,
} from "./types.js";

export { parseAnswer };

/**
 * Classify a tool name into one of three question types.
 */
export function classifyRequest(toolName: string): QuestionType {
  if (toolName === "ExitPlanMode") return "plan_approval";
  if (toolName === "AskUserQuestion") return "question";
  return "tool_approval";
}

/**
 * Build a human-readable question structure from a tool permission request.
 */
export function buildQuestion(
  toolName: string,
  toolInput: Record<string, unknown>,
  requestId: string,
): Omit<PendingQuestion, "resolve"> {
  const type = classifyRequest(toolName);

  switch (type) {
    case "tool_approval":
      return {
        id: requestId,
        type: "tool_approval",
        toolName,
        toolInput,
        questions: [
          {
            question: `Claude wants to use ${toolName}: ${summarizeInput(toolName, toolInput)}`,
            options: ["allow", "deny"],
          },
        ],
      };

    case "plan_approval":
      return {
        id: requestId,
        type: "plan_approval",
        toolName,
        toolInput,
        questions: [
          {
            question: `Claude has completed a plan:\n\n${
              toolInput.plan || JSON.stringify(toolInput, null, 2)
            }\n\nApprove this plan and begin implementation?`,
            options: ["approve", "reject"],
          },
        ],
      };

    case "question": {
      const questions =
        (toolInput.questions as Array<{ question: string; options: string[] }>) || [];
      return {
        id: requestId,
        type: "question",
        toolName,
        toolInput,
        questions: questions.map((q) => ({
          question: q.question,
          options: q.options,
        })),
      };
    }
  }
}

/**
 * Translate client-provided answers into the permission-prompt-tool response format.
 */
export function translateAnswer(
  type: QuestionType,
  answers: string[],
  originalInput: Record<string, unknown>,
): PermissionResponse {
  const parsed = answers.map(parseAnswer);

  switch (type) {
    case "tool_approval": {
      const { decision, reason } = parsed[0] || { decision: "deny" };
      return decision === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: reason };
    }

    case "plan_approval": {
      const { decision, reason } = parsed[0] || { decision: "reject" };
      return decision === "approve"
        ? { behavior: "allow", updatedInput: originalInput }
        : { behavior: "deny", message: reason };
    }

    case "question":
      return {
        behavior: "allow",
        updatedInput: {
          ...originalInput,
          answers,
        },
      };
  }
}

/**
 * Build a short human-readable summary of tool input for display.
 */
function summarizeInput(_toolName: string, input: Record<string, unknown>): string {
  const parts: string[] = [];

  if (input.command) parts.push(`command: ${input.command}`);
  if (input.file_path) parts.push(`file: ${input.file_path}`);
  if (input.path) parts.push(`path: ${input.path}`);
  if (input.pattern) parts.push(`pattern: ${input.pattern}`);
  if (input.query) parts.push(`query: ${input.query}`);
  if (input.url) parts.push(`url: ${input.url}`);
  if (input.content && typeof input.content === "string") {
    const preview = input.content.slice(0, 100);
    parts.push(`content: ${preview}${input.content.length > 100 ? "..." : ""}`);
  }

  if (parts.length === 0) {
    const keys = Object.keys(input).slice(0, 3);
    if (keys.length > 0) {
      parts.push(
        keys.map((k) => `${k}: ${String(input[k]).slice(0, 50)}`).join(", "),
      );
    }
  }

  return parts.join(", ") || "(no details)";
}

/**
 * Manages permission requests: queues them as pending questions,
 * handles timeouts, and resolves them when answers arrive.
 */
export class PermissionManager {
  private timeoutMs: number;
  private pendingTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(envConfig: EnvConfig) {
    this.timeoutMs = envConfig.permissionTimeoutMs;
  }

  /**
   * Handle an incoming permission request from the callback server.
   * Returns a promise that resolves when the question is answered
   * (by the MCP client via claude_respond or by timeout).
   */
  async handlePermissionRequest(
    request: PermissionCallbackRequest,
    setPendingQuestion: (question: PendingQuestion | null) => void,
    setSessionStatus: (status: "awaiting_input") => void,
  ): Promise<PermissionResponse> {
    const questionData = buildQuestion(
      request.toolName,
      request.toolInput,
      request.requestId,
    );

    return new Promise<PermissionResponse>((resolve) => {
      const fullQuestion: PendingQuestion = {
        ...questionData,
        resolve,
      };

      setPendingQuestion(fullQuestion);
      setSessionStatus("awaiting_input");

      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingTimeouts.delete(request.requestId);
        setPendingQuestion(null);
        resolve({ behavior: "deny", message: "Permission request timed out" });
      }, this.timeoutMs);

      this.pendingTimeouts.set(request.requestId, timeout);
    });
  }

  /**
   * Resolve a pending question with the given answers.
   */
  resolveQuestion(
    question: PendingQuestion,
    answers: string[],
    setPendingQuestion: (question: PendingQuestion | null) => void,
  ): void {
    // Clear timeout
    const timeout = this.pendingTimeouts.get(question.id);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingTimeouts.delete(question.id);
    }

    const response = translateAnswer(question.type, answers, question.toolInput);
    setPendingQuestion(null);
    question.resolve(response);
  }

  /**
   * Clean up all pending timeouts.
   */
  cleanup(): void {
    for (const timeout of this.pendingTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.pendingTimeouts.clear();
  }
}
