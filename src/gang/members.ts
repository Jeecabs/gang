import { randomUUID } from "crypto";
import type { PaneDetails } from "./tmux.ts";

/** The superintendent every member reports to. */
export const ORCHESTRATOR = "superintendent";

/** A spawned gang member. */
export interface Member {
  role: string;
  task: string;
  index: number;
  paneId: string;
  runId: string;
  spawnedAt: number;
  thinkingLevel?: string;
  deadlineAt?: number;
  reportedDoneAt?: number;
  lastReportText?: string;
}

export interface MemberRuntimeSnapshot {
  member: Member;
  paneExists: boolean;
  paneDead: boolean;
  processAlive: boolean;
  currentCommand?: string;
  reportedDone: boolean;
  state: "running" | "reported_done" | "pane_dead" | "pane_missing";
  reapable: boolean;
}

export function computeMemberRuntimeSnapshot(member: Member, pane?: PaneDetails): MemberRuntimeSnapshot {
  const paneExists = !!pane;
  const paneDead = pane?.dead ?? false;
  const reportedDone = typeof member.reportedDoneAt === "number";
  const state = !paneExists
    ? "pane_missing"
    : paneDead
      ? "pane_dead"
      : reportedDone
        ? "reported_done"
        : "running";
  return {
    member,
    paneExists,
    paneDead,
    processAlive: paneExists && !paneDead,
    currentCommand: pane?.currentCommand,
    reportedDone,
    state,
    reapable: state !== "running",
  };
}

/**
 * The 5 env vars pi-intercom reads at child startup (index.ts readChildOrchestratorMetadata):
 * presence name comes from pi's --name flag, but these unlock the contact_supervisor tool and
 * tell the member who its supervisor is.
 */
export function buildMemberEnv(opts: { role: string; runId: string; index: number; orchestrator?: string }): Record<string, string> {
  return {
    PI_SUBAGENT_INTERCOM_SESSION_NAME: opts.role,
    PI_SUBAGENT_ORCHESTRATOR_TARGET: opts.orchestrator ?? ORCHESTRATOR,
    PI_SUBAGENT_RUN_ID: opts.runId,
    PI_SUBAGENT_CHILD_AGENT: opts.role,
    PI_SUBAGENT_CHILD_INDEX: String(opts.index),
  };
}

/** A role must be a safe token: valid tmux session name, shell-safe, addressable on the bus. */
export function isValidRole(role: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(role);
}

export class MemberDeadlineTimers {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  schedule(role: string, deadlineAt: number, onDeadline: (role: string) => void): void {
    this.clear(role);
    const timer = setTimeout(() => {
      this.timers.delete(role);
      onDeadline(role);
    }, Math.max(1, deadlineAt - Date.now()));
    timer.unref?.();
    this.timers.set(role, timer);
  }

  clear(role: string): void {
    const timer = this.timers.get(role);
    if (timer) clearTimeout(timer);
    this.timers.delete(role);
  }

  clearMany(roles: Iterable<string>): void {
    for (const role of roles) this.clear(role);
  }

  clearAll(): void {
    this.clearMany(this.timers.keys());
  }
}

/** Tracks the members one superintendent session has spawned. One runId per superintendent process. */
export class Roster {
  readonly runId = randomUUID();
  private members: Member[] = [];
  private counter = 0;

  nextIndex(): number {
    return this.counter++;
  }

  add(member: Member): void {
    this.members.push(member);
  }

  hasRole(role: string): boolean {
    return this.members.some((member) => member.role === role);
  }

  findByRole(role: string): Member | undefined {
    return this.members.find((member) => member.role === role);
  }

  findByChildIdentity(runId: string, agent: string, index: string): Member | undefined {
    return this.members.find((member) => (
      member.runId === runId
      && member.role === agent
      && String(member.index) === index
    ));
  }

  markReportedDone(role: string, reportedDoneAt = Date.now(), text?: string): boolean {
    const member = this.findByRole(role);
    if (!member) return false;
    member.reportedDoneAt = reportedDoneAt;
    if (typeof text === "string" && text.trim()) member.lastReportText = text.trim();
    return true;
  }

  list(): Member[] {
    return [...this.members];
  }

  removeByRoles(roles: Set<string>): number {
    const before = this.members.length;
    this.members = this.members.filter((member) => !roles.has(member.role));
    return before - this.members.length;
  }

  /** Drop members whose pane is gone/dead; returns how many were removed. */
  prune(alivePaneIds: Set<string>): number {
    const before = this.members.length;
    this.members = this.members.filter((m) => alivePaneIds.has(m.paneId));
    return before - this.members.length;
  }

  clear(): void {
    this.members = [];
  }
}
