import { describe, it, expect, vi, afterEach } from "vitest";
import { pollUntil, countActiveSessions } from "../src/session-base.js";

describe("pollUntil", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves true when check passes immediately", async () => {
    const result = await pollUntil(() => true, 1000);
    expect(result).toBe(true);
  });

  it("resolves true when check passes after delay", async () => {
    let counter = 0;
    const result = await pollUntil(() => {
      counter++;
      return counter >= 3;
    }, 5000, 10);
    expect(result).toBe(true);
  });

  it("resolves false on timeout", async () => {
    const result = await pollUntil(() => false, 100, 10);
    expect(result).toBe(false);
  });
});

describe("countActiveSessions", () => {
  it("counts sessions with non-null process", () => {
    const sessions = new Map<string, { process: null | object }>();
    sessions.set("a", { process: {} });
    sessions.set("b", { process: null });
    sessions.set("c", { process: {} });
    expect(countActiveSessions(sessions)).toBe(2);
  });

  it("returns 0 for empty map", () => {
    const sessions = new Map<string, { process: null | object }>();
    expect(countActiveSessions(sessions)).toBe(0);
  });

  it("returns 0 when all processes are null", () => {
    const sessions = new Map<string, { process: null }>();
    sessions.set("a", { process: null });
    sessions.set("b", { process: null });
    expect(countActiveSessions(sessions)).toBe(0);
  });
});
