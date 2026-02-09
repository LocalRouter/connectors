import { describe, it, expect } from "vitest";
import { wrapToolHandler } from "../src/mcp-tool-handler.js";

describe("wrapToolHandler", () => {
  it("wraps successful result as JSON text content", async () => {
    const handler = wrapToolHandler((args: { x: number }) => {
      return { result: args.x * 2 };
    });
    const result = await handler({ x: 5 });
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ result: 10 }) }],
    });
  });

  it("wraps async handler", async () => {
    const handler = wrapToolHandler(async (args: { msg: string }) => {
      return { echo: args.msg };
    });
    const result = await handler({ msg: "hello" });
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ echo: "hello" }) }],
    });
  });

  it("catches errors and returns isError", async () => {
    const handler = wrapToolHandler((_args: unknown) => {
      throw new Error("Something went wrong");
    });
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: Something went wrong");
  });

  it("handles non-Error throws", async () => {
    const handler = wrapToolHandler((_args: unknown) => {
      throw "string error";
    });
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: string error");
  });
});
