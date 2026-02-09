import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { createNdjsonParser } from "../src/stream-parser.js";

describe("createNdjsonParser", () => {
  it("parses NDJSON lines into objects", async () => {
    const parser = createNdjsonParser();
    const results: unknown[] = [];
    parser.on("data", (d: unknown) => results.push(d));

    const input = new Readable({ read() {} });
    input.pipe(parser);

    input.push('{"type":"init","id":"abc"}\n');
    input.push('{"type":"result","status":"ok"}\n');
    input.push(null);

    await new Promise((resolve) => parser.on("end", resolve));

    expect(results).toHaveLength(2);
    expect((results[0] as any).type).toBe("init");
    expect((results[1] as any).type).toBe("result");
  });

  it("emits error on malformed JSON", async () => {
    const parser = createNdjsonParser();
    const errors: Error[] = [];
    parser.on("error", (e: Error) => errors.push(e));

    const input = new Readable({ read() {} });
    input.pipe(parser);
    input.push("not valid json\n");
    input.push(null);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors.length).toBeGreaterThan(0);
  });
});
