import { describe, it, expect } from "vitest";
import {
  classifyApproval,
  buildQuestion,
  translateAnswer,
  parseAnswer,
} from "../src/approval-manager.js";

describe("classifyApproval", () => {
  it("classifies patch-related requests", () => {
    expect(classifyApproval("Apply changes to file.ts?")).toBe("patch_approval");
    expect(classifyApproval("Modify src/index.ts?")).toBe("patch_approval");
    expect(classifyApproval("Write to config.json?")).toBe("patch_approval");
    expect(classifyApproval("Create new file?")).toBe("patch_approval");
    expect(classifyApproval("Delete old file?")).toBe("patch_approval");
  });

  it("classifies command requests", () => {
    expect(classifyApproval("Allow command: ls -la?")).toBe("command_approval");
    expect(classifyApproval("Approve running npm install?")).toBe("command_approval");
    expect(classifyApproval("Execute this?")).toBe("command_approval");
  });
});

describe("buildQuestion", () => {
  it("builds a command approval question", () => {
    const q = buildQuestion("Allow command: rm -rf /?", "req-1");
    expect(q.id).toBe("req-1");
    expect(q.type).toBe("command_approval");
    expect(q.questions).toHaveLength(1);
    expect(q.questions[0].options).toEqual(["approve", "deny"]);
    expect(q.questions[0].question).toBe("Allow command: rm -rf /?");
  });

  it("builds a patch approval question", () => {
    const q = buildQuestion("Apply changes to src/index.ts?", "req-2");
    expect(q.type).toBe("patch_approval");
  });
});

describe("translateAnswer", () => {
  it("translates approve", () => {
    expect(translateAnswer(["approve"])).toEqual({
      approved: true,
      reason: undefined,
    });
  });

  it("translates allow", () => {
    expect(translateAnswer(["allow"])).toEqual({
      approved: true,
      reason: undefined,
    });
  });

  it("translates yes", () => {
    expect(translateAnswer(["yes"])).toEqual({
      approved: true,
      reason: undefined,
    });
  });

  it("translates deny", () => {
    expect(translateAnswer(["deny"])).toEqual({
      approved: false,
      reason: undefined,
    });
  });

  it("translates deny with reason", () => {
    expect(translateAnswer(["deny: too risky"])).toEqual({
      approved: false,
      reason: "too risky",
    });
  });

  it("defaults to deny for empty", () => {
    expect(translateAnswer([])).toEqual({
      approved: false,
      reason: undefined,
    });
  });
});

describe("parseAnswer (re-exported from mcp-base)", () => {
  it("parses decision with reason", () => {
    expect(parseAnswer("deny: bad")).toEqual({
      decision: "deny",
      reason: "bad",
    });
  });
});
