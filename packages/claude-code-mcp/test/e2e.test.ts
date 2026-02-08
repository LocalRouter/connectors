import { describe, it, expect } from "vitest";

/**
 * End-to-end tests that require a real Claude Code CLI installation.
 * Gated behind the CLAUDE_CODE_E2E=true environment variable.
 *
 * Run with: npm run test:e2e
 */

const isE2E = process.env.CLAUDE_CODE_E2E === "true";

describe.skipIf(!isE2E)("E2E: Claude Code MCP Server", () => {
  it("placeholder: creates a real session and checks status", async () => {
    // TODO: Implement when real Claude Code CLI is available
    // 1. Start the MCP server
    // 2. Create a session with a simple prompt
    // 3. Poll status until completion
    // 4. Verify result
    expect(true).toBe(true);
  });

  it("placeholder: sends follow-up message (auto-resume)", async () => {
    // TODO: Implement when real Claude Code CLI is available
    // 1. Start a session
    // 2. Wait for completion
    // 3. Send follow-up via claude_say
    // 4. Verify auto-resume works
    expect(true).toBe(true);
  });

  it("placeholder: interrupts a running session", async () => {
    // TODO: Implement when real Claude Code CLI is available
    // 1. Start a session with a long-running prompt
    // 2. Interrupt via claude_interrupt
    // 3. Verify status is "interrupted"
    // 4. Resume via claude_say
    expect(true).toBe(true);
  });

  it("placeholder: lists sessions and finds created session", async () => {
    // TODO: Implement when real Claude Code CLI is available
    // 1. Start a session
    // 2. Call claude_list
    // 3. Verify session appears in list
    expect(true).toBe(true);
  });
});
