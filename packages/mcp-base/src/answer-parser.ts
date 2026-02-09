/**
 * Parse an answer string into a decision and optional reason.
 * e.g. "deny: too dangerous" → { decision: "deny", reason: "too dangerous" }
 */
export function parseAnswer(answer: string): { decision: string; reason?: string } {
  const colonIndex = answer.indexOf(":");
  if (colonIndex === -1) return { decision: answer.trim() };
  return {
    decision: answer.slice(0, colonIndex).trim(),
    reason: answer.slice(colonIndex + 1).trim(),
  };
}
