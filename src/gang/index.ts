import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
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
import { MissionControlOverlay } from "./ui/mission-control.ts";

const execFileP = promisify(execFile);

const GANG_DIR = dirname(fileURLToPath(import.meta.url));
const GANG_INDEX = join(GANG_DIR, "index.ts");
const INTERCOM_INDEX = join(GANG_DIR, "..", "intercom", "index.ts");

const COMMAND_COMPLETIONS: AutocompleteItem[] = [
  { value: "watch", label: "watch", description: "Open mission control" },
  { value: "spawn ", label: "spawn", description: "Spawn a member: spawn <role> <task>" },
  { value: "list", label: "list", description: "Show spawned members" },
];

const ROLE_COMPLETIONS = ["worker", "reviewer", "researcher", "tester", "planner"];

export function getGangArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const trimmedStart = prefix.trimStart();
  if (!trimmedStart.includes(" ")) {
    const completions = COMMAND_COMPLETIONS.filter((item) => item.label.startsWith(trimmedStart));
    return completions.length > 0 ? completions : null;
  }

  const spawnMatch = trimmedStart.match(/^spawn\s+(\S*)$/);
  if (!spawnMatch) return null;

  const rolePrefix = spawnMatch[1] ?? "";
  const completions = ROLE_COMPLETIONS.filter((role) => role.startsWith(rolePrefix)).map((role) => ({
    value: `spawn ${role} `,
    label: role,
    description: `Spawn ${role} member`,
  }));
  return completions.length > 0 ? completions : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskFileContent(role: string, task: string): string {
  return [
    `Task: ${task}`,
    "",
    `You are "${role}", a member of a gang supervised by "${ORCHESTRATOR}". Work autonomously.`,
    "When you are finished, send your result to your supervisor with the intercom tool:",
    `  intercom({ action: "send", to: "${ORCHESTRATOR}", message: "<your result>" })`,
    "If you get blocked and need a decision, use the contact_supervisor tool instead.",
    "",
  ].join("\n");
}

