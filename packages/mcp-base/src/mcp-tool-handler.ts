/**
 * Shared MCP tool handler wrapper and logging utility.
 */

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Wraps a tool handler with standard JSON serialization and error handling.
 * Reduces boilerplate in MCP tool registration.
 */
export function wrapToolHandler<T>(
  handler: (args: T) => Promise<unknown> | unknown,
): (args: T) => Promise<ToolResult> {
  return async (args: T) => {
    try {
      const result = await handler(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  };
}

/**
 * Log to stderr with module and level prefix.
 */
export function log(module: string, level: string, message: string): void {
  process.stderr.write(`[${module}] [${level}] ${message}\n`);
}
