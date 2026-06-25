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

/** Split a new pane in the session and print its pane id (`-P -F '#{pane_id}'`). */
export function splitArgs(opts: { session?: string; cwd: string; env: Record<string, string>; command: string }): string[] {
  const target = opts.session ? ["-t", opts.session] : [];
  return [
    "split-window",
    ...target,
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

/** Re-tile so every member pane stays visible as the gang grows. */
export function tiledLayoutArgs(session = GANG_SESSION): string[] {
  return ["select-layout", "-t", session, "tiled"];
}

/** Focus a member's pane (Phase 5 GUI click-to-focus). */
export function selectPaneArgs(paneId: string): string[] {
  return ["select-pane", "-t", paneId];
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
