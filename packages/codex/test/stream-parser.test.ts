import { describe, it, expect } from "vitest";
import { parseEvent, extractTextFromEvents } from "../src/stream-parser.js";
import type { CodexEvent } from "../src/types.js";

describe("parseEvent", () => {
  it("parses thread.started event", () => {
    const event = parseEvent({ type: "thread.started", thread_id: "abc" });
    expect(event.type).toBe("thread.started");
    expect((event as any).thread_id).toBe("abc");
  });

  it("parses turn.started event", () => {
    const event = parseEvent({ type: "turn.started" });
    expect(event.type).toBe("turn.started");
  });

  it("parses turn.completed event", () => {
    const event = parseEvent({
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 200 },
    });
    expect(event.type).toBe("turn.completed");
    expect((event as any).usage.input_tokens).toBe(100);
  });

  it("parses turn.failed event", () => {
    const event = parseEvent({ type: "turn.failed", error: "oops" });
    expect(event.type).toBe("turn.failed");
    expect((event as any).error).toBe("oops");
  });

  it("parses item.started event", () => {
    const event = parseEvent({
      type: "item.started",
      item: { id: "i1", type: "command_execution" },
    });
    expect(event.type).toBe("item.started");
  });

  it("parses item.updated event", () => {
    const event = parseEvent({
      type: "item.updated",
      item: { id: "i1", type: "agent_message" },
    });
    expect(event.type).toBe("item.updated");
  });

  it("parses item.completed event", () => {
    const event = parseEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "done" },
    });
    expect(event.type).toBe("item.completed");
    expect((event as any).item.text).toBe("done");
  });

  it("parses error event", () => {
    const event = parseEvent({ type: "error", message: "stream error" });
    expect(event.type).toBe("error");
    expect((event as any).message).toBe("stream error");
  });

  it("returns error for unknown types", () => {
    const event = parseEvent({ type: "foobar", data: 42 });
    expect(event.type).toBe("error");
    expect((event as any).message).toContain("Unknown event type");
  });

  it("returns error for non-objects", () => {
    const event = parseEvent("hello");
    expect(event.type).toBe("error");
    expect((event as any).message).toContain("Unparseable");
  });

  it("returns error for null", () => {
    const event = parseEvent(null);
    expect(event.type).toBe("error");
  });

  it("returns error for objects missing type", () => {
    const event = parseEvent({ data: "no type" });
    expect(event.type).toBe("error");
  });
});

describe("extractTextFromEvents", () => {
  it("extracts text from completed agent message items", () => {
    const events: CodexEvent[] = [
      {
        type: "item.completed",
        item: { id: "1", type: "agent_message", text: "Hello" },
      },
      {
        type: "item.completed",
        item: { id: "2", type: "agent_message", text: "World" },
      },
    ];
    expect(extractTextFromEvents(events, 10)).toEqual(["Hello", "World"]);
  });

  it("returns empty for no events", () => {
    expect(extractTextFromEvents([], 10)).toEqual([]);
  });

  it("limits output count", () => {
    const events: CodexEvent[] = [
      { type: "item.completed", item: { id: "1", type: "agent_message", text: "a" } },
      { type: "item.completed", item: { id: "2", type: "agent_message", text: "b" } },
      { type: "item.completed", item: { id: "3", type: "agent_message", text: "c" } },
    ];
    expect(extractTextFromEvents(events, 2)).toEqual(["b", "c"]);
  });

  it("ignores non-agent-message items", () => {
    const events: CodexEvent[] = [
      { type: "item.completed", item: { id: "1", type: "command_execution", command: "ls" } },
      { type: "item.completed", item: { id: "2", type: "agent_message", text: "only this" } },
      { type: "turn.completed" } as CodexEvent,
    ];
    expect(extractTextFromEvents(events, 10)).toEqual(["only this"]);
  });

  it("ignores agent messages without text", () => {
    const events: CodexEvent[] = [
      { type: "item.completed", item: { id: "1", type: "agent_message" } },
      { type: "item.completed", item: { id: "2", type: "agent_message", text: "has text" } },
    ];
    expect(extractTextFromEvents(events, 10)).toEqual(["has text"]);
  });
});
