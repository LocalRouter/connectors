import { parseAnswer } from "@localrouter/mcp-base";
import type { PendingQuestion, ApprovalType, ApprovalResponse } from "./types.js";

export { parseAnswer };

/**
 * Classify an approval request text into an approval type.
 */
export function classifyApproval(requestText: string): ApprovalType {
  if (/\b(patch|file|chang|modif|writ|creat|delet|apply)/i.test(requestText)) {
    return "patch_approval";
  }
  return "command_approval";
}

/**
 * Build a pending question from an approval request.
 */
export function buildQuestion(
  requestText: string,
  requestId: string,
): Omit<PendingQuestion, "resolve"> {
  const type = classifyApproval(requestText);
  return {
    id: requestId,
    type,
    questions: [
      {
        question: requestText,
        options: ["approve", "deny"],
      },
    ],
  };
}

/**
 * Translate client-provided answers into an approval response.
 */
export function translateAnswer(answers: string[]): ApprovalResponse {
  const { decision, reason } = parseAnswer(answers[0] || "deny");
  return {
    approved: decision === "approve" || decision === "allow" || decision === "yes",
    reason,
  };
}
