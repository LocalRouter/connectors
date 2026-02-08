#!/usr/bin/env node

/**
 * Mock Claude Code CLI for testing.
 *
 * Simulates Claude Code's --output-format stream-json behavior.
 * Behavior is controlled via environment variables:
 *
 *   MOCK_SESSION_ID   - Session ID to emit (default: "mock-session-<timestamp>")
 *   MOCK_DELAY_MS     - Delay between events in ms (default: 10)
 *   MOCK_RESULT       - Result text to return (default: "Mock result text")
 *   MOCK_ERROR        - If "true", simulate an error exit
 *   MOCK_MULTI_TURN   - If "true", wait for stdin messages after initial output
 *   MOCK_COST_USD     - Cost to report (default: 0.01)
 *   MOCK_TURNS        - Turn count to report (default: 1)
 *   MOCK_TOOL_USE     - If "true", emit a tool_use content block
 */

const sessionId = process.env.MOCK_SESSION_ID || `mock-session-${Date.now()}`;
const delayMs = parseInt(process.env.MOCK_DELAY_MS || "10", 10);
const resultText = process.env.MOCK_RESULT || "Mock result text";
const shouldError = process.env.MOCK_ERROR === "true";
const multiTurn = process.env.MOCK_MULTI_TURN === "true";
const costUsd = parseFloat(process.env.MOCK_COST_USD || "0.01");
const turns = parseInt(process.env.MOCK_TURNS || "1", 10);
const emitToolUse = process.env.MOCK_TOOL_USE === "true";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Handle SIGINT → emit interrupted result
process.on("SIGINT", () => {
  emit({
    type: "result",
    status: "interrupted",
    session_id: sessionId,
    cost_usd: costUsd,
    turns,
  });
  process.exit(0);
});

async function main() {
  // 1. Emit init event
  emit({
    type: "init",
    session_id: sessionId,
    timestamp: new Date().toISOString(),
  });

  await delay(delayMs);

  // 2. If error mode, emit error and exit
  if (shouldError) {
    emit({
      type: "result",
      status: "error",
      result: "Mock error occurred",
      session_id: sessionId,
    });
    process.exit(1);
  }

  // 3. Optionally emit tool_use block
  if (emitToolUse) {
    emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Edit", id: "tu_mock1" },
        index: 0,
      },
    });
    await delay(delayMs);
    emit({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });
    await delay(delayMs);
  }

  // 4. Emit text content block
  emit({
    type: "stream_event",
    event: {
      type: "content_block_start",
      content_block: { type: "text" },
      index: emitToolUse ? 1 : 0,
    },
  });

  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello " },
      index: emitToolUse ? 1 : 0,
    },
  });

  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "World!" },
      index: emitToolUse ? 1 : 0,
    },
  });

  emit({
    type: "stream_event",
    event: {
      type: "content_block_stop",
      index: emitToolUse ? 1 : 0,
    },
  });

  // 5. Multi-turn: wait for stdin, echo responses
  if (multiTurn) {
    process.stdin.setEncoding("utf8");
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          emit({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: {
                type: "text_delta",
                text: `Response to: ${msg.message?.content || "unknown"}`,
              },
            },
          });
        } catch {
          // ignore malformed input
        }
      }
    });
    // Stay alive until stdin closes or SIGINT
    return;
  }

  await delay(delayMs);

  // 6. Emit result
  emit({
    type: "result",
    status: "success",
    result: resultText,
    session_id: sessionId,
    cost_usd: costUsd,
    duration_ms: 100,
    turns,
  });

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Mock CLI error: ${err}\n`);
  process.exit(1);
});
