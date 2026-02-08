import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { createStreamParser, parseEvent, extractTextFromEvents } from "../src/stream-parser.js";
import type { ParsedEvent } from "../src/types.js";

// --- parseEvent ---

describe("parseEvent", () => {
  it("parses init event", () => {
    const event = parseEvent({ type: "init", session_id: "abc", timestamp: "2026-01-01T00:00:00Z" });
    expect(event.type).toBe("init");
    expect((event as any).session_id).toBe("abc");
  });

  it("parses stream_event", () => {
    const event = parseEvent({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
    });
    expect(event.type).toBe("stream_event");
    expect((event as any).event.delta.text).toBe("hello");
  });

  it("parses result event", () => {
    const event = parseEvent({
      type: "result",
      status: "success",
      result: "done",
      session_id: "abc",
      cost_usd: 0.05,
      turns: 3,
    });
    expect(event.type).toBe("result");
    expect((event as any).status).toBe("success");
    expect((event as any).cost_usd).toBe(0.05);
  });

  it("returns unknown for unrecognized type", () => {
    const event = parseEvent({ type: "custom_thing", data: 42 });
    expect(event.type).toBe("custom_thing");
    expect((event as any).data).toBe(42);
  });

  it("returns unknown for non-objects", () => {
    const event = parseEvent("hello");
    expect(event.type).toBe("unknown");
  });

  it("returns unknown for null", () => {
    const event = parseEvent(null);
    expect(event.type).toBe("unknown");
  });

  it("returns unknown for objects missing type", () => {
    const event = parseEvent({ data: "no type" });
    expect(event.type).toBe("unknown");
  });

  it("returns unknown for arrays", () => {
    const event = parseEvent([1, 2, 3]);
    expect(event.type).toBe("unknown");
  });
});

// --- extractTextFromEvents ---

describe("extractTextFromEvents", () => {
  const makeTextEvent = (text: string): ParsedEvent => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });

  it("extracts text from stream events with deltas", () => {
    const events: ParsedEvent[] = [
      makeTextEvent("Hello "),
      makeTextEvent("World!"),
    ];
    const result = extractTextFromEvents(events, 10);
    expect(result).toEqual(["Hello ", "World!"]);
  });

  it("returns empty array for no events", () => {
    expect(extractTextFromEvents([], 10)).toEqual([]);
  });

  it("limits output count", () => {
    const events: ParsedEvent[] = [
      makeTextEvent("a"),
      makeTextEvent("b"),
      makeTextEvent("c"),
      makeTextEvent("d"),
    ];
    const result = extractTextFromEvents(events, 2);
    expect(result).toEqual(["c", "d"]);
  });

  it("ignores non-text events", () => {
    const events: ParsedEvent[] = [
      { type: "init", session_id: "abc", timestamp: "" } as ParsedEvent,
      makeTextEvent("only this"),
      { type: "result", status: "success", session_id: "abc" } as ParsedEvent,
    ];
    const result = extractTextFromEvents(events, 10);
    expect(result).toEqual(["only this"]);
  });

  it("ignores stream events without text delta", () => {
    const events: ParsedEvent[] = [
      {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "text" } },
      } as ParsedEvent,
      makeTextEvent("has text"),
    ];
    const result = extractTextFromEvents(events, 10);
    expect(result).toEqual(["has text"]);
  });
});

// --- createStreamParser ---

describe("createStreamParser", () => {
  it("parses NDJSON lines into objects", async () => {
    const parser = createStreamParser();
    const results: unknown[] = [];
    parser.on("data", (d: unknown) => results.push(d));

    const input = new Readable({ read() {} });
    input.pipe(parser);

    input.push('{"type":"init","session_id":"abc"}\n');
    input.push('{"type":"result","status":"success"}\n');
    input.push(null);

    await new Promise((resolve) => parser.on("end", resolve));

    expect(results).toHaveLength(2);
    expect((results[0] as any).type).toBe("init");
    expect((results[1] as any).type).toBe("result");
  });

  it("emits error on malformed JSON", async () => {
    const parser = createStreamParser();
    const errors: Error[] = [];
    parser.on("error", (e: Error) => errors.push(e));

    const input = new Readable({ read() {} });
    input.pipe(parser);

    input.push("not valid json\n");
    input.push(null);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors.length).toBeGreaterThan(0);
  });

  it("handles multiple events on separate lines", async () => {
    const parser = createStreamParser();
    const results: unknown[] = [];
    parser.on("data", (d: unknown) => results.push(d));

    const input = new Readable({ read() {} });
    input.pipe(parser);

    const lines = [
      JSON.stringify({ type: "init", session_id: "s1" }),
      JSON.stringify({ type: "stream_event", event: { type: "delta" } }),
      JSON.stringify({ type: "result", status: "success" }),
    ].join("\n") + "\n";

    input.push(lines);
    input.push(null);

    await new Promise((resolve) => parser.on("end", resolve));

    expect(results).toHaveLength(3);
  });
});
