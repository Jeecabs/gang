import { createServer, type Server, type ServerResponse } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { SessionInfo } from "../types.js";

const DASHBOARD = join(dirname(fileURLToPath(import.meta.url)), "dashboard.html");
export const GUI_PORT = Number(process.env.GANG_GUI_PORT ?? 7717);

export interface GuiServer {
  /** Push an event to every connected browser (SSE). */
  broadcast(event: Record<string, unknown>): void;
  close(): void;
  server: Server;
}

/**
 * Mission-control: serves a vanilla dashboard at / and an SSE feed at /events.
 * Optional and best-effort — a busy port disables the GUI, never crashes the broker.
 */
export interface GuiSnapshot {
  sessions: SessionInfo[];
  feed: Record<string, unknown>[];
}

export function startGuiServer(opts: { port?: number; getSnapshot: () => GuiSnapshot }): GuiServer {
  const clients = new Set<ServerResponse>();
  const port = opts.port ?? GUI_PORT;

  const server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      try {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(DASHBOARD));
      } catch {
        res.writeHead(500);
        res.end("dashboard.html missing");
      }
      return;
    }
    if (req.url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const snap = opts.getSnapshot();
      res.write(`data: ${JSON.stringify({ type: "snapshot", sessions: snap.sessions, feed: snap.feed })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`Gang GUI disabled: ${err.message}`);
  });
  server.listen(port, () => console.log(`Gang mission-control: http://localhost:${port}`));

  return {
    broadcast(event) {
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of clients) {
        try {
          res.write(payload);
        } catch {
          clients.delete(res);
        }
      }
    },
    close() {
      for (const res of clients) {
        try {
          res.end();
        } catch {
          // already gone
        }
      }
      clients.clear();
      server.close();
    },
    server,
  };
}
