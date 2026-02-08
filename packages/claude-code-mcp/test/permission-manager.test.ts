import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyRequest,
  buildQuestion,
  parseAnswer,
  translateAnswer,
  PermissionManager,
} from "../src/permission-manager.js";
import type { PendingQuestion, EnvConfig, PermissionCallbackRequest } from "../src/types.js";

// --- classifyRequest ---

describe("classifyRequest", () => {
  it("classifies ExitPlanMode as plan_approval", () => {
    expect(classifyRequest("ExitPlanMode")).toBe("plan_approval");
  });

  it("classifies AskUserQuestion as question", () => {
    expect(classifyRequest("AskUserQuestion")).toBe("question");
  });

  it("classifies regular tools as tool_approval", () => {
    expect(classifyRequest("Edit")).toBe("tool_approval");
    expect(classifyRequest("Bash")).toBe("tool_approval");
    expect(classifyRequest("Read")).toBe("tool_approval");
    expect(classifyRequest("Write")).toBe("tool_approval");
  });
});

// --- buildQuestion ---

describe("buildQuestion", () => {
  it("builds tool approval question with allow/deny options", () => {
    const q = buildQuestion("Edit", { file_path: "src/index.ts" }, "req_1");
    expect(q.id).toBe("req_1");
    expect(q.type).toBe("tool_approval");
    expect(q.questions).toHaveLength(1);
    expect(q.questions[0].question).toContain("Edit");
    expect(q.questions[0].question).toContain("src/index.ts");
    expect(q.questions[0].options).toEqual(["allow", "deny"]);
  });

  it("builds tool approval with command summary", () => {
    const q = buildQuestion("Bash", { command: "rm -rf /" }, "req_2");
    expect(q.questions[0].question).toContain("rm -rf /");
  });

  it("builds plan approval question with approve/reject options", () => {
    const q = buildQuestion(
      "ExitPlanMode",
      { plan: "1. Refactor auth\n2. Add tests" },
      "req_3",
    );
    expect(q.type).toBe("plan_approval");
    expect(q.questions).toHaveLength(1);
    expect(q.questions[0].question).toContain("Refactor auth");
    expect(q.questions[0].question).toContain("Approve this plan");
    expect(q.questions[0].options).toEqual(["approve", "reject"]);
  });

  it("builds plan approval with JSON fallback when no plan field", () => {
    const q = buildQuestion("ExitPlanMode", { steps: ["a", "b"] }, "req_4");
    expect(q.questions[0].question).toContain("steps");
  });

  it("builds user question with provided options", () => {
    const q = buildQuestion(
      "AskUserQuestion",
      {
        questions: [
          { question: "Which provider?", options: ["OAuth2", "SAML"] },
          { question: "Include tests?", options: ["Yes", "No"] },
        ],
      },
      "req_5",
    );
    expect(q.type).toBe("question");
    expect(q.questions).toHaveLength(2);
    expect(q.questions[0].question).toBe("Which provider?");
    expect(q.questions[0].options).toEqual(["OAuth2", "SAML"]);
    expect(q.questions[1].question).toBe("Include tests?");
    expect(q.questions[1].options).toEqual(["Yes", "No"]);
  });

  it("handles AskUserQuestion with empty questions array", () => {
    const q = buildQuestion("AskUserQuestion", {}, "req_6");
    expect(q.type).toBe("question");
    expect(q.questions).toEqual([]);
  });

  it("stores toolName and toolInput for later translation", () => {
    const input = { file_path: "test.ts" };
    const q = buildQuestion("Edit", input, "req_7");
    expect(q.toolName).toBe("Edit");
    expect(q.toolInput).toBe(input);
  });
});

// --- parseAnswer ---

describe("parseAnswer", () => {
  it("parses simple answer without reason", () => {
    expect(parseAnswer("allow")).toEqual({ decision: "allow" });
  });

  it("parses answer with reason", () => {
    expect(parseAnswer("deny: too dangerous")).toEqual({
      decision: "deny",
      reason: "too dangerous",
    });
  });

  it("parses answer with multiple colons (splits on first)", () => {
    expect(parseAnswer("reject: reason: with: colons")).toEqual({
      decision: "reject",
      reason: "reason: with: colons",
    });
  });

  it("trims whitespace", () => {
    expect(parseAnswer("  allow  ")).toEqual({ decision: "allow" });
    expect(parseAnswer("  deny : space reason  ")).toEqual({
      decision: "deny",
      reason: "space reason",
    });
  });

  it("handles empty string", () => {
    expect(parseAnswer("")).toEqual({ decision: "" });
  });
});

// --- translateAnswer ---

