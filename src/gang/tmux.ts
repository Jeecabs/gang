import { existsSync } from "fs";

/** The dedicated tmux session that hosts all members. Watch with: tmux attach -t gang */
export const GANG_SESSION = "gang";

/** Prefer Homebrew tmux (the user's), fall back to PATH. Override with GANG_TMUX_BIN. */
export const TMUX_BIN =
  process.env.GANG_TMUX_BIN ||
  (existsSync("/opt/homebrew/bin/tmux") ? "/opt/homebrew/bin/tmux" : "tmux");

/** `-e KEY=VAL` flags that set the spawned pane's environment. */
export function envFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

export function hasSessionArgs(session = GANG_SESSION): string[] {
  return ["has-session", "-t", session];
}

export function newSessionArgs(session = GANG_SESSION): string[] {
  return ["new-session", "-d", "-s", session, "-x", "220", "-y", "50"];
}

/**
 * Split a new pane and print its pane id (`-P -F '#{pane_id}'`). With `session`, split inside that
 * session; without it, split the *current* window (tmux uses $TMUX to find the active pane). `detached`
 * adds `-d` so the new pane doesn't steal focus from the caller's pane (keeps you driving pi).
 */
export function splitArgs(opts: { session?: string; cwd: string; env: Record<string, string>; command: string; detached?: boolean }): string[] {
  const target = opts.session ? ["-t", opts.session] : [];
  return [
    "split-window",
    ...target,
    ...(opts.detached ? ["-d"] : []),
    "-P",
    "-F",
    "#{pane_id}",
    "-c",
    opts.cwd,
    ...envFlags(opts.env),
    opts.command,
  ];
}

/** Keep a member's pane visible after its pi process exits (so you can read the final state). */
export function remainOnExitArgs(paneId: string): string[] {
  return ["set-option", "-p", "-t", paneId, "remain-on-exit", "on"];
}

/** Re-tile so every member pane stays visible as the gang grows. No session → the current window. */
export function tiledLayoutArgs(session?: string): string[] {
  const target = session ? ["-t", session] : [];
  return ["select-layout", ...target, "tiled"];
}

/** Focus a member's pane (Phase 5 GUI click-to-focus). */
export function selectPaneArgs(paneId: string): string[] {
  return ["select-pane", "-t", paneId];
}

/** List every pane in the session with its dead flag: lines of `#{pane_id} #{pane_dead}`. */
export function listPanesArgs(session = GANG_SESSION): string[] {
  return ["list-panes", "-t", session, "-F", "#{pane_id} #{pane_dead}"];
}

/** Server-wide pane list (`-a`) — for in-tmux mode, where members live in the user's own windows. */
export function listAllPanesArgs(): string[] {
  return ["list-panes", "-a", "-F", "#{pane_id} #{pane_dead}"];
}

/** Reap one finished pane (a member whose pi process exited but remain-on-exit kept it). */
export function killPaneArgs(paneId: string): string[] {
  return ["kill-pane", "-t", paneId];
}

/** Nuke the whole gang session — stops every member, running or not. */
export function killSessionArgs(session = GANG_SESSION): string[] {
  return ["kill-session", "-t", session];
}

export interface PaneState {
  paneId: string;
  dead: boolean;
}

/** Parse `list-panes -F '#{pane_id} #{pane_dead}'` output. `pane_dead` is 1 for a finished pane. */
export function parsePaneList(stdout: string): PaneState[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [paneId, dead] = line.split(/\s+/);
      return { paneId, dead: dead === "1" };
    });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell-command tmux runs in the member's pane. Task is passed via @file (no shell quoting of
 * task text). --no-extensions + explicit -e load exactly intercom+gang, regardless of install state.
 */
export function memberCommand(opts: { role: string; taskFile: string; intercomIndex: string; gangIndex: string; thinkingLevel?: string }): string {
  return [
    "pi",
    "--name",
    opts.role,
    ...(opts.thinkingLevel ? ["--thinking", opts.thinkingLevel] : []),
    "--no-extensions",
    "-e",
    shellQuote(opts.intercomIndex),
    "-e",
    shellQuote(opts.gangIndex),
    `@${shellQuote(opts.taskFile)}`,
  ].join(" ");
}
