# minion v2.2.0 — Phase 2: Agile Orchestration Engine (Thinking Doc)

> **Status:** Thinking / exploration — the **code-backed** alternative to
> [`./thought.md`](./thought.md) (the zero-code SDD design). Builds on v2.0
> (subagent delegation), v2.1 (primary agents), v2.2.0 Phase 1 (`/init`).
> **Goal:** design a real **agile project-management engine** inside minion: a
> **PRD → Epic → User Story → Task** hierarchy on a **kanban board**, an
> orchestrator that runs agents **independently or chained**, **human-in-the-loop**
> decision gates, and **resume** after interruption or an agent stall.
> **This is the *what/why* + concrete drafts.** A later `specs.md` turns it into
> TDD build steps.

> **Two options, one choice.** `thought.md` keeps everything prompt-only (tracking =
> markdown the LLM writes). This doc is the opposite bet: **code owns the process,
> agents own the thinking.** It deliberately reintroduces machinery v2 removed
> (a task board, a project workspace, session resume) — see the honest accounting in
> [§12](#12-consistency--what-were-not-building).

---

## 1. Motivation

An agile team runs on structure: a backlog decomposed from product intent, work
items that move across board columns, a definition of done, and a standup where a
human unblocks what's stuck. Today minion can *delegate* (v2's `subagent` tool) but
it can't *manage*: it has no memory of what work exists, no ordering, no board, and
no way to resume a half-finished plan after the session ends.

The user wants exactly that management layer, shaped as agile:

| Requested | Delivered by |
|-----------|--------------|
| Agents work independently or chained | Orchestration engine over `modes.ts` ([§6](#6-the-orchestration-engine)) |
| Kanban board to track a project | `WorkItem` board, TUI + markdown ([§10](#10-board-rendering-both-views)) |
| PRD → Epic → User Story → Task | Typed hierarchy ([§3](#3-the-hierarchy-model)) |
| Defined subagent roles | Agile role agents ([§9](#9-subagent-roles)) |
| Human-in-the-loop decisions | Four code gates ([§7](#7-human-in-the-loop-gates)) |
| Resume on interruption / stall | Durable board + run-state + stall timeout ([§8](#8-resume--stall-recovery)) |

### Why code now, when v2 removed exactly this?

v1 *had* a kanban `task` tool, a `~/.pi/projects/<id>/` workspace, and session-start
resume — and v2 deleted all of it ([v2.0/design.md §3](../../v2.0/design.md)) because
it was entangled and heavy. Reintroducing it is a real reversal, and worth doing
**only** because this option's whole premise is that a *complex, organized, multi-day*
project is precisely the case a prompt-only board can't hold. The mitigations that
make it safe this time:

- We **reuse v1's proven data model and persistence** rather than reinventing it
  (the v1 `Task` card + project layout are directly portable — [§3](#3-the-hierarchy-model), [§4](#4-persistence--layout)).
- We **build on v2's clean module boundaries** (`runner`/`modes`/`render` stay as-is;
  the engine is injected the runner exactly like `modes.ts` is — [§11](#11-module-layout--wiring)).
- We keep it **fail-non-fatal** and **opt-in** (no PM machinery runs unless the user
  starts a project), so the lean delegation core is untouched for users who don't
  want a board.

---

## 2. The core principle — division of labor

**The single most important design decision:** draw a hard line between what
*deterministic code* owns and what the *LLM* owns. This is the real answer to "what
can the LLM understand, handle, and manage" for something this complex — **you don't
make the LLM manage it; you make code manage it and let the LLM do the parts LLMs are
good at.**

| Concern | Owner | Why |
|---------|-------|-----|
| Work-item state & transitions | **Code** | LLMs forget/contradict state across turns; a state machine never does |
| Dependency ordering (what's ready) | **Code** | DAG readiness is a computation, not a judgment |
| Concurrency / parallel vs chain | **Code** | Reuse `modes.ts` limits; deterministic |
| Persistence & resume | **Code** | Files + session entries survive; context windows don't |
| Stall / abort / retry accounting | **Code** | Timeouts and attempt counts are bookkeeping |
| Human gates | **Code** | A gate must *block*; a prompt "please ask the user" can be skipped |
| Decomposition (PRD→Epic→Story→Task) | **LLM** | Judgement: what work exists, how to split it |
| Writing instructions & acceptance | **LLM** | Language + domain reasoning |
| Executing a task | **LLM** (subagent) | The actual coding work |
| Reviewing against acceptance | **LLM** (subagent) | Judgement against criteria |

> **Why this is the whole game.** The failure mode of "LLM, manage my project" is
> that the model holds the plan in its context, loses it on compaction, mis-tracks
> which task is done, and silently drops the golden thread. By moving *state,
> ordering, gating, and resume* into code, the LLM is only ever asked to make **one
> local decision at a time** against an explicit, tool-provided view of the board.
> That is a task LLMs handle reliably. The board is the shared memory; the engine is
> the scheduler; the agents are the workers.

Everything below is an application of this split.

---

## 3. The hierarchy model

PRD → Epic → User Story → Task is a four-level tree. The **PRD** already exists as
`PRD.md` (from `/init`), with `OBJ-n` business objectives. Epics, Stories, and Tasks
are **work-item cards**. Rather than three near-identical types, use **one
`WorkItem`** discriminated by `kind` with a `parent` link — a lean generalization of
v1's `Task`.

```typescript
// pm/schema.ts
export type ItemKind = "epic" | "story" | "task";
export type ItemStatus =
  | "backlog" | "todo" | "in_progress" | "blocked" | "review" | "done" | "cancelled";
export const STATUS_ORDER: ItemStatus[] = [
  "backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled",
];
/** Surfaced at session start for resume. */
export const RESUMABLE = new Set<ItemStatus>(["todo", "in_progress", "blocked"]);

export interface WorkItem {
  id: string;               // kind-prefixed: e-a3f2, s-b1c9, t-7d4e
  kind: ItemKind;
  parent: string | null;    // epic→OBJ-n (PRD) | story→epic id | task→story id
  title: string;
  status: ItemStatus;
  role: string;             // agile role that owns this item (see §9)
  agent: string;            // resolved subagent (assignee); role→agent via config
  priority: "low" | "normal" | "high";
  labels: string[];
  dependsOn: string[];      // sibling item ids (ordering within a story/epic)
  created: string; updated: string;
  attempts: number;         // delegation attempts (retry/stall accounting)
  session: string;          // session id of last delegation
  instruction: string;      // self-contained brief the subagent executes
  acceptance: string[];     // acceptance criteria (checked at review gate)
  notes: string;
  activity: string[];       // append-only timestamped log
}
export const genId = (kind: ItemKind): string =>
  `${kind[0]}-${Math.random().toString(36).slice(2, 6)}`;
```

**User Story convention:** a `story` card's `title`/`instruction` follows the agile
form — *"As a `<user>`, I want `<goal>`, so that `<benefit>`"* — and its `acceptance`
array holds the story's acceptance criteria. Tasks under it are the technical
breakdown.

**Level semantics:**

| Kind | Parent | Produced by (role) | `instruction` is… | `acceptance` is… |
|------|--------|--------------------|-------------------|------------------|
| `epic` | PRD `OBJ-n` | `product-owner` | epic goal + success measure | epic-level outcomes |
| `story` | epic | `analyst` | "As a … I want … so that …" | story acceptance criteria |
| `task` | story | `tech-lead` | concrete engineering step | task done-conditions |

> **Why one type, not three:** the board, the store, the DAG, and the renderer all
> operate uniformly over `WorkItem`; `kind` only changes *which role decomposes it*
> and *how it renders*. This is the v1 `Task` interface plus `kind` + `parent` — a
> minimal delta over code we know worked.

---

## 4. Persistence & layout

**Recommendation: in-repo, git-tracked** under `.pi/pm/`. The board is a *team
artifact* — it should travel with the branch, show up in PRs, and be the same for
everyone who clones. Cards are markdown+frontmatter (v1's exact serialization), so
they're human-readable and diffable.

```
<repo>/
├── PRD.md                          # OBJ-n objectives (from /init)
└── .pi/pm/
    ├── BOARD.md                    # generated overview (regenerated on change)
    ├── epics/     e-a3f2.md        # WorkItem cards (frontmatter + sections)
    ├── stories/   s-b1c9.md
    ├── tasks/     t-7d4e.md
    └── .runs/                      # delegation transcripts (gitignored — noisy)
```

Card format is v1's (frontmatter for scalar fields + `## Instruction / ## Acceptance
criteria / ## Notes / ## Activity` sections). Writes go through
`withFileMutationQueue` (write `.tmp` → `rename`), fail-soft on error.

**Alternative (v1 model): global workspace.** Store everything under
`~/.pi/projects/<id>/` with a `.pi/<id>.md` marker in the tree, deterministic id
`slug-sha1(root)[:8]`, reusing v1's `project.ts` almost verbatim. Keeps the working
tree clean and is compatible with `@aprimediet/memory`.

| Aspect | In-repo `.pi/pm/` (recommended) | Global `~/.pi/projects/<id>/` (v1) |
|--------|-------------------------------|-----------------------------------|
| Shared across team | ✅ via git | ❌ local only |
| PR-reviewable board | ✅ | ❌ |
| Working tree cleanliness | writes a tracked `.pi/pm/` dir | ✅ only a marker file |
| Resume in a fresh clone | ✅ board is present | ❌ needs the global dir |
| memory-extension compat | n/a | ✅ shared id/marker |

**Hybrid (what I'd actually ship):** durable cards **in-repo** (`.pi/pm/`, shared);
verbose per-delegation transcripts in `.pi/pm/.runs/` **gitignored** (or under the
global workspace) so git stays signal-rich. This is the default the doc recommends.

---

## 5. The `pm` tool (LLM's write API to the board)

The LLM never edits card files directly — it calls one structured tool, so the API
is narrow, well-described, and validated (typebox). Ported and extended from v1's
`task` tool.

```typescript
// pm/tool.ts
const PmParams = Type.Object({
  action: StringEnum(
    ["create", "update", "list", "get", "breakdown"] as const,
    { description: "create an item; update fields/status; list the board; get one item; breakdown proposes children for a parent" },
  ),
  kind: Type.Optional(StringEnum(["epic", "story", "task"] as const)),
  id: Type.Optional(Type.String({ description: "item id (update/get)" })),
  parent: Type.Optional(Type.String({ description: "parent id (OBJ-n / epic / story)" })),
  title: Type.Optional(Type.String()),
  instruction: Type.Optional(Type.String({ description: "self-contained brief for the executor" })),
  role: Type.Optional(StringEnum(
    ["product-owner", "analyst", "tech-lead", "worker", "reviewer", "qa"] as const)),
  status: Type.Optional(StringEnum(
    ["backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled"] as const)),
  priority: Type.Optional(StringEnum(["low", "normal", "high"] as const)),
  acceptance: Type.Optional(Type.Array(Type.String())),
  labels: Type.Optional(Type.Array(Type.String())),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  note: Type.Optional(Type.String({ description: "append to activity/notes" })),
  filter: Type.Optional(StringEnum(["open", "all", "ready"] as const)),
});
```

Registered with `promptGuidelines` so every session's system prompt teaches the
model the workflow (v1 pattern):

```
- Decompose product intent top-down: create epics under PRD objectives, stories
  under epics, tasks under stories. Give each a clear instruction + acceptance.
- Do NOT execute tasks yourself — the engine delegates them to their role's
  subagent. Use `pm` to shape the board; use `/sprint` to run a ready wave.
- Set dependsOn to order sibling work; independent siblings run in parallel.
```

> **Why a tool, not free-form file writes:** the enum-constrained schema is the
> contract that keeps the LLM inside the rails. v1 proved this — a 4-action `task`
> tool was enough to drive a whole board. `breakdown` is the one addition: it returns
> a *proposed* set of children for a parent (feeding gate 1) without committing them.

---

## 6. The orchestration engine

`pm/engine.ts` is the scheduler. It is to work-items what `modes.ts` is to raw
tasks — and it **reuses** `modes.ts`/`runner.ts` rather than re-implementing
subprocess handling. The runner is **injected** (same pattern as `modes.ts` today),
so the engine has no subprocess or TUI imports.

**One "wave" of semi-auto execution:**

```
runWave(board, ctx):
  ready = board.items(kind="task", status="todo")
            .filter(t => t.dependsOn.every(d => board.get(d)?.status === "done"))
  if ready.isEmpty(): return { idle: true }

  ── GATE 2 (before execution): ctx.ui.confirm the wave (assignees + instructions)
  if !approved: return { paused: true }

  # split ready set by dependency shape
  independent = ready.filter(t => t.dependsOn.length === 0 || allExternalDepsDone)
  chains      = groupByDependencyChain(ready)   # linear depend<-chains

  for t in independent:  board.set(t, "in_progress", attempt++)
  results = await Promise.all([
     runParallel(independent, { concurrency: MAX_CONCURRENCY }),   # modes.ts
     ...chains.map(c => runChain(c)),                               # modes.ts, {previous}
  ])

  for (t, r) of results:
     if r.ok:      board.set(t, "review")     # → GATE 3
     else if r.stalled or r.failed: board.set(t, "blocked")  # → GATE 4
     board.appendActivity(t, r.summary)
  regenerateBoardMd(board)
```

- **Independent → parallel** (`runParallel`, capped at `MAX_CONCURRENCY=4`).
- **Dependent → chain** (`runChain`, threading `{previous}` — the existing chain
  mode literally does this).
- Each task delegates to `agent = roleToAgent(t.role)` ([§9](#9-subagent-roles)),
  loading `t.instruction` + `t.acceptance` as the subagent brief (v1's `taskId` load).
- Auto-transitions: success → `review` (gate 3), failure/stall → `blocked` (gate 4).

**Commands:**

| Command | Does |
|---------|------|
| `/sprint` | run one ready wave (semi-auto: stops at gates) |
| `/board` | open/refresh the TUI kanban ([§10](#10-board-rendering-both-views)) |
| `/pm` | utilities: `breakdown <parent>`, `status`, `resume`, `roles` |

> **Why waves, not autopilot:** "semi-auto with gates" (your choice) means the engine
> advances the board one *ready wave* at a time and always returns control at a gate.
> The user can `/sprint` repeatedly to drive the project, but never loses the wheel.
> Autopilot (loop `runWave` until idle-or-gate) is a trivial superset, left as an
> opt-in flag ([O3](#13-open-questions)).

---

## 7. Human-in-the-loop gates

All four requested gates, implemented as **blocking `ctx.ui` calls in code** — not
as instructions the LLM might skip. A gate that doesn't block isn't a gate.

| # | Gate | Trigger | UI call | Outcomes |
|---|------|---------|---------|----------|
| 1 | **Breakdown** | `pm breakdown` proposes epics/stories/tasks | `ctx.ui.confirm` (or `select` per item) | approve → cards created · edit · reject |
| 2 | **Before execution** | `runWave` computed a ready set | `ctx.ui.confirm` showing assignees + instructions | run wave · skip · abort |
| 3 | **Review → Done** | a task auto-moved to `review` | `ctx.ui.confirm` "acceptance met?" (optionally after a `reviewer` subagent verdict) | done · back to `todo` (rework) |
| 4 | **Blocked resolution** | task `blocked` (failure or stall) | `ctx.ui.select` retry / reassign / re-scope / cancel | re-queue with chosen action |

Gate 3 pairs nicely with a `reviewer` subagent: the engine runs the review agent
against `acceptance`, shows its verdict, and the human confirms — judgment proposed by
the LLM, decision made by the human.

> **Why gates are code, not prompt:** `ctx.ui.confirm(...)` returns a `boolean` the
> engine branches on. There is no path where work proceeds without the human's
> answer. Contrast the prompt-only option, where "ask the user first" is a *request*
> the model can rationalize past ([§2](#2-the-core-principle--division-of-labor), P-gate).

---

## 8. Resume & stall recovery

Two independent durability mechanisms, both grounded in real SDK APIs.

### 8.1 Durable board + run-state (resume after interruption)

- **The board is on disk** ([§4](#4-persistence--layout)) — so a new session simply
  *reads* it. No task is lost to a closed terminal.
- **Engine run-state** (which wave is in flight, which task ids were delegated this
  run) is written with `pi.appendEntry("minion-pm-run", {...})` — a custom session
  entry that survives reload and is *not* in the LLM context.
- On `session_start` (the SDK gives `reason: "resume"`), the engine reloads the board
  and the last `minion-pm-run` entry. Any task left `in_progress` with no recorded
  completion is an **interrupted** task → move to `blocked` with activity
  `"interrupted (session ended mid-run)"` → surfaces at gate 4.
- **`before_agent_start` resume prompt** (v1's `buildResumePrompt`): inject a system-
  prompt block listing `RESUMABLE` items so the main agent knows, every turn, what's
  open and that `/sprint` will continue it:

  ```
  # Open work — resume
  This project has unfinished board items from earlier sessions. Run `/sprint`
  to continue, or `/board` to inspect. Blocked items need a decision (gate 4).
  - t-7d4e [in_progress→interrupted] → worker: wire /reorder endpoint
  - s-b1c9 [blocked] → analyst: guest-checkout story (attempt 2)
  ```

### 8.2 Stall detection (agent stops making progress)

`runner.ts` today has SIGTERM→SIGKILL **abort** but **no idle timeout** — a subagent
that hangs would block a wave forever. Add a heartbeat:

```typescript
// runner.ts — additions
const STALL_IDLE_MS = 120_000;   // no NDJSON output for 2 min ⇒ stalled
const MAX_TASK_MS   = 900_000;   // hard ceiling per task ⇒ 15 min

let lastActivity = Date.now();               // bump on every stdout chunk / event
const idle = setInterval(() => {
  if (Date.now() - lastActivity > STALL_IDLE_MS) { stalled = true; killProc(); }
}, 15_000);
const hard = setTimeout(() => { stalled = true; killProc(); }, MAX_TASK_MS);
// clear both in the close/finally path; surface `stalled` on the SingleResult
```

`Date.now()` is fine in the *runner* (it runs live; only workflow scripts forbid it).
The engine reads `result.stalled`, moves the task to `blocked` with activity
`"stalled: no output for 120s (attempt N)"`, increments `attempts`, and routes to
gate 4. A retry re-delegates with the accumulated `notes` so the next attempt has
context on why the last one hung.

> **Why two thresholds:** idle-timeout catches the common hang (agent waiting on
> nothing, infinite tool loop with no output); the hard ceiling catches the
> pathological "producing output forever" case. Both are code bookkeeping the LLM
> should never have to reason about.

---

## 9. Subagent roles

Agile roles map to the decomposition levels. Each is a bundled agent `.md`
(frontmatter + system prompt), same style as `agents/reviewer.md`. The engine maps
`WorkItem.role → agent` (overridable via `config.ts` `settings.json#agents`, so a
user can point `tech-lead` at a bigger model).

| Role | Level it owns | Reuse / new | Model |
|------|---------------|-------------|-------|
| `product-owner` | PRD → Epics | **new** | sonnet |
| `analyst` | Epic → User Stories | **new** | sonnet |
| `tech-lead` | Story → Tasks | reuse **`planner`** | sonnet |
| `worker` | execute a Task | reuse **`worker`** | sonnet |
| `reviewer` | review gate (vs acceptance) | reuse **`reviewer`** | sonnet |
| `qa` / `security-reviewer` | optional review lenses | optional new | sonnet |

New role sketches:

```markdown
---
name: product-owner
type: subagent
description: Decomposes PRD business objectives into epics with success measures
tools: read, grep, find, ls
model: claude-sonnet-4-5
---
You are a product owner. Given PRD.md objectives (OBJ-n) and a target objective,
propose 2–5 epics that deliver it. Each epic: a goal, a success measure, and which
OBJ-n it serves. You do NOT write code or stories — you produce the epic breakdown
for the human's approval (gate 1). Output one block per epic: title, parent OBJ-n,
goal, success measure.
```

```markdown
---
name: analyst
type: subagent
description: Turns an epic into user stories (As a… I want… so that…) with acceptance criteria
tools: read, grep, find, ls
model: claude-sonnet-4-5
---
You are a business analyst. Given an epic, produce user stories in the form
"As a <user>, I want <goal>, so that <benefit>", each with 2–4 testable acceptance
criteria. Keep stories small (one deployable increment). You do NOT design tasks —
the tech-lead does. Output one block per story: title (the As-a sentence), parent
epic id, acceptance criteria list.
```

`tech-lead` = the existing `planner` (Story → ordered Tasks with `dependsOn`),
prompted with the story + acceptance to emit tasks. Reusing it keeps the roster lean.

---

## 10. Board rendering (both views)

Per your choice, **both** a live TUI kanban and human-readable markdown.

**Markdown** (always current, greppable, git-diffable): each card is a file; a
generated `.pi/pm/BOARD.md` gives the overview via a v1-style `renderBoard()`:

```
## Epic e-a3f2 — Checkout conversion  (OBJ-2)
  story s-b1c9 — As a returning user I want one-tap re-order …
    todo (1):        t-7d4e @worker  wire /reorder endpoint
    in_progress (1): t-9f21 @worker  add re-order button
    review (1):      t-2c88 @reviewer tests for re-order
  story s-c4d0 — As a guest I want to check out …  [blocked]
```

**TUI** via `ctx.ui.setWidget("minion-board", factory, { placement: "belowEditor" })`
using pi-tui `Container`/`Box`/`Text` (all already used in `render.ts`). Columns are
the `STATUS_ORDER`; a `/board` command opens it and a `pi.registerShortcut` toggles
it. Optional **epic/story swimlanes** group columns under their parent — richer, but
costs more render code, so it's an opt-in view ([O2](#13-open-questions)).

```typescript
// pm/render.ts (sketch)
function renderKanban(board, theme): Component {
  const root = new Container();
  for (const status of STATUS_ORDER) {
    const col = board.byStatus(status);
    if (!col.length) continue;
    const box = new Box(); // header + cards
    box.addChild(new Text(theme.bold(`${status} (${col.length})`), 0, 0));
    for (const it of col)
      box.addChild(new Text(theme.fg("muted", `${it.id} @${it.agent} ${it.title}`), 0, 0));
    root.addChild(box);
  }
  return root;
}
```

---

## 11. Module layout & wiring

New `pm/` package; existing v2 modules untouched and reused. Dependency graph stays
acyclic (the engine is injected the runner, mirroring `modes.ts`).

```
pm/
├── schema.ts   # WorkItem, ItemKind/Status, STATUS_ORDER, RESUMABLE, genId
├── store.ts    # read/write cards (frontmatter+sections), BOARD.md, atomic writes
├── board.ts    # queries: byStatus/byParent/ready(); dependency DAG
├── engine.ts   # runWave: DAG → parallel/chain via modes.ts (runner injected)
├── gates.ts    # the 4 ctx.ui gates
├── resume.ts   # session_start reload + before_agent_start prompt + appendEntry
├── render.ts   # TUI kanban + markdown renderBoard
└── tool.ts     # `pm` tool registration
```

```
index.ts wiring
├── pi.registerTool(pmTool)                         # the pm board tool
├── pi.registerCommand("sprint" | "board" | "pm")   # engine + views
├── pi.registerShortcut(Key…)                       # toggle board widget
├── pi.on("session_start", reloadBoardAndRunState)  # resume
├── pi.on("before_agent_start", injectResumePrompt) # v1 pattern
└── pi.on("turn_start", () => appendEntry("minion-pm-run", snapshot))
```

Dependency direction: `index → { tool, engine, resume, render, board, store, schema }`;
`engine → { board, store, schema, gates }` + injected `RunAgentFn` from `modes/runner`;
`store/board/render → schema`. No cycles; `schema` depends on nothing internal — same
discipline as [v2.0/design.md §4](../../v2.0/design.md).

---

## 12. Consistency / what we're NOT building

Honest accounting — this option *does* reintroduce removed subsystems; here's the
line held:

- **Reintroduced (on purpose):** a persistent board (now `WorkItem`, in-repo), a
  project notion, session resume. Justified by [§1](#1-motivation) — this is the
  complex-project option.
- **NOT bringing back:** v1's `todo_write` (lives in `@aprimediet/todo`), v1's
  six-level model-resolution chain (use v2's single `settings.json#agents` override),
  the deterministic-id *global* workspace as the default (it's the *alternative* now,
  not the primary — [§4](#4-persistence--layout)).
- **Untouched:** the v2 delegation core (`runner`/`modes`/`render`/`agents`/`config`)
  — the engine *reuses* it, adding only a stall-timeout to `runner`.
- **Opt-in & fail-non-fatal:** no PM code path runs until the user starts a project;
  every file op is `try/catch` degrade, never crashing the host session.

---

## 13. Open questions

- **O1 — Persistence default.** Recommend in-repo `.pi/pm/`; confirm vs the global
  workspace (or the hybrid). Team-shared board argues in-repo; clean-tree purists
  argue global.
- **O2 — Swimlane rendering.** Flat columns (simple) vs epic/story swimlanes (richer,
  more code). Ship flat first?
- **O3 — Autopilot.** `/sprint` runs one wave. Offer a `--auto` that loops until
  idle-or-gate? (Superset of semi-auto; gated the same way.)
- **O4 — Tree strictness.** Must every task have a story and every story an epic, or
  allow ad-hoc top-level tasks (fast path for small work)? Suggest: allow, but warn.
- **O5 — Stall thresholds.** `STALL_IDLE_MS=120s` / `MAX_TASK_MS=15m` are guesses;
  make them `pi.registerFlag`-configurable.
- **O6 — Relationship to Option 1.** Could the two coexist (agile engine emits the
  same `plan.md`/`spec.md` artifacts from `thought.md`)? Or is this a hard either/or?

---

## 14. Definition of Done & work packages

**DoD for this doc (✅):** every requested capability has a concrete, buildable
design. To turn it into shipped code:

- **WP0 — Decide** O1–O6 (esp. persistence default, tree strictness).
- **WP1 — `pm/schema.ts` + `pm/store.ts`** — `WorkItem`, card (de)serialize (port v1
  `tasks.ts` serialize), atomic writes, `BOARD.md` generation. TDD.
- **WP2 — `pm/board.ts`** — queries + dependency DAG + `ready()`. Pure, unit-tested.
- **WP3 — `pm/tool.ts`** — the `pm` tool (create/update/list/get/breakdown) + guidelines.
- **WP4 — `pm/engine.ts`** — `runWave` over `modes.ts` (parallel/chain), auto
  transitions, injected runner. Tests with a fake runner.
- **WP5 — `pm/gates.ts`** — the four `ctx.ui` gates.
- **WP6 — `pm/resume.ts` + runner stall-timeout** — `session_start` reload,
  `before_agent_start` prompt, `appendEntry` run-state; `STALL_IDLE_MS`/`MAX_TASK_MS`.
- **WP7 — `pm/render.ts` + `/board` + `/sprint` + `/pm`** — TUI kanban + markdown.
- **WP8 — role agents** — `product-owner`, `analyst` (+ reuse `planner`/`worker`/
  `reviewer`); `bundled.test.ts` coverage.
- **WP9 — docs/README** — agile walkthrough.

**Coverage vs the request:**

| Requested capability | Section |
|----------------------|---------|
| Agents independent or chained | §6 (runParallel / runChain) |
| Kanban board to track project | §10 (TUI + markdown) |
| PRD → Epic → User Story → Task | §3 (WorkItem tree) |
| Defined subagent roles | §9 |
| Human-in-the-loop decisions | §7 (four gates) |
| Resumable on interrupt / stall | §8 (durable board + run-state + stall timeout) |
| "Best decision the LLM can manage" | §2 (division of labor: code owns state, LLM owns judgment) |
```