describe("translateAnswer", () => {
  it("translates tool approval allow", () => {
    const result = translateAnswer("tool_approval", ["allow"], {});
    expect(result).toEqual({ behavior: "allow" });
  });

  it("translates tool approval deny without reason", () => {
    const result = translateAnswer("tool_approval", ["deny"], {});
    expect(result).toEqual({ behavior: "deny", message: undefined });
  });

  it("translates tool approval deny with reason", () => {
    const result = translateAnswer("tool_approval", ["deny: too dangerous"], {});
    expect(result).toEqual({ behavior: "deny", message: "too dangerous" });
  });

  it("translates plan approval approve", () => {
    const input = { plan: "some plan" };
    const result = translateAnswer("plan_approval", ["approve"], input);
    expect(result).toEqual({ behavior: "allow", updatedInput: input });
  });

  it("translates plan approval reject without reason", () => {
    const result = translateAnswer("plan_approval", ["reject"], { plan: "x" });
    expect(result).toEqual({ behavior: "deny", message: undefined });
  });

  it("translates plan approval reject with feedback", () => {
    const result = translateAnswer(
      "plan_approval",
      ["reject: also cover the auth module"],
      { plan: "x" },
    );
    expect(result).toEqual({
      behavior: "deny",
      message: "also cover the auth module",
    });
  });

  it("translates question answers (passes through)", () => {
    const input = {
      questions: [
        { question: "Provider?", options: ["OAuth2", "SAML"] },
        { question: "Tests?", options: ["Yes", "No"] },
      ],
    };
    const result = translateAnswer("question", ["OAuth2", "Yes"], input);
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: ["OAuth2", "Yes"],
      },
    });
  });

  it("handles empty answers array for tool_approval (defaults to deny)", () => {
    const result = translateAnswer("tool_approval", [], {});
    expect(result.behavior).toBe("deny");
  });
});

// --- PermissionManager class ---

describe("PermissionManager", () => {
  const envConfig: EnvConfig = {
    claudeCodePath: "claude",
    permissionTimeoutMs: 500, // short timeout for tests
    maxSessions: 10,
    logLevel: "error",
    eventBufferSize: 100,
  };

  let manager: PermissionManager;

  beforeEach(() => {
    manager = new PermissionManager(envConfig);
  });

  afterEach(() => {
    manager.cleanup();
  });

  it("handles permission request and resolves when answered", async () => {
    const request: PermissionCallbackRequest = {
      sessionId: "s1",
      toolName: "Edit",
      toolInput: { file_path: "test.ts" },
      requestId: "req_1",
    };

    let pendingQuestion: PendingQuestion | null = null;
    let status: string | null = null;

    const responsePromise = manager.handlePermissionRequest(
      request,
      (q) => { pendingQuestion = q; },
      (s) => { status = s; },
    );

    // Question should be set immediately
    expect(pendingQuestion).not.toBeNull();
    expect(pendingQuestion!.id).toBe("req_1");
    expect(pendingQuestion!.type).toBe("tool_approval");
    expect(status).toBe("awaiting_input");

    // Resolve it
    manager.resolveQuestion(
      pendingQuestion!,
      ["allow"],
      (q) => { pendingQuestion = q; },
    );

    const response = await responsePromise;
    expect(response).toEqual({ behavior: "allow" });
    expect(pendingQuestion).toBeNull();
  });

  it("times out stale requests with deny", async () => {
    const request: PermissionCallbackRequest = {
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
      requestId: "req_timeout",
    };

    let pendingQuestion: PendingQuestion | null = null;

    const response = await manager.handlePermissionRequest(
      request,
      (q) => { pendingQuestion = q; },
      () => {},
    );

    // Should have timed out after 500ms
    expect(response.behavior).toBe("deny");
    expect(response.message).toContain("timed out");
    expect(pendingQuestion).toBeNull();
  });

  it("cleans up all pending timeouts", async () => {
    const request: PermissionCallbackRequest = {
      sessionId: "s1",
      toolName: "Read",
      toolInput: {},
      requestId: "req_cleanup",
    };

    // Start a request but don't resolve it
    const responsePromise = manager.handlePermissionRequest(
      request,
      () => {},
      () => {},
    );

    // Cleanup should clear timeouts
    manager.cleanup();

    // The promise won't resolve from cleanup alone,
    // but the timeout won't fire either
    // We can verify cleanup doesn't throw
    expect(() => manager.cleanup()).not.toThrow();
  });

  it("handles plan approval request", async () => {
    const request: PermissionCallbackRequest = {
      sessionId: "s1",
      toolName: "ExitPlanMode",
      toolInput: { plan: "1. Do stuff" },
      requestId: "req_plan",
    };

    let pendingQuestion: PendingQuestion | null = null;

    const responsePromise = manager.handlePermissionRequest(
      request,
      (q) => { pendingQuestion = q; },
      () => {},
    );

    expect(pendingQuestion!.type).toBe("plan_approval");
    expect(pendingQuestion!.questions[0].options).toEqual(["approve", "reject"]);

    manager.resolveQuestion(
      pendingQuestion!,
      ["approve"],
      (q) => { pendingQuestion = q; },
    );

    const response = await responsePromise;
    expect(response.behavior).toBe("allow");
    expect(response.updatedInput).toEqual({ plan: "1. Do stuff" });
  });

  it("handles question request with multiple questions", async () => {
    const request: PermissionCallbackRequest = {
      sessionId: "s1",
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [
          { question: "Provider?", options: ["A", "B"] },
          { question: "Tests?", options: ["Yes", "No"] },
        ],
      },
      requestId: "req_q",
    };

    let pendingQuestion: PendingQuestion | null = null;

    const responsePromise = manager.handlePermissionRequest(
      request,
      (q) => { pendingQuestion = q; },
      () => {},
    );

    expect(pendingQuestion!.type).toBe("question");
    expect(pendingQuestion!.questions).toHaveLength(2);

    manager.resolveQuestion(
      pendingQuestion!,
      ["A", "Yes"],
      (q) => { pendingQuestion = q; },
    );

    const response = await responsePromise;
    expect(response.behavior).toBe("allow");
    expect((response.updatedInput as any).answers).toEqual(["A", "Yes"]);
  });
});
