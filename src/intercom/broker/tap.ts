import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

/** One durable record per routed cross-agent message. */
export interface RoutedLogEntry {
  ts: number;
  id: string;
  from: string;
  to: string;
  text: string;
  replyTo?: string;
  expectsReply?: boolean;
}

export function getIntercomLogPath(homeDir: string = homedir()): string {
  return join(homeDir, ".pi/agent/intercom/intercom.jsonl");
}

/** Append one greppable, replayable JSONL line. Best-effort: never break routing. */
export function appendIntercomLog(entry: RoutedLogEntry, logPath: string = getIntercomLogPath()): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // ponytail: observability is best-effort; a failed log write must not drop a message.
  }
}
