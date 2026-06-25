import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "../../intercom/types.js";
import type { FeedClient, FeedEvent } from "../feed-client.js";

export interface FeedItem {
  ts: number;
  from: string;
  to: string;
  text: string;
  expectsReply?: boolean;
}

export interface MissionState {
  members: SessionInfo[];
  feed: FeedItem[];
  online: boolean;
  /** Current time for uptime/idle math; defaults to Date.now() when omitted (keeps tests deterministic). */
  now?: number;
  /** role → task, joined from the boss's Roster so each member shows what it's doing. */
  tasks?: Record<string, string>;
}

/** Minimal theme surface so render() is unit-testable with a plain stub. */
interface RenderTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

function statusGlyph(status: string): string {
  if (status.startsWith("tool:")) return "◆";
  if (status.startsWith("thinking")) return "◐";
  if (status.startsWith("idle")) return "●";
  return "·";
}

function statusColor(status: string): string {
  if (status.startsWith("tool:")) return "accent";
  if (status.startsWith("thinking")) return "warning";
  if (status.startsWith("idle")) return "success";
  return "muted";
}

function pad(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Compact duration: 3s / 12m / 2h / 1d. */
function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Count members by status category for the header histogram. */
function statusHistogram(members: SessionInfo[], theme: RenderTheme): string {
  let tool = 0, thinking = 0, idle = 0, other = 0;
  for (const m of members) {
    const s = m.status || "";
    if (s.startsWith("tool:")) tool++;
    else if (s.startsWith("thinking")) thinking++;
    else if (s.startsWith("idle")) idle++;
    else other++;
  }
  const chip = (n: number, glyph: string, color: string) => (n ? theme.fg(color, `${glyph}${n}`) : "");
  return [
    chip(tool, "◆", "accent"),
    chip(thinking, "◐", "warning"),
    chip(idle, "●", "success"),
    chip(other, "·", "muted"),
  ].filter(Boolean).join(" ");
}

/** Pure renderer: state + theme + width → terminal lines. No I/O, fully testable. */
export function renderMissionControl(state: MissionState, theme: RenderTheme, width: number): string[] {
  const inner = Math.max(44, Math.min(width - 2, 104));
  const content = inner - 4; // 1 border + 1 space padding each side
  const border = (s: string) => theme.fg("accent", s);
  const lines: string[] = [];

  const row = (text = "") => {
    const clipped = truncateToWidth(text, content, "", true);
    return `${border("│")} ${clipped}${" ".repeat(Math.max(0, content - visibleWidth(clipped)))} ${border("│")}`;
  };

  // Title bar with right-aligned connection state.
  const title = theme.bold("gang") + theme.fg("muted", " · mission control");
  const live = state.online ? theme.fg("success", "● live") : theme.fg("muted", "○ offline");
  const titleGap = Math.max(1, content - visibleWidth(title) - visibleWidth(live));
  lines.push(border(`╭${"─".repeat(inner - 2)}╮`));
  lines.push(row(`${title}${" ".repeat(titleGap)}${live}`));
  lines.push(border(`├${"─".repeat(inner - 2)}┤`));

  // Members. Header carries a status histogram (◆tool ◐think ●idle) right-aligned.
  const now = state.now ?? Date.now();
  const tasks = state.tasks ?? {};
  const head = theme.fg("muted", `MEMBERS · ${state.members.length}`);
  const hist = statusHistogram(state.members, theme);
  const headGap = Math.max(2, content - visibleWidth(head) - visibleWidth(hist));
  lines.push(row(hist ? `${head}${" ".repeat(headGap)}${hist}` : head));
  if (state.members.length === 0) {
    lines.push(row(theme.fg("dim", "  no members yet — gang spawn <role> <task>")));
  } else {
    const nameWidth = Math.min(18, Math.max(6, ...state.members.map((m) => visibleWidth(m.name || m.id.slice(0, 8)))));
    const statusWidth = Math.min(16, Math.max(4, ...state.members.map((m) => visibleWidth(m.status || "—"))));
    for (const m of state.members) {
      const status = m.status || "—";
      const name = m.name || m.id.slice(0, 8);
      const color = statusColor(status);
      const glyph = theme.fg(color, statusGlyph(status));
      const shown = status.length > statusWidth ? status.slice(0, statusWidth - 1) + "…" : status;
      const label = theme.fg(color, pad(shown, statusWidth));
      const up = m.startedAt > 0 ? fmtDur(now - m.startedAt) : "";
      const idle = m.lastActivity > 0 ? `·${fmtDur(now - m.lastActivity)}` : "";
      const metrics = theme.fg("dim", pad(`${up} ${idle}`.trim(), 9));
      const taskText = tasks[name] ? theme.fg("dim", tasks[name].replace(/\s+/g, " ")) : "";
      lines.push(row(`${glyph} ${theme.bold(pad(name, nameWidth))}  ${label}  ${metrics}  ${taskText}`));
    }
  }
  lines.push(row());

  // Feed (newest first).
  lines.push(row(theme.fg("muted", "FEED")));
  if (state.feed.length === 0) {
    lines.push(row(theme.fg("dim", "  waiting for messages…")));
  } else {
    const routeWidth = Math.min(
      26,
      Math.max(...state.feed.map((f) => visibleWidth(`${f.from} → ${f.to}`))),
    );
    for (const f of state.feed.slice(0, 12)) {
      const route = `${theme.fg("accent", f.from)} ${theme.fg("dim", "→")} ${theme.fg("warning", f.to)}`;
      const routePadded = route + " ".repeat(Math.max(0, routeWidth - visibleWidth(`${f.from} → ${f.to}`)));
      const flag = f.expectsReply ? theme.fg("warning", " (awaiting reply)") : "";
      const time = theme.fg("dim", hhmm(f.ts));
      const text = f.text.replace(/\s+/g, " ");
      lines.push(row(`${time}  ${routePadded}  ${theme.fg("text", text)}${flag}`));
    }
  }

  lines.push(border(`├${"─".repeat(inner - 2)}┤`));
  lines.push(row(theme.fg("dim", "esc  close")));
  lines.push(border(`╰${"─".repeat(inner - 2)}╯`));
  return lines;
}

export class MissionControlOverlay implements Component {
  private members = new Map<string, SessionInfo>();
  private feed: FeedItem[] = [];
  private online = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    feed: FeedClient,
    private readonly done: () => void,
    private readonly getTasks: () => Record<string, string> = () => ({}),
  ) {
    feed.on("status", (s: string) => {
      this.online = s === "up";
      this.tui.requestRender();
    });
    feed.on("event", (ev: FeedEvent) => {
      this.apply(ev);
      this.tui.requestRender();
    });
  }

  private apply(ev: FeedEvent): void {
    switch (ev.type) {
      case "snapshot":
        this.members.clear();
        for (const s of (ev.sessions as SessionInfo[]) ?? []) this.members.set(s.id, s);
        // Buffer is oldest→newest; overlay renders feed[0] as newest, so reverse.
        this.feed = ((ev.feed as Array<Record<string, unknown>>) ?? [])
          .map((m) => ({
            ts: (m.ts as number) ?? Date.now(),
            from: m.from as string,
            to: m.to as string,
            text: (m.text as string) ?? "",
            expectsReply: m.expectsReply as boolean | undefined,
          }))
          .reverse();
        break;
      case "session_joined":
      case "presence_update": {
        const s = ev.session as SessionInfo;
        if (s) this.members.set(s.id, s);
        break;
      }
      case "session_left":
        this.members.delete(ev.sessionId as string);
        break;
      case "message":
        this.feed.unshift({
          ts: (ev.ts as number) ?? Date.now(),
          from: ev.from as string,
          to: ev.to as string,
          text: (ev.text as string) ?? "",
          expectsReply: ev.expectsReply as boolean | undefined,
        });
        this.feed = this.feed.slice(0, 50);
        break;
    }
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done();
    }
  }

  render(width: number): string[] {
    return renderMissionControl(
      { members: [...this.members.values()], feed: this.feed, online: this.online, now: Date.now(), tasks: this.getTasks() },
      this.theme,
      width,
    );
  }
}
