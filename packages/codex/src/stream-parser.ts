import type { CodexEvent } from "./types.js";

export { createNdjsonParser } from "@localrouter/mcp-base";

const KNOWN_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error",
]);

/**
 * Type-discriminates a parsed JSON object into a Codex event.
 * Unknown or malformed objects are returned as StreamErrorEvent.
 */
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

/**
 * Extract agent message text from completed item events.
 */
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
