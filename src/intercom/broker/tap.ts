import { appendFileSync, chmodSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { getIntercomDirPath } from "./paths.ts";

/** One durable record per routed cross-agent message. */
export interface RoutedLogEntry {
  ts: number;
  id: string;
  from: string;
  to: string;
  text: string;
  replyTo?: string;
  expectsReply?: boolean;
  supersedes?: string;
  retryOf?: string;
  subagent?: {
    runId: string;
    agent: string;
    index: string;
    final: boolean;
  };
}

export function getIntercomLogPath(intercomDir: string = getIntercomDirPath()): string {
  return join(intercomDir, "intercom.jsonl");
}

/** Append one greppable, replayable JSONL line. Best-effort: never break routing. */
export function appendIntercomLog(entry: RoutedLogEntry, logPath: string = getIntercomLogPath()): void {
  try {
    const dir = dirname(logPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    appendFileSync(logPath, JSON.stringify(entry) + "\n", { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(logPath, 0o600);
  } catch {
    // ponytail: observability is best-effort; a failed log write must not drop a message.
  }
}
