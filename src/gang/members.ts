import { randomUUID } from "crypto";

/** The supervisor every member reports to. */
export const ORCHESTRATOR = "boss";

/** A spawned gang member. */
export interface Member {
  role: string;
  task: string;
  index: number;
  paneId: string;
  runId: string;
  spawnedAt: number;
  thinkingLevel?: string;
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

/** Tracks the members one boss session has spawned. One runId per boss process. */
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

  list(): Member[] {
    return [...this.members];
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
