# gang

A minimal, **observable** subagent primitive for [Pi](https://github.com/earendil-works). Fire up
subagents as **visible tmux panes** you watch live, let them talk over a **cross-agent message
bus**, and observe everything three ways: live panes, a durable log, and a mission-control view —
in your terminal (a Pi overlay) **and** in the browser.

Built on a vendored, fully-owned copy of [pi-intercom](https://github.com/nicobailon/pi-intercom)
(MIT). No external runtime dependency. Targets `@earendil-works` Pi **0.80.2**.

```
┌─ tmux panes ──────────────┐   raw per-agent view — watch each member's pi session
│  boss     │ worker        │
│           │ reviewer      │
└───────────┴───────────────┘
        │ intercom (unix socket: ~/.pi/agent/intercom/broker.sock)
        ▼
┌─ owned broker (vendored) ────────────────────┐
│  • routes messages                            │
│  • TAP  → ~/.pi/agent/intercom/intercom.jsonl │  durable, greppable, replayable
│  • HTTP + SSE :7717  ─────────────────────────┼─► mission control:  /gang watch  (in Pi)
└───────────────────────────────────────────────┘                     localhost:7717 (browser)
```

## Requirements

- **Pi** (`@earendil-works/pi-coding-agent`) ≥ 0.80.2 — `pi --version`
- **tmux** — members run as visible panes (`brew install tmux`)
- **Node** ≥ 22

## Install

### Option A — from GitHub (recommended)

Pi installs the package's runtime dependencies for you on a git install:

```sh
pi install ssh://git@github.com/Jeecabs/gang     # private repo → uses your SSH key
pi list                                           # verify: should list  gang  and  intercom
```

### Option B — local clone (to hack on it)

```sh
git clone git@github.com:Jeecabs/gang.git
cd gang
npm install                                       # REQUIRED — the broker + GUI run from node_modules
pi install .                                       # persistent: registers it in your Pi settings
# …or load it for a single session without touching settings:
pi -e ./src/intercom/index.ts -e ./src/gang/index.ts
```

> ⚠️ A **local** install (`pi install .`) references the folder **in place** and does **not** run
> `npm install` for you — so run it yourself, and don't move or delete the folder (the broker
> launches from its `node_modules`). A git/npm install handles deps automatically.

Unsure about Pi extensions in general? Pi documents itself — just ask it:
`pi -p "how do I write and install a Pi extension?"`

## Use

In any Pi session (it auto-names itself **`boss`** when gang loads), ask for a member — or call the
tool yourself:

```
gang spawn worker "list the repo's largest files"
gang spawn reviewer --thinking high "review the diff carefully"
```

`gang spawn` returns immediately and opens a tmux pane. The member does the task in its own Pi
session and sends the result **back to boss as an intercom message** (it does not return inline).
Keep working; handle the result when it arrives.

Watch the gang three ways:

```sh
# 1. in Pi — live mission-control overlay (members + status + feed)
/gang watch            # or press  alt+g

# 2. in the browser — the same feed, richer
/gang url              # prints computed localhost URL from GANG_GUI_PORT
open http://localhost:7717

# 3. durable, greppable log of every cross-agent message
tail -f ~/.pi/agent/intercom/intercom.jsonl
```

## Commands & tools

| Surface | What |
|---|---|
| `gang` tool | `{action:"spawn", role, task, thinking?}` · `{action:"list"}` — model-callable |
| `/gang` | show the roster |
| `/gang spawn [--thinking <level>] <role> <task>` | spawn a member by hand (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) |
| `/gang url` | show the browser mission-control URL (`http://localhost:<GANG_GUI_PORT>`) |
| `/gang boss [name]` | show or set this session's supervisor name for future members |
| `/gang watch` · `alt+g` | open mission control (in-Pi overlay) |
| `intercom` tool | message any session: `list` / `send` / `ask` / `reply` |

Env knobs: `GANG_GUI_PORT` (default `7717`), `GANG_TMUX_BIN` (default Homebrew tmux).

Boss naming: unnamed orchestrator sessions auto-name as `boss of <current-folder>` (e.g. `boss of private-evals`) instead of plain `boss`. Use `/gang boss <name>` before spawning to pick a custom target; spawned members get that exact supervisor name.

## How it's wired

`package.json` → `pi.extensions` points Pi at two TypeScript entry files it loads on startup:

- `src/intercom/` — vendored pi-intercom: the broker, client, and the `intercom` /
  `contact_supervisor` tools. **Owned** — imports retargeted to `@earendil-works/*`, plus a broker
  message **tap** (durable log) and an embedded **HTTP/SSE** mission-control server.
- `src/gang/` — the `gang` tool (spawn members in tmux, list the roster), the `/gang watch`
  overlay, and boss auto-naming.

`gang spawn <role> "<task>"` launches `pi --name <role> … @<taskfile>` in a tmux pane with five
`PI_SUBAGENT_*` env vars. Pass `--thinking <level>` to add Pi's `--thinking` flag for that member.
The vendored intercom extension reads the env vars at child startup to register
the member on the bus and unlock its `contact_supervisor` tool — that's the whole contract:

| Env var | Set to | Effect |
|---|---|---|
| `PI_SUBAGENT_INTERCOM_SESSION_NAME` | `<role>` | member's intercom identity |
| `PI_SUBAGENT_ORCHESTRATOR_TARGET` | `boss` | who it reports to |
| `PI_SUBAGENT_RUN_ID` / `_CHILD_AGENT` / `_CHILD_INDEX` | run metadata | unlocks `contact_supervisor` |

(The member's addressable **name** comes from Pi's `--name` flag; boss self-names via
`pi.setSessionName("boss")`.)

## Develop

```sh
npm test     # vendored intercom suite + gang/tmux/tap/GUI/overlay tests
```

## Credits

Vendors [pi-intercom](https://github.com/nicobailon/pi-intercom) by Nico Bailon (MIT). See `NOTICE`.
Built on Pi by the [earendil-works](https://github.com/earendil-works) team.
