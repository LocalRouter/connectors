import { describe, it, expect } from "vitest";
import { EventBuffer } from "../src/event-buffer.js";

describe("EventBuffer", () => {
  it("stores and retrieves events", () => {
    const buf = new EventBuffer<string>(10);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    expect(buf.getAll()).toEqual(["a", "b", "c"]);
  });

  it("respects max size", () => {
    const buf = new EventBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    expect(buf.getAll()).toEqual([2, 3, 4]);
    expect(buf.length).toBe(3);
  });

  it("getRecent returns last N items", () => {
    const buf = new EventBuffer<number>(10);
    for (let i = 1; i <= 5; i++) buf.push(i);
    expect(buf.getRecent(3)).toEqual([3, 4, 5]);
    expect(buf.getRecent(10)).toEqual([1, 2, 3, 4, 5]);
  });

  it("clears buffer", () => {
    const buf = new EventBuffer<string>(10);
    buf.push("a");
    buf.push("b");
    buf.clear();
    expect(buf.getAll()).toEqual([]);
    expect(buf.length).toBe(0);
  });

  it("extract filters and maps events", () => {
    const buf = new EventBuffer<{ type: string; value?: number }>(10);
    buf.push({ type: "a", value: 1 });
    buf.push({ type: "b" });
    buf.push({ type: "a", value: 2 });
    buf.push({ type: "a", value: 3 });

    const result = buf.extract(
      (e) => (e.type === "a" ? e.value : undefined),
      2,
    );
    expect(result).toEqual([2, 3]);
  });

  it("extract returns empty for no matches", () => {
    const buf = new EventBuffer<{ type: string }>(10);
    buf.push({ type: "a" });
    const result = buf.extract(() => undefined, 10);
    expect(result).toEqual([]);
  });

  it("handles default maxSize", () => {
    const buf = new EventBuffer<number>();
    for (let i = 0; i < 600; i++) buf.push(i);
    expect(buf.length).toBe(500);
    expect(buf.getRecent(1)).toEqual([599]);
  });
});
