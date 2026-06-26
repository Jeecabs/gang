import { createServer, type Server, type ServerResponse } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { SessionInfo } from "../types.js";

const DASHBOARD = join(dirname(fileURLToPath(import.meta.url)), "dashboard.html");
const GUI_HOST = "127.0.0.1";
const DEFAULT_GUI_PORT = 7717;

export function parseGuiPort(value: unknown, fallback = DEFAULT_GUI_PORT): number {
  const port = typeof value === "number" ? value : Number(value ?? fallback);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : fallback;
}

export const GUI_PORT = parseGuiPort(process.env.GANG_GUI_PORT);

/** Mission control only shows feed activity this recent (GANG_FEED_HOURS, default 6h). */
export const FEED_MAX_AGE_MS = Math.max(1, Number(process.env.GANG_FEED_HOURS) || 6) * 3_600_000;

/** Keep only feed entries within the recency window — what mission control shows on load/reconnect. */
export function recentFeed<T extends { ts?: number }>(feed: T[], now: number, maxAgeMs = FEED_MAX_AGE_MS): T[] {
  const cutoff = now - maxAgeMs;
  return feed.filter((e) => typeof e.ts === "number" && e.ts >= cutoff);
}

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
  const port = parseGuiPort(opts.port, GUI_PORT);

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
  server.listen(port, GUI_HOST, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Gang mission-control: http://${GUI_HOST}:${actualPort}`);
  });

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
