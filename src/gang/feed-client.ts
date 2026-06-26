import http from "http";
import { EventEmitter } from "events";
import { GUI_PORT } from "../intercom/gui/server.js";

/** A parsed event from the broker's SSE feed (same stream the browser dashboard consumes). */
export interface FeedEvent {
  type: "snapshot" | "session_joined" | "session_left" | "presence_update" | "message";
  [key: string]: unknown;
}

/**
 * Consumes the broker's `/events` SSE stream in-process so the in-pi overlay renders the exact
 * same feed as the browser GUI. Reconnects if the broker restarts. Emits:
 *   "event"  (FeedEvent)        — each parsed feed event
 *   "status" ("up" | "down")    — connection state for the overlay's live indicator
 */
export class FeedClient extends EventEmitter {
  private req?: http.ClientRequest;
  private reconnectTimer?: NodeJS.Timeout;
  private buf = "";
  private stopped = false;

  constructor(private readonly port: number = GUI_PORT) {
    super();
  }

  start(): this {
    this.connect();
    return this;
  }

  private connect(): void {
    if (this.stopped) return;
    this.req = http.get({ host: "127.0.0.1", port: this.port, path: "/events" }, (res) => {
      if (res.statusCode !== 200) {
        res.destroy();
        this.scheduleReconnect();
        return;
      }
      this.clearReconnectTimer();
      this.emit("status", "up");
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => this.onData(chunk));
      res.on("close", () => this.scheduleReconnect());
    });
    this.req.on("error", () => this.scheduleReconnect());
  }

  /** Parse SSE frames (separated by blank lines); ignore comment/keepalive lines. */
  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const frame = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      try {
        this.emit("event", JSON.parse(dataLine.slice(6)) as FeedEvent);
      } catch {
        // ignore malformed frame
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.emit("status", "down");
    this.buf = "";
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 1000);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.req?.destroy();
    this.removeAllListeners();
  }
}