export default function gangExtension(pi: ExtensionAPI) {
  const roster = new Roster();

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
    writeFileSync(file, taskFileContent(role, task));
    return file;
  }

  async function spawnMember(role: string, task: string, cwd: string): Promise<Member> {
    if (!isValidRole(role)) {
      throw new Error(`Invalid role "${role}". Use letters, digits, _ or - (start with a letter, max 32 chars).`);
    }
    const index = roster.nextIndex();
    const taskFile = writeTaskFile(role, task, index);
    // Forward PATH so the pane resolves `pi` even if the tmux server started with a minimal env.
    const env = { PATH: process.env.PATH ?? "", ...buildMemberEnv({ role, runId: roster.runId, index }) };
    const command = memberCommand({ role, taskFile, intercomIndex: INTERCOM_INDEX, gangIndex: GANG_INDEX });

    await ensureGangSession();
    const paneId = await runTmux(splitArgs({ session: GANG_SESSION, cwd, env, command }));
    // Best-effort polish; failures here must not lose the (already launched) member.
    await runTmux(remainOnExitArgs(paneId)).catch(() => {});
    await runTmux(tiledLayoutArgs()).catch(() => {});

    const member: Member = { role, task, index, paneId, runId: roster.runId, spawnedAt: Date.now() };
    roster.add(member);
    return member;
  }

  function formatRoster(): string {
    const members = roster.list();
    const watch = `Watch live: tmux attach -t ${GANG_SESSION}`;
    if (members.length === 0) {
      return `No gang members spawned yet (run ${roster.runId.slice(0, 8)}). Use \`gang spawn\` to launch one.`;
    }
    const rows = members.map((m) => {
      const preview = m.task.replace(/\s+/g, " ").slice(0, 60);
      return `• ${m.role} — pane ${m.paneId} — ${preview}`;
    });
    return `Gang members (run ${roster.runId.slice(0, 8)}). ${watch}\n${rows.join("\n")}`;
  }

  function spawnedMessage(m: Member): string {
    return [
      `Launched member "${m.role}" in tmux pane ${m.paneId} (session: ${GANG_SESSION}).`,
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
        new MissionControlOverlay(tui, theme, keybindings, feed, done));
    } finally {
      feed.stop();
    }
  }

  // The orchestrator names itself "boss" so members' contact_supervisor / "to: boss" resolves.
  // Skip child sessions (they carry PI_SUBAGENT_RUN_ID and already have a --name role).
  pi.on("session_start", () => {
    const isChild = Boolean(process.env.PI_SUBAGENT_RUN_ID);
    if (!isChild && !pi.getSessionName()) {
      pi.setSessionName(ORCHESTRATOR);
    }
  });

  pi.registerTool({
    name: "gang",
    label: "Gang",
    description: `Fire up and track visible subagent "members" as live tmux panes.

Usage:
  gang({ action: "spawn", role: "worker", task: "..." })  → launch a member in a tmux pane
  gang({ action: "list" })                                 → show the members you've spawned

spawn returns immediately. The member runs its own pi session in a tmux pane (watch: tmux attach -t ${GANG_SESSION}). When done it sends its result back to you ("boss") as an intercom message — it does NOT return here. Keep working; handle the result when it arrives.`,
    promptSnippet: `Spawn visible subagent members in tmux panes (gang spawn role/task) and list them (gang list). Results return asynchronously as intercom messages, not tool results.`,
    parameters: Type.Object({
      action: Type.String({ description: "'spawn' or 'list'" }),
      role: Type.Optional(Type.String({ description: "Member role/name for spawn, e.g. 'worker', 'reviewer'" })),
      task: Type.Optional(Type.String({ description: "What the member should do (for spawn)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action;
      if (action === "spawn") {
        if (typeof params.role !== "string" || typeof params.task !== "string" || !params.role || !params.task) {
          return { content: [{ type: "text", text: "spawn requires 'role' and 'task'." }], isError: true, details: { error: true } };
        }
        try {
          const member = await spawnMember(params.role, params.task, ctx.cwd ?? process.cwd());
          return { content: [{ type: "text", text: spawnedMessage(member) }], isError: false, details: member };
        } catch (error) {
          return { content: [{ type: "text", text: `gang spawn failed: ${getErrorMessage(error)}` }], isError: true, details: { error: true } };
        }
      }
      if (action === "list") {
        return { content: [{ type: "text", text: formatRoster() }], isError: false };
      }
      return { content: [{ type: "text", text: `Unknown action "${action}". Use 'spawn' or 'list'.` }], isError: true, details: { error: true } };
    },
  });

  pi.registerCommand("gang", {
    description: "Mission control (/gang watch), roster (/gang), or spawn (/gang spawn <role> <task>)",
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
      if (trimmed === "" || trimmed === "list") {
        say(formatRoster(), "info");
        return;
      }
      if (trimmed.startsWith("spawn")) {
        const rest = trimmed.slice("spawn".length).trim();
        const sep = rest.indexOf(" ");
        const role = sep === -1 ? rest : rest.slice(0, sep);
        const task = sep === -1 ? "" : rest.slice(sep + 1).trim();
        if (!role || !task) {
          say("Usage: /gang spawn <role> <task>", "warning");
          return;
        }
        try {
          const member = await spawnMember(role, task, ctx.cwd ?? process.cwd());
          say(`Launched "${member.role}" in pane ${member.paneId}. Watch: tmux attach -t ${GANG_SESSION}`, "info");
        } catch (error) {
          say(`gang spawn failed: ${getErrorMessage(error)}`, "error");
        }
        return;
      }
      say(`Unknown gang command "${trimmed}". Use /gang, /gang list, /gang watch, or /gang spawn <role> <task>.`, "warning");
    },
  });

  pi.registerShortcut("alt+g", {
    description: "Open gang mission control",
    handler: async (ctx) => openMissionControl(ctx),
  });
}
