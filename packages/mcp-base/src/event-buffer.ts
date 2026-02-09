/**
 * Ring buffer for storing recent events with a configurable max size.
 */
export class EventBuffer<T> {
  private events: T[] = [];
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  push(event: T): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.shift();
    }
  }

  getRecent(n: number): T[] {
    return this.events.slice(-n);
  }

  getAll(): T[] {
    return [...this.events];
  }

  get length(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
  }

  /**
   * Extract items matching a predicate, returning at most `count`.
   * Connector provides the filter/map logic for its event type.
   */
  extract<R>(fn: (event: T) => R | undefined, count: number): R[] {
    const results: R[] = [];
    for (const event of this.events) {
      const result = fn(event);
      if (result !== undefined) results.push(result);
    }
    return results.slice(-count);
  }
}
