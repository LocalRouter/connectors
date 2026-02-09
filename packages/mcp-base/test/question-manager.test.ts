import { describe, it, expect, vi, afterEach } from "vitest";
import { QuestionManager } from "../src/question-manager.js";

describe("QuestionManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers and resolves a question", async () => {
    const manager = new QuestionManager(5000);
    const { promise, resolve } = manager.register<string>("q1", () => "timeout");
    resolve("answered");
    expect(await promise).toBe("answered");
    manager.cleanup();
  });

  it("calls timeout callback when time expires", async () => {
    vi.useFakeTimers();
    const manager = new QuestionManager(100);
    const { promise } = manager.register<string>("q1", () => "timed_out");

    vi.advanceTimersByTime(150);
    expect(await promise).toBe("timed_out");

    manager.cleanup();
    vi.useRealTimers();
  });

  it("clearTimeout prevents timeout callback", async () => {
    vi.useFakeTimers();
    const manager = new QuestionManager(100);
    const { promise, resolve } = manager.register<string>("q1", () => "timed_out");

    manager.clearTimeout("q1");
    resolve("manually resolved");
    expect(await promise).toBe("manually resolved");

    manager.cleanup();
    vi.useRealTimers();
  });

  it("cleanup clears all pending timeouts", () => {
    vi.useFakeTimers();
    const manager = new QuestionManager(5000);
    manager.register<string>("q1", () => "t1");
    manager.register<string>("q2", () => "t2");
    manager.cleanup();
    // Should not throw
    vi.advanceTimersByTime(10000);
    vi.useRealTimers();
  });
});
