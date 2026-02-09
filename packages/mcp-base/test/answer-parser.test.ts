import { describe, it, expect } from "vitest";
import { parseAnswer } from "../src/answer-parser.js";

describe("parseAnswer", () => {
  it("parses simple decision", () => {
    expect(parseAnswer("allow")).toEqual({ decision: "allow" });
  });

  it("parses decision with reason", () => {
    expect(parseAnswer("deny: too dangerous")).toEqual({
      decision: "deny",
      reason: "too dangerous",
    });
  });

  it("trims whitespace", () => {
    expect(parseAnswer("  approve  ")).toEqual({ decision: "approve" });
  });

  it("trims whitespace in decision and reason", () => {
    expect(parseAnswer("  deny  :  not safe  ")).toEqual({
      decision: "deny",
      reason: "not safe",
    });
  });

  it("handles reason with colons", () => {
    expect(parseAnswer("deny: reason: with: colons")).toEqual({
      decision: "deny",
      reason: "reason: with: colons",
    });
  });

  it("handles empty string", () => {
    expect(parseAnswer("")).toEqual({ decision: "" });
  });
});
