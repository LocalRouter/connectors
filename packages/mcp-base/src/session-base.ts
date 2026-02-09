import type { ChildProcess } from "node:child_process";

/**
 * Poll until a condition is met or timeout expires.
 */
export function pollUntil(
  check: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const poll = (): void => {
      if (check()) {
        resolve(true);
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

/**
 * Wait for a process to exit, force-killing after timeout.
 */
export async function waitForProcessExit(
  process: ChildProcess | null,
  timeoutMs: number,
): Promise<void> {
  if (!process) return;
  const exited = await pollUntil(
    () => process.exitCode !== null || process.killed,
    timeoutMs,
  );
  if (!exited) {
    try {
      process.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

/**
 * Count sessions with active processes.
 */
export function countActiveSessions<T extends { process: ChildProcess | null }>(
  sessions: Map<string, T>,
): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.process) count++;
  }
  return count;
}
