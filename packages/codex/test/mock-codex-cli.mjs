#!/usr/bin/env node

/**
 * Mock Codex CLI for testing.
 *
 * Simulates `codex exec --json` behavior.
 * Behavior is controlled via environment variables:
 *
 *   MOCK_THREAD_ID    - Thread ID to emit (default: "mock-thread-<timestamp>")
 *   MOCK_DELAY_MS     - Delay between events in ms (default: 10)
 *   MOCK_RESULT       - Result text to return (default: "Mock result text")
 *   MOCK_ERROR        - If "true", simulate an error exit
 *   MOCK_APPROVAL     - If "true", simulate an approval request on stderr
 *   MOCK_COMMAND      - If set, emit a command execution item
 */

const threadId = process.env.MOCK_THREAD_ID || `mock-thread-${Date.now()}`;
const delayMs = parseInt(process.env.MOCK_DELAY_MS || "10", 10);
const resultText = process.env.MOCK_RESULT || "Mock result text";
const shouldError = process.env.MOCK_ERROR === "true";
const needsApproval = process.env.MOCK_APPROVAL === "true";
const mockCommand = process.env.MOCK_COMMAND || "";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Handle SIGINT
process.on("SIGINT", () => {
  emit({
    type: "turn.failed",
    error: "Interrupted",
  });
  process.exit(0);
});

async function main() {
  // 1. Emit thread.started
  emit({
    type: "thread.started",
    thread_id: threadId,
  });

  await delay(delayMs);

  // 2. Emit turn.started
  emit({ type: "turn.started" });

  await delay(delayMs);

  // 3. If error mode, emit error and exit
  if (shouldError) {
    emit({
      type: "turn.failed",
      error: "Mock error occurred",
    });
    process.exit(1);
  }

  // 4. If approval mode, request approval on stderr
  if (needsApproval) {
    process.stderr.write("Allow command: ls -la ?\n");
    // Wait for stdin response
    process.stdin.setEncoding("utf8");
    await new Promise((resolve) => {
      process.stdin.once("data", () => resolve());
    });
  }

  // 5. Emit command execution if requested
  if (mockCommand) {
    const itemId = `item_${Date.now()}`;
    emit({
      type: "item.started",
      item: { id: itemId, type: "command_execution" },
    });
    await delay(delayMs);
    emit({
      type: "item.completed",
      item: { id: itemId, type: "command_execution", command: mockCommand, status: "completed" },
    });
    await delay(delayMs);
  }

  // 6. Emit agent_message item
  const msgId = `msg_${Date.now()}`;
  emit({
    type: "item.started",
    item: { id: msgId, type: "agent_message" },
  });

  await delay(delayMs);

  emit({
    type: "item.completed",
    item: { id: msgId, type: "agent_message", text: resultText },
  });

  await delay(delayMs);

  // 7. Emit turn.completed
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 50,
      output_tokens: 200,
    },
  });

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Mock CLI error: ${err}\n`);
  process.exit(1);
});
