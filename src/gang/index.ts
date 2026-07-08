import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "child_process";
import { promisify } from "util";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { basename, join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { ORCHESTRATOR, Roster, buildMemberEnv, computeMemberRuntimeSnapshot, isValidRole, type Member, type MemberRuntimeSnapshot } from "./members.ts";
import {
  GANG_SESSION,
  TMUX_BIN,
  hasSessionArgs,
  newSessionArgs,
  splitArgs,
  remainOnExitArgs,
  tiledLayoutArgs,
  memberCommand,
  listPanesArgs,
  listDetailedPanesArgs,
  listAllPanesArgs,
  listAllDetailedPanesArgs,
  killPaneArgs,
  killSessionArgs,
  parsePaneList,
  parseDetailedPaneList,
  type PaneDetails,
} from "./tmux.ts";
import { FeedClient } from "./feed-client.ts";
import { GUI_PORT } from "../intercom/gui/server.js";
import { MissionControlOverlay } from "./ui/mission-control.ts";
import { BOSS_NAMED_EVENT, GANG_MEMBER_REPORT_EVENT, type GangMemberReportEvent } from "./events.ts";

const execFileP = promisify(execFile);

const GANG_DIR = dirname(fileURLToPath(import.meta.url));
const GANG_INDEX = join(GANG_DIR, "index.ts");
const INTERCOM_INDEX = join(GANG_DIR, "..", "intercom", "index.ts");

const COMMAND_COMPLETIONS: AutocompleteItem[] = [
  { value: "watch", label: "watch", description: "Open mission control" },
  { value: "url", label: "url", description: "Show browser mission-control URL" },
  { value: "name ", label: "name", description: "Show or set this session's own name" },
  { value: "spawn ", label: "spawn", description: "Spawn a member: spawn [@name] [-t <level>] <task>" },
  { value: "list", label: "list", description: "Show spawned members with live pane diagnostics" },
  { value: "clean", label: "clean", description: "Reap finished panes (clean --force kills reported-done members too)" },
  { value: "stop ", label: "stop", description: "Stop one member or stop --all-finished" },
];

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type GangToolDetails = Member | { name: string } | { error: true } | undefined;
type ToolResult = AgentToolResult<GangToolDetails>;

type SpawnCommandParseResult =
  | { ok: true; name?: string; task: string; thinkingLevel?: string }
  | { ok: false; error: string };

function isThinkingLevel(value: string): boolean {
  return THINKING_LEVELS.includes(value as (typeof THINKING_LEVELS)[number]);
}

export function parseSpawnCommand(rest: string): SpawnCommandParseResult {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  let name: string | undefined;
  let thinkingLevel: string | undefined;
  let index = 0;

  // Consume leading options in any order: `-t/--thinking <level>` and a single `@name`.
  // The first token that is neither begins the task (task is free text, so a name needs the @ sigil).
  const readLead = (): boolean => {
    const token = tokens[index];
    if (!token) return false;
    if (token === "--thinking" || token === "-t") {
      const value = tokens[index + 1];
      if (!value) {
        throw new Error("--thinking requires a level: off, minimal, low, medium, high, or xhigh.");
      }
      if (!isThinkingLevel(value)) {
        throw new Error(`Invalid thinking level "${value}". Use off, minimal, low, medium, high, or xhigh.`);
      }
      thinkingLevel = value;
      index += 2;
      return true;
    }
    if (token.startsWith("--thinking=")) {
      const value = token.slice("--thinking=".length);
      if (!isThinkingLevel(value)) {
        throw new Error(`Invalid thinking level "${value}". Use off, minimal, low, medium, high, or xhigh.`);
      }
      thinkingLevel = value;
      index += 1;
      return true;
    }
    if (token.startsWith("@") && name === undefined) {
      const candidate = token.slice(1);
      if (!isValidRole(candidate)) {
        throw new Error(`Invalid name "${candidate}". Use letters, digits, _ or - (start with a letter, max 32 chars).`);
      }
      name = candidate;
      index += 1;
      return true;
    }
    return false;
  };

  try {
    while (readLead()) {}
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }

  const task = tokens.slice(index).join(" ").trim();
  if (!task) {
    return { ok: false, error: "Usage: /gang spawn [@name] [-t <level>] <task>" };
  }
  return { ok: true, name, task, thinkingLevel };
}

export function getGangArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const trimmedStart = prefix.trimStart();
  if (!trimmedStart.includes(" ")) {
    const completions = COMMAND_COMPLETIONS.filter((item) => item.label.startsWith(trimmedStart));
    return completions.length > 0 ? completions : null;
  }

  // spawn grammar is `[@name] [-t <level>] <task>`; task is free text, so only the leading
  // thinking flag and its level are completable.
  const levelMatch = trimmedStart.match(/^(spawn\s+(?:@\S+\s+)?(?:--thinking|-t)\s+)(\S*)$/);
  if (levelMatch) {
    const lead = levelMatch[1];
    const levelPrefix = levelMatch[2] ?? "";
    const completions = THINKING_LEVELS.filter((level) => level.startsWith(levelPrefix)).map((level) => ({
      value: `${lead}${level} `,
      label: level,
      description: `Use ${level} thinking`,
    }));
    return completions.length > 0 ? completions : null;
  }

  const flagMatch = trimmedStart.match(/^(spawn\s+(?:@\S+\s+)?)(-{1,2}\S*)$/);
  if (flagMatch) {
    const lead = flagMatch[1];
    const flagPrefix = flagMatch[2] ?? "";
    if ("--thinking".startsWith(flagPrefix) || "-t".startsWith(flagPrefix)) {
      return [{ value: `${lead}--thinking `, label: "--thinking", description: "Set member thinking level" }];
    }
  }

  return null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function taskFileContent(role: string, task: string, orchestrator: string): string {
  return [
    `Task: ${task}`,
    "",
    `You are "${role}", a member of a gang supervised by "${orchestrator}". Work autonomously.`,
    "If you spawn a teammate or your role needs more specificity, name yourself first with the gang tool:",
    "  gang({ action: \"name\", name: \"<clear role/name>\" })",
    "When you are finished, report your result to your supervisor and end your session in one call:",
    `  intercom({ action: "send", to: "${orchestrator}", message: "<your result>", done: true })`,
    "That delivers your result, then exits this session so your finished pane can be cleaned up.",
    "If you get blocked and need a decision, use the contact_supervisor tool instead.",
    "",
  ].join("\n");
}

export function missionControlUrl(port = GUI_PORT): string {
  return `http://127.0.0.1:${port}`;
}

function defaultBossName(cwd = process.cwd()): string {
  const project = basename(cwd).trim();
  return project ? `boss of ${project}` : ORCHESTRATOR;
}

export default function gangExtension(pi: ExtensionAPI) {
  const roster = new Roster();
  let orchestratorName = ORCHESTRATOR;
  // When pi itself runs inside tmux (and exposes its pane via $TMUX_PANE), members split into pi's own
  // window — visible alongside pi; otherwise they go to a dedicated detached `gang` session you attach
  // to. Gate on TMUX_PANE so we always have a concrete pane to target (a no-`-t` split lands in whatever
  // window is *currently active*, not pi's); no pane → fall back to detached. Fixed per boss process.
  const tmuxPane = process.env.TMUX_PANE ?? "";
  const inTmux = !!process.env.TMUX && !!tmuxPane;

  async function runTmux(args: string[]): Promise<string> {
    const { stdout } = await execFileP(TMUX_BIN, args);
    return stdout.trim();
  }

  async function ensureGangSession(): Promise<void> {
    try {
      await runTmux(hasSessionArgs());
    } catch {
      await runTmux(newSessionArgs());
    }
  }

  function writeTaskFile(role: string, task: string, index: number): string {
    const dir = join(homedir(), ".pi/agent/gang", roster.runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    const file = join(dir, `${index}-${role}.md`);
    writeFileSync(file, taskFileContent(role, task, orchestratorName), { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(file, 0o600);
    return file;
  }

  async function spawnMember(task: string, cwd: string, opts: { name?: string; thinkingLevel?: string } = {}): Promise<Member> {
    const { name, thinkingLevel } = opts;
    if (name !== undefined && !isValidRole(name)) {
      throw new Error(`Invalid name "${name}". Use letters, digits, _ or - (start with a letter, max 32 chars).`);
    }
    if (thinkingLevel && !isThinkingLevel(thinkingLevel)) {
      throw new Error(`Invalid thinking level "${thinkingLevel}". Use off, minimal, low, medium, high, or xhigh.`);
    }
    // Claim the boss identity lazily — first spawn is when we actually need to be addressable. Push
    // it onto the bus now so this member can reach us by name without waiting for our next turn.
    if (!pi.getSessionName()?.trim()) {
      pi.setSessionName(orchestratorName);
      pi.events.emit(BOSS_NAMED_EVENT, undefined);
    }
    const index = roster.nextIndex();
    const role = name ?? `m${index + 1}`;
    if (roster.hasRole(role)) {
      throw new Error(`Member "${role}" already exists in this gang. Stop it first or choose a different role.`);
    }
    const taskFile = writeTaskFile(role, task, index);
    // Forward PATH so the pane resolves `pi` even if the tmux server started with a minimal env.
    const env = { PATH: process.env.PATH ?? "", ...buildMemberEnv({ role, runId: roster.runId, index, orchestrator: orchestratorName }) };
    const command = memberCommand({ role, taskFile, intercomIndex: INTERCOM_INDEX, gangIndex: GANG_INDEX, thinkingLevel });

    if (!inTmux) await ensureGangSession();
    let paneId: string;
    try {
      paneId = await runTmux(
        splitArgs(inTmux ? { target: tmuxPane, cwd, env, command, detached: true } : { target: GANG_SESSION, cwd, env, command }),
      );
    } catch (error) {
      // In-tmux we split the user's real (bounded) window; a full window rejects with a raw tmux error.
      if (inTmux) throw new Error(`tmux couldn't add a pane (${getErrorMessage(error)}) — your tmux window may be full. Close a pane or run \`/gang clean\`, then retry.`);
      throw error;
    }
    const member: Member = { role, task, index, paneId, runId: roster.runId, spawnedAt: Date.now(), thinkingLevel };
    roster.add(member);
    // Best-effort polish; failures here must not lose the (already-tracked) member.
    await runTmux(remainOnExitArgs(paneId)).catch(() => {});
    if (inTmux) {
      // Re-tile only when pi's window holds nothing but gang panes — never reshuffle the user's own panes.
      if (await windowIsGangOnly(tmuxPane)) await runTmux(tiledLayoutArgs(tmuxPane)).catch(() => {});
    } else {
      await runTmux(tiledLayoutArgs(GANG_SESSION)).catch(() => {});
    }
    return member;
  }

  // True when every pane sharing `pane`'s window is pi's own pane or a tracked gang member — i.e.
  // re-tiling that window won't disturb any of the user's own panes. Best-effort: unknown → false.
  async function windowIsGangOnly(pane: string): Promise<boolean> {
    try {
      const inWindow = parsePaneList(await runTmux(listPanesArgs(pane)));
      const allowed = new Set([pane, ...roster.list().map((m) => m.paneId)]);
      return inWindow.every((p) => allowed.has(p.paneId));
    } catch {
      return false;
    }
  }

  function relativeAge(timestamp?: number): string {
    if (!timestamp) return "never";
    const ms = Math.max(0, Date.now() - timestamp);
    if (ms < 1000) return "just now";
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  async function loadTrackedPaneDetails(): Promise<{ panes: Map<string, PaneDetails>; warning?: string }> {
    const members = roster.list();
    if (members.length === 0) return { panes: new Map() };
    const ids = new Set(members.map((member) => member.paneId));
    try {
      const listed = inTmux
        ? parseDetailedPaneList(await runTmux(listAllDetailedPanesArgs()))
        : parseDetailedPaneList(await runTmux(listDetailedPanesArgs()));
      const panes = new Map(listed.filter((pane) => ids.has(pane.paneId)).map((pane) => [pane.paneId, pane]));
      return { panes };
    } catch (error) {
      return {
        panes: new Map(),
        warning: inTmux
          ? `Couldn't list tmux panes (${getErrorMessage(error)})`
          : "No gang session",
      };
    }
  }

  async function loadMemberSnapshots(): Promise<{ snapshots: MemberRuntimeSnapshot[]; warning?: string }> {
    const { panes, warning } = await loadTrackedPaneDetails();
    return {
      snapshots: roster.list().map((member) => computeMemberRuntimeSnapshot(member, panes.get(member.paneId))),
      warning,
    };
  }

  async function killExistingPanes(snapshots: MemberRuntimeSnapshot[]): Promise<number> {
    let killed = 0;
    const seen = new Set<string>();
    for (const snapshot of snapshots) {
      if (!snapshot.paneExists || seen.has(snapshot.member.paneId)) continue;
      seen.add(snapshot.member.paneId);
      await runTmux(killPaneArgs(snapshot.member.paneId)).catch(() => {});
      killed += 1;
    }
    return killed;
  }

  async function stopMember(role: string): Promise<string> {
    const known = roster.findByRole(role);
    if (!known) return `No gang member named "${role}".`;
    const { snapshots, warning } = await loadMemberSnapshots();
    const target = snapshots.find((snapshot) => snapshot.member.role === role) ?? computeMemberRuntimeSnapshot(known);
    const killed = await killExistingPanes([target]);
    roster.removeByRoles(new Set([role]));
    const reason = target.state === "running"
      ? "killed a live pane"
      : target.state === "reported_done"
        ? "killed a reported-done pane"
        : target.state === "pane_dead"
          ? "reaped a finished pane"
          : "pane was already gone";
    return `${warning ? `${warning}. ` : ""}Stopped "${role}": ${reason}; removed it from the roster.`;
  }

  async function stopFinishedMembers(): Promise<string> {
    const { snapshots, warning } = await loadMemberSnapshots();
    if (snapshots.length === 0) return "No gang members to stop.";
    const finished = snapshots.filter((snapshot) => snapshot.reapable);
    if (finished.length === 0) {
      return `${warning ? `${warning}. ` : ""}No finished members to stop — ${count(snapshots.length, "member")} still running.`;
    }
    const killed = await killExistingPanes(finished);
    const removed = roster.removeByRoles(new Set(finished.map((snapshot) => snapshot.member.role)));
    const reported = finished.filter((snapshot) => snapshot.state === "reported_done").length;
    const dead = finished.filter((snapshot) => snapshot.state === "pane_dead").length;
    const missing = finished.filter((snapshot) => snapshot.state === "pane_missing").length;
    return `${warning ? `${warning}. ` : ""}Stopped ${count(removed, "finished member")}: killed ${count(killed, "pane")}; removed ${reported} reported_done, ${dead} pane_dead, ${missing} pane_missing. ${count(roster.list().length, "member")} still running.`;
  }

  /**
   * Reap finished members. Default: kill dead panes and prune missing panes from the roster, leaving
   * running members alone. `force`: also kills members that already reported back. `all`: stop every
   * tracked member (kill-session when detached; kill each member pane when pi runs inside tmux).
   */
  async function cleanGang(opts: { all?: boolean; force?: boolean } = {}): Promise<string> {
    const { snapshots, warning } = await loadMemberSnapshots();
    if (snapshots.length === 0) {
      return warning === "No gang session" ? "No gang session — nothing to clean." : "No gang members to clean.";
    }

    if (opts.all) {
      if (inTmux) await killExistingPanes(snapshots);
      else if (warning !== "No gang session") await runTmux(killSessionArgs()).catch(() => {});
      const stopped = roster.list().length;
      roster.clear();
      return `${warning && warning !== "No gang session" ? `${warning}. ` : ""}Stopped the gang: cleared ${count(stopped, "member")}.`;
    }

    if (opts.force) {
      const forceTargets = snapshots.filter((snapshot) => snapshot.reapable);
      if (forceTargets.length === 0) {
        return `${warning ? `${warning}. ` : ""}Nothing to force-clean — ${count(snapshots.length, "member")} still running.`;
      }
      const killed = await killExistingPanes(forceTargets);
      const removed = roster.removeByRoles(new Set(forceTargets.map((snapshot) => snapshot.member.role)));
      return `${warning ? `${warning}. ` : ""}Force-cleaned ${count(removed, "member")}: killed ${count(killed, "pane")}. ${count(roster.list().length, "member")} still running.`;
    }

    const dead = snapshots.filter((snapshot) => snapshot.state === "pane_dead");
    const missing = snapshots.filter((snapshot) => snapshot.state === "pane_missing");
    const killed = await killExistingPanes(dead);
    const removed = roster.removeByRoles(new Set([...dead, ...missing].map((snapshot) => snapshot.member.role)));
    const running = roster.list().length;
    if (dead.length === 0 && missing.length === 0) {
      return `${warning ? `${warning}. ` : ""}Nothing to reap — ${count(running, "member")} still running.`;
    }
    return `${warning ? `${warning}. ` : ""}Reaped ${count(killed, "finished pane")}, pruned ${count(removed - dead.length, "stale member")} from the roster. ${count(running, "member")} still running.`;
  }

  // Where to look for members: in-tmux they're splits in the current window; else the detached session.
  function watchHint(): string {
    return inTmux ? "Members are splits in your current tmux window." : `Watch live: tmux attach -t ${GANG_SESSION}`;
  }

  async function formatRoster(): Promise<string> {
    const watch = watchHint();
    const { snapshots, warning } = await loadMemberSnapshots();
    if (snapshots.length === 0) {
      return `No gang members spawned yet (run ${roster.runId.slice(0, 8)}). Use \`/gang spawn <task>\` to launch one.`;
    }
    const rows = snapshots.map((snapshot) => {
      const m = snapshot.member;
      const preview = m.task.replace(/\s+/g, " ").slice(0, 60);
      const thinking = m.thinkingLevel ? ` — thinking ${m.thinkingLevel}` : "";
      const command = snapshot.currentCommand ? ` — cmd ${snapshot.currentCommand}` : "";
      const reported = m.reportedDoneAt ? ` — reported ${relativeAge(m.reportedDoneAt)}` : " — reported no";
      const lastReport = m.lastReportText ? ` — last: ${m.lastReportText.replace(/\s+/g, " ").slice(0, 40)}` : "";
      return `• ${m.role} — pane ${m.paneId}${thinking} — ${snapshot.state} — exists ${snapshot.paneExists ? "yes" : "no"} — alive ${snapshot.processAlive ? "yes" : "no"}${command}${reported} — reapable ${snapshot.reapable ? "yes" : "no"}${lastReport} — ${preview}`;
    });
    const diagnostic = warning ? `\ntmux: ${warning}` : "";
    return `Gang members (run ${roster.runId.slice(0, 8)}). ${watch}${diagnostic}\n${rows.join("\n")}`;
  }

  function spawnedMessage(m: Member): string {
    const thinking = m.thinkingLevel ? ` with ${m.thinkingLevel} thinking` : "";
    const where = inTmux ? "split into your current window" : `session: ${GANG_SESSION}`;
    return [
      `Launched member "${m.role}"${thinking} in tmux pane ${m.paneId} (${where}).`,
      watchHint(),
      `Its result will arrive here as an intercom message from "${m.role}" — keep working; don't block on it.`,
    ].join("\n");
  }

  // In-pi mission control: same live feed as the browser GUI, rendered as a TUI overlay.
  async function openMissionControl(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    const feed = new FeedClient().start();
    try {
      await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
        new MissionControlOverlay(tui, theme, keybindings, feed, done,
          () => Object.fromEntries(roster.list().map((m) => [m.role, m.task]))));
    } finally {
      feed.stop();
    }
  }

  // Compute the orchestrator identity but DON'T persist it yet. Naming every session at startup
  // floods `pi -r` with identical "boss of <folder>" entries; we claim the name lazily on the first
  // spawn (see spawnMember), so sessions that never use gang keep their natural resume title.
  // A child already has its --name role as its session name, so existingName keeps that.
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const existingName = pi.getSessionName()?.trim();
    orchestratorName = existingName || defaultBossName(ctx.cwd ?? process.cwd());
  });

  pi.events.on(GANG_MEMBER_REPORT_EVENT, (payload) => {
    const report = payload as GangMemberReportEvent | undefined;
    const sender = report?.fromName?.trim() || report?.fromId?.trim() || "";
    if (!sender || report?.expectsReply) return;
    roster.markReportedDone(sender, report?.timestamp, report?.text);
  });

  pi.registerTool({
    name: "gang",
    label: "Gang",
    description: `Fire up and track visible subagent "members" as live tmux panes.

Usage:
  gang({ action: "spawn", task: "..." })                                       → launch a member (auto-named m1, m2, …)
  gang({ action: "spawn", task: "...", role: "reviewer", thinking: "high" })   → launch with an explicit name
  gang({ action: "list" })                                                     → show members with live pane diagnostics
  gang({ action: "clean" })                                                    → reap dead/missing panes + prune the roster
  gang({ action: "clean", force: true })                                       → also kill members that already reported back
  gang({ action: "stop", role: "reviewer" })                                 → stop one member immediately
  gang({ action: "stop", finished: true })                                     → stop all reapable members
  gang({ action: "name", name: "boss of private evals" })                      → name this agent/session

Only "task" is required for spawn. spawn returns immediately. The member runs its own pi session in a tmux pane (${inTmux ? "split into your current window" : `watch: tmux attach -t ${GANG_SESSION}`}). When done it sends its result back to you ("boss") as an intercom message — it does NOT return here. Keep working; handle the result when it arrives.`,
    promptSnippet: `Spawn visible subagent members in tmux panes (gang spawn with a task; role/name is optional and auto-assigned), inspect them with live pane diagnostics (gang list), clean them up (gang clean / stop), or name the current agent/session (gang name). When you spin up a teammate or need a specific identity, name yourself first with gang({ action: "name", name: "<clear role/name>" }). Spawn results return asynchronously as intercom messages, not tool results.`,
    parameters: Type.Object({
      action: Type.String({ description: "'spawn', 'list', 'clean', 'stop', or 'name'" }),
      role: Type.Optional(Type.String({ description: "Spawn name/role, or the specific member to stop when action='stop'." })),
      task: Type.Optional(Type.String({ description: "What the member should do (required for spawn)" })),
      thinking: Type.Optional(Type.String({ description: "Optional Pi thinking level for spawn: off, minimal, low, medium, high, or xhigh" })),
      name: Type.Optional(Type.String({ description: "New name for this agent/session when action='name'" })),
      all: Type.Optional(Type.Boolean({ description: "When action='clean', stop every tracked member." })),
      force: Type.Optional(Type.Boolean({ description: "When action='clean', also kill members that already reported back." })),
      finished: Type.Optional(Type.Boolean({ description: "When action='stop', stop all reapable members instead of one named role." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      const action = params.action;
      if (action === "spawn") {
        if (typeof params.task !== "string" || !params.task) {
          return { content: [{ type: "text", text: "spawn requires 'task'." }], details: { error: true } };
        }
        const name = typeof params.role === "string" && params.role.trim() ? params.role.trim() : undefined;
        const thinkingLevel = typeof params.thinking === "string" ? params.thinking : undefined;
        try {
          orchestratorName = pi.getSessionName()?.trim() || orchestratorName;
          const member = await spawnMember(params.task, ctx.cwd ?? process.cwd(), { name, thinkingLevel });
          return { content: [{ type: "text", text: spawnedMessage(member) }], details: member };
        } catch (error) {
          return { content: [{ type: "text", text: `gang spawn failed: ${getErrorMessage(error)}` }], details: { error: true } };
        }
      }
      if (action === "list") {
        return { content: [{ type: "text", text: await formatRoster() }], details: undefined };
      }
      if (action === "clean") {
        return { content: [{ type: "text", text: await cleanGang({ all: params.all === true, force: params.force === true }) }], details: undefined };
      }
      if (action === "stop") {
        if (params.finished === true) {
          return { content: [{ type: "text", text: await stopFinishedMembers() }], details: undefined };
        }
        const role = typeof params.role === "string" ? params.role.trim() : "";
        if (!role) {
          return { content: [{ type: "text", text: "stop requires 'role', or set finished:true to stop all reapable members." }], details: { error: true } };
        }
        return { content: [{ type: "text", text: await stopMember(role) }], details: undefined };
      }
      if (action === "name") {
        const nextName = typeof params.name === "string" ? params.name.trim() : "";
        if (!nextName) {
          const currentName = pi.getSessionName()?.trim() || orchestratorName;
          return { content: [{ type: "text", text: `Agent name: ${currentName}` }], details: undefined };
        }
        pi.setSessionName(nextName);
        orchestratorName = nextName;
        return { content: [{ type: "text", text: `Agent name set: ${nextName}` }], details: { name: nextName } };
      }
      return { content: [{ type: "text", text: `Unknown action "${action}". Use 'spawn', 'list', 'clean', 'stop', or 'name'.` }], details: { error: true } };
    },
  });

  pi.registerCommand("gang", {
    description: "Mission control (/gang watch), roster (/gang), or spawn (/gang spawn [@name] [-t <level>] <task>)",
    getArgumentCompletions: getGangArgumentCompletions,
    async handler(args, ctx: ExtensionContext) {
      const say = (msg: string, level: "info" | "warning" | "error") => {
        if (ctx.hasUI) ctx.ui.notify(msg, level);
      };
      const trimmed = args.trim();
      if (trimmed === "watch") {
        await openMissionControl(ctx);
        return;
      }
      if (trimmed === "url") {
        say(`Mission control: ${missionControlUrl()}`, "info");
        return;
      }
      if (trimmed === "name") {
        orchestratorName = pi.getSessionName()?.trim() || orchestratorName;
        say(`Agent name: ${orchestratorName}`, "info");
        return;
      }
      if (trimmed.startsWith("name ")) {
        const nextName = trimmed.slice("name ".length).trim();
        if (!nextName) {
          say("Usage: /gang name <name>", "warning");
          return;
        }
        orchestratorName = nextName;
        pi.setSessionName(nextName);
        say(`Agent name set: ${nextName}`, "info");
        return;
      }
      if (trimmed === "" || trimmed === "list") {
        say(await formatRoster(), "info");
        return;
      }
      if (trimmed === "clean" || trimmed === "clean all" || trimmed === "clean --force") {
        say(await cleanGang({ all: trimmed === "clean all", force: trimmed === "clean --force" }), "info");
        return;
      }
      if (trimmed === "stop") {
        say("Usage: /gang stop <member> or /gang stop --all-finished", "warning");
        return;
      }
      if (trimmed === "stop --all-finished") {
        say(await stopFinishedMembers(), "info");
        return;
      }
      if (trimmed.startsWith("stop ")) {
        say(await stopMember(trimmed.slice("stop ".length).trim()), "info");
        return;
      }
      if (trimmed.startsWith("spawn")) {
        const parsed = parseSpawnCommand(trimmed.slice("spawn".length));
        if (!parsed.ok) {
          say(parsed.error, "warning");
          return;
        }
        try {
          orchestratorName = pi.getSessionName()?.trim() || orchestratorName;
          const member = await spawnMember(parsed.task, ctx.cwd ?? process.cwd(), { name: parsed.name, thinkingLevel: parsed.thinkingLevel });
          const thinking = member.thinkingLevel ? ` (${member.thinkingLevel} thinking)` : "";
          say(`Launched "${member.role}"${thinking} in pane ${member.paneId}. ${watchHint()}`, "info");
        } catch (error) {
          say(`gang spawn failed: ${getErrorMessage(error)}`, "error");
        }
        return;
      }
      say(`Unknown gang command "${trimmed}". Use /gang, /gang list, /gang clean [all|--force], /gang stop <member>, /gang stop --all-finished, /gang url, /gang name <name>, /gang watch, or /gang spawn [@name] [-t <level>] <task>.`, "warning");
    },
  });

  pi.registerShortcut("alt+g", {
    description: "Open gang mission control",
    handler: async (ctx) => openMissionControl(ctx),
  });
}
