import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../src/session-manager.js";
import type { EnvConfig } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockCliPath = path.join(__dirname, "mock-codex-cli.mjs");

function createEnvConfig(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    cliPath: "node",
    approvalTimeoutMs: 5000,
    maxSessions: 10,
    logLevel: "error",
    eventBufferSize: 500,
    codexHome: "/tmp/codex-test-sessions",
    ...overrides,
  };
}

// Since spawnCodexProcess uses config.cliPath directly, we'd need to inject the mock
// path through arguments. For unit tests, we test at the component level.

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager(createEnvConfig());
  });

  afterEach(async () => {
    await manager.stop();
  });

  describe("getSessionStatus", () => {
    it("throws for unknown session", () => {
      expect(() => manager.getSessionStatus("nonexistent")).toThrow("Unknown session");
    });
  });

  describe("respondToQuestion", () => {
    it("throws for unknown session", () => {
      expect(() =>
        manager.respondToQuestion({
          sessionId: "nonexistent",
          id: "q1",
          answers: ["approve"],
        }),
      ).toThrow("Unknown session");
    });
  });

  describe("interruptSession", () => {
    it("throws for unknown session", () => {
      expect(() => manager.interruptSession("nonexistent")).toThrow("Unknown session");
    });
  });

  describe("listSessions", () => {
    it("returns empty list when no sessions exist", () => {
      const result = manager.listSessions();
      expect(result.sessions).toEqual([]);
    });

    it("respects limit parameter", () => {
      const result = manager.listSessions({ limit: 5 });
      expect(result.sessions.length).toBeLessThanOrEqual(5);
    });
  });
});
