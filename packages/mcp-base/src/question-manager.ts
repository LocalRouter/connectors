/**
 * Manages pending questions with timeout support.
 * Extracted from PermissionManager to be shared across connectors.
 */
export class QuestionManager {
  private timeoutMs: number;
  private pendingTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Register a pending question with timeout.
   * Returns a promise that resolves when the question is answered or times out.
   */
  register<T>(
    questionId: string,
    onTimeout: () => T,
  ): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolveOuter!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
      resolveOuter = resolve;

      const timeout = setTimeout(() => {
        this.pendingTimeouts.delete(questionId);
        resolve(onTimeout());
      }, this.timeoutMs);

      this.pendingTimeouts.set(questionId, timeout);
    });

    return { promise, resolve: resolveOuter };
  }

  clearTimeout(questionId: string): void {
    const timeout = this.pendingTimeouts.get(questionId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingTimeouts.delete(questionId);
    }
  }

  cleanup(): void {
    for (const timeout of this.pendingTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.pendingTimeouts.clear();
  }
}
