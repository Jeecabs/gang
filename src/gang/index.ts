import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdirSync, writeFileSync } from "fs";
import { basename, join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { ORCHESTRATOR, Roster, buildMemberEnv, isValidRole, type Member } from "./members.ts";
import {
  GANG_SESSION,
  TMUX_BIN,
  hasSessionArgs,
  newSessionArgs,
  splitArgs,
  remainOnExitArgs,
  tiledLayoutArgs,
  memberCommand,
} from "./tmux.ts";
import { FeedClient } from "./feed-client.ts";
import { GUI_PORT } from "../intercom/gui/server.js";
import { MissionControlOverlay } from "./ui/mission-control.ts";

const execFileP = promisify(execFile);

const GANG_DIR = dirname(fileURLToPath(import.meta.url));
const GANG_INDEX = join(GANG_DIR, "index.ts");
const INTERCOM_INDEX = join(GANG_DIR, "..", "intercom", "index.ts");

const COMMAND_COMPLETIONS: AutocompleteItem[] = [
  { value: "watch", label: "watch", description: "Open mission control" },
  { value: "url", label: "url", description: "Show browser mission-control URL" },
  { value: "name ", label: "name", description: "Show or set this session's own name" },
  { value: "spawn ", label: "spawn", description: "Spawn a member: spawn [@name] [-t <level>] <task>" },
  { value: "list", label: "list", description: "Show spawned members" },
];

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

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

function taskFileContent(role: string, task: string, orchestrator: string): string {
  return [
    `Task: ${task}`,
    "",
    `You are "${role}", a member of a gang supervised by "${orchestrator}". Work autonomously.`,
    "If you spawn a teammate or your role needs more specificity, name yourself first with the gang tool:",
    "  gang({ action: \"name\", name: \"<clear role/name>\" })",
    "When you are finished, send your result to your supervisor with the intercom tool:",
    `  intercom({ action: "send", to: "${orchestrator}", message: "<your result>" })`,
    "If you get blocked and need a decision, use the contact_supervisor tool instead.",
    "",
  ].join("\n");
}

export function missionControlUrl(port = GUI_PORT): string {
  return `http://localhost:${port}`;
}

function defaultBossName(cwd = process.cwd()): string {
  const project = basename(cwd).trim();
  return project ? `boss of ${project}` : ORCHESTRATOR;
}

export default function gangExtension(pi: ExtensionAPI) {
  const roster = new Roster();
  let orchestratorName = ORCHESTRATOR;

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
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${index}-${role}.md`);
    writeFileSync(file, taskFileContent(role, task, orchestratorName));
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
    const index = roster.nextIndex();
    const role = name ?? `m${index + 1}`;
    const taskFile = writeTaskFile(role, task, index);
    // Forward PATH so the pane resolves `pi` even if the tmux server started with a minimal env.
    const env = { PATH: process.env.PATH ?? "", ...buildMemberEnv({ role, runId: roster.runId, index, orchestrator: orchestratorName }) };
    const command = memberCommand({ role, taskFile, intercomIndex: INTERCOM_INDEX, gangIndex: GANG_INDEX, thinkingLevel });

    await ensureGangSession();
    const paneId = await runTmux(splitArgs({ session: GANG_SESSION, cwd, env, command }));
    // Best-effort polish; failures here must not lose the (already launched) member.
    await runTmux(remainOnExitArgs(paneId)).catch(() => {});
    await runTmux(tiledLayoutArgs()).catch(() => {});

    const member: Member = { role, task, index, paneId, runId: roster.runId, spawnedAt: Date.now(), thinkingLevel };
    roster.add(member);
    return member;
  }

  function formatRoster(): string {
    const members = roster.list();
    const watch = `Watch live: tmux attach -t ${GANG_SESSION}`;
    if (members.length === 0) {
      return `No gang members spawned yet (run ${roster.runId.slice(0, 8)}). Use \`/gang spawn <task>\` to launch one.`;
    }
    const rows = members.map((m) => {
      const preview = m.task.replace(/\s+/g, " ").slice(0, 60);
      const thinking = m.thinkingLevel ? ` — thinking ${m.thinkingLevel}` : "";
      return `• ${m.role} — pane ${m.paneId}${thinking} — ${preview}`;
    });
    return `Gang members (run ${roster.runId.slice(0, 8)}). ${watch}\n${rows.join("\n")}`;
  }

  function spawnedMessage(m: Member): string {
    const thinking = m.thinkingLevel ? ` with ${m.thinkingLevel} thinking` : "";
    return [
      `Launched member "${m.role}"${thinking} in tmux pane ${m.paneId} (session: ${GANG_SESSION}).`,
      `Watch live: tmux attach -t ${GANG_SESSION}`,
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

  // Name the orchestrator so members' contact_supervisor target resolves.
  // Skip child sessions (they carry PI_SUBAGENT_RUN_ID and already have a --name role).
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const isChild = Boolean(process.env.PI_SUBAGENT_RUN_ID);
    const existingName = pi.getSessionName()?.trim();
    orchestratorName = existingName || defaultBossName(ctx.cwd ?? process.cwd());
    if (!isChild && !existingName) {
      pi.setSessionName(orchestratorName);
    }
  });

  pi.registerTool({
    name: "gang",
    label: "Gang",
    description: `Fire up and track visible subagent "members" as live tmux panes.

Usage:
  gang({ action: "spawn", task: "..." })                                       → launch a member (auto-named m1, m2, …)
  gang({ action: "spawn", task: "...", role: "reviewer", thinking: "high" })   → launch with an explicit name
  gang({ action: "list" })                                                     → show the members you've spawned
  gang({ action: "name", name: "boss of private evals" })                      → name this agent/session

Only "task" is required for spawn. spawn returns immediately. The member runs its own pi session in a tmux pane (watch: tmux attach -t ${GANG_SESSION}). When done it sends its result back to you ("boss") as an intercom message — it does NOT return here. Keep working; handle the result when it arrives.`,
    promptSnippet: `Spawn visible subagent members in tmux panes (gang spawn with a task; role/name is optional and auto-assigned), list them (gang list), or name the current agent/session (gang name). When you spin up a teammate or need a specific identity, name yourself first with gang({ action: "name", name: "<clear role/name>" }). Spawn results return asynchronously as intercom messages, not tool results.`,
    parameters: Type.Object({
      action: Type.String({ description: "'spawn', 'list', or 'name'" }),
      role: Type.Optional(Type.String({ description: "Optional name/role for the spawned member, e.g. 'reviewer'. Auto-assigned (m1, m2, …) if omitted; the member usually renames itself." })),
      task: Type.Optional(Type.String({ description: "What the member should do (required for spawn)" })),
      thinking: Type.Optional(Type.String({ description: "Optional Pi thinking level for spawn: off, minimal, low, medium, high, or xhigh" })),
      name: Type.Optional(Type.String({ description: "New name for this agent/session when action='name'" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action;
      if (action === "spawn") {
        if (typeof params.task !== "string" || !params.task) {
          return { content: [{ type: "text", text: "spawn requires 'task'." }], isError: true, details: { error: true } };
        }
        const name = typeof params.role === "string" && params.role.trim() ? params.role.trim() : undefined;
        const thinkingLevel = typeof params.thinking === "string" ? params.thinking : undefined;
        try {
          orchestratorName = pi.getSessionName()?.trim() || orchestratorName;
          const member = await spawnMember(params.task, ctx.cwd ?? process.cwd(), { name, thinkingLevel });
          return { content: [{ type: "text", text: spawnedMessage(member) }], isError: false, details: member };
        } catch (error) {
          return { content: [{ type: "text", text: `gang spawn failed: ${getErrorMessage(error)}` }], isError: true, details: { error: true } };
        }
      }
      if (action === "list") {
        return { content: [{ type: "text", text: formatRoster() }], isError: false };
      }
      if (action === "name") {
        const nextName = typeof params.name === "string" ? params.name.trim() : "";
        if (!nextName) {
          const currentName = pi.getSessionName()?.trim() || orchestratorName;
          return { content: [{ type: "text", text: `Agent name: ${currentName}` }], isError: false };
        }
        pi.setSessionName(nextName);
        orchestratorName = nextName;
        return { content: [{ type: "text", text: `Agent name set: ${nextName}` }], isError: false, details: { name: nextName } };
      }
      return { content: [{ type: "text", text: `Unknown action "${action}". Use 'spawn', 'list', or 'name'.` }], isError: true, details: { error: true } };
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
        say(formatRoster(), "info");
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
          say(`Launched "${member.role}"${thinking} in pane ${member.paneId}. Watch: tmux attach -t ${GANG_SESSION}`, "info");
        } catch (error) {
          say(`gang spawn failed: ${getErrorMessage(error)}`, "error");
        }
        return;
      }
      say(`Unknown gang command "${trimmed}". Use /gang, /gang list, /gang url, /gang name <name>, /gang watch, or /gang spawn [@name] [-t <level>] <task>.`, "warning");
    },
  });

  pi.registerShortcut("alt+g", {
    description: "Open gang mission control",
    handler: async (ctx) => openMissionControl(ctx),
  });
}
