import { createNdjsonParser } from "@localrouter/mcp-base";
import type { Transform } from "node:stream";
import type { ParsedEvent } from "./types.js";

/**
 * Creates a transform stream that splits input on newlines and parses each line as JSON.
 * Emits parsed objects. Malformed lines emit an 'error' event on the stream.
 */
export function createStreamParser(): Transform {
  return createNdjsonParser();
}

/**
 * Type-discriminates a parsed JSON object into a typed event.
 * Unknown or malformed objects are returned as UnknownEvent.
 */
export function parseEvent(data: unknown): ParsedEvent {
  if (typeof data !== "object" || data === null || !("type" in data)) {
    return { type: "unknown", raw: data } as ParsedEvent;
  }

  const obj = data as Record<string, unknown>;
  const type = obj.type as string;

  switch (type) {
    case "init":
    case "stream_event":
    case "result":
      return obj as unknown as ParsedEvent;
    default:
      return obj as ParsedEvent;
  }
}

/**
 * Extract recent text deltas from a list of events.
 */
export function extractTextFromEvents(events: ParsedEvent[], count: number): string[] {
  const textLines: string[] = [];
  for (const event of events) {
    if (event.type === "stream_event") {
      const se = event as { type: "stream_event"; event?: { delta?: { text?: string } } };
      if (se.event?.delta?.text) {
        textLines.push(se.event.delta.text);
      }
    }
  }
  return textLines.slice(-count);
}
