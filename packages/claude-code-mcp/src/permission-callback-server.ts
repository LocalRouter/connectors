import http from "node:http";
import type { PermissionCallbackRequest, PermissionResponse } from "./types.js";

export type PermissionRequestHandler = (
  request: PermissionCallbackRequest,
) => Promise<PermissionResponse>;

/**
 * Internal HTTP server that listens on a random localhost port.
 * Receives permission requests from the internal permission-handler-mcp script
 * (spawned by Claude Code), and forwards them to the permission manager.
 * Blocks the HTTP response until the question is answered.
 */
export class PermissionCallbackServer {
  private server: http.Server;
  private port = 0;
  private handler: PermissionRequestHandler;

  constructor(handler: PermissionRequestHandler) {
    this.handler = handler;
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          log("info", `Permission callback server listening on port ${this.port}`);
          resolve(this.port);
        } else {
          reject(new Error("Failed to get server address"));
        }
      });
      this.server.on("error", reject);
    });
  }

  getPort(): number {
    return this.port;
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "POST" || req.url !== "/permission") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      try {
        const request = JSON.parse(body) as PermissionCallbackRequest;

        this.handler(request)
          .then((response) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          })
          .catch((err) => {
            log("error", `Permission handler error: ${(err as Error).message}`);
            res.writeHead(500);
            res.end(JSON.stringify({ error: (err as Error).message }));
          });
      } catch (err) {
        log("error", `Failed to parse permission request: ${err}`);
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  }
}

function log(level: string, message: string): void {
  process.stderr.write(`[permission-callback] [${level}] ${message}\n`);
}
