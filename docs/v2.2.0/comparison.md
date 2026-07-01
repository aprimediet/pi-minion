# minion v2.2.0 — Two Roads for Project Management (Comparison)

> **Status:** Decision aid. Compares the two exploration docs for v2.2.0 Phase 2:
> - [`thought.md`](./thought.md) — **Spec-Driven Development (SDD)**, the *zero-code* bet.
> - [`agile-thought.md`](./agile-thought.md) — **Agile Orchestration Engine**, the *code-backed* bet.
> **Goal:** give a comprehensive, scenario-grounded overview so WP0 (decide the
> approach) can be made with eyes open. This doc does **not** re-argue either
> design — it puts them side by side and shows how each behaves under real use.

---

## 1. The one-sentence difference

Both docs answer the same request — *"help a minion user manage a project from
intent to release"* — but make **opposite bets about who does the managing**:

| | `thought.md` (SDD) | `agile-thought.md` (Agile Engine) |
|---|---|---|
| **The bet** | **The LLM manages**, guided by disciplined prompts; artifacts are the state. | **Code manages**, the LLM only decides one local thing at a time. |
| **Slogan** | "Files are the board, prompts are the discipline." | "Code owns the process, agents own the thinking." |
| **New code** | **Zero** (optionally a read-only lens later). | **A whole `pm/` package** (8 modules) + a `pm` tool + engine. |
| **The model** | A *pipeline* of six workflow prompts. | A *state machine* + scheduler over a typed work-item tree. |

> Everything else in this document is an elaboration of that single split. If you
> internalize one table, make it this one.

---

## 2. Core philosophy, side by side

### `thought.md` — discipline via prompt design

Its nine principles (P1–P9) are all about **how to instruct an LLM** so it manages a
project *reliably without code*: artifacts are the state (P1), one phase = one prompt
delegating to subagents (P2), hard approval gates (P3), traceability IDs threaded
across artifacts (P4), idempotency (P5), lean templated outputs (P6), delegate heavy
work (P7), anti-patterns at the top of every prompt (P8), definition-of-done per
phase (P9). The discipline lives in the *prose of the prompts*.

### `agile-thought.md` — discipline via division of labor

Its single organizing principle (§2) is a **hard line between code and LLM**: code
owns work-item state, dependency ordering, concurrency, persistence, resume, stall
accounting, and the human gates; the LLM owns decomposition, instruction-writing,
execution, and review judgment. The discipline lives in *deterministic code that the
LLM cannot skip*.

> **The philosophical crux:** `thought.md` trusts a well-written prompt to keep the
> LLM on rails. `agile-thought.md` distrusts exactly that — "a gate that doesn't
> block isn't a gate" — and puts the rails in code. Each doc explicitly names the
> other's weak spot: `thought.md` admits `STATUS.md` can drift because "the LLM is
> the only thing enforcing" consistency (§6); `agile-thought.md` admits it is
> "reintroducing machinery v2 removed" and must justify the reversal (§1, §12).

---

## 3. Dimension-by-dimension comparison

| Dimension | `thought.md` (SDD) | `agile-thought.md` (Agile Engine) |
|-----------|--------------------|-----------------------------------|
| **Hierarchy** | PRD `OBJ-` → Plan `G-` → Spec `T-`/`TEST-` → Review `CHK-` → Release `REL-` (an **ID chain across documents**) | PRD `OBJ-` → Epic → Story → Task (a **typed `WorkItem` tree** with `parent`/`dependsOn`) |
| **State lives in** | Markdown artifacts + a `STATUS.md` table the LLM edits | On-disk `WorkItem` cards + a code state machine (`ItemStatus`) |
| **"The board"** | `docs/STATUS.md` — a hand-maintained markdown table | `.pi/pm/` cards → generated `BOARD.md` **and** a live TUI kanban |
| **Unit of work** | A *phase* (`/plan-feature`, `/spec`, …) run by the user | A *wave* of ready tasks scheduled by `runWave` |
| **Who orders work** | The user, by choosing which phase to run next | Code, via DAG readiness (`dependsOn.every(done)`) |
| **Parallel / chain** | Only inside `/review` (3 lenses fan out) | First-class: independent→`runParallel`, dependent→`runChain` (reuses `modes.ts`) |
| **Human gates** | Prompt instructions ("STOP, await approval") — *soft* | `ctx.ui.confirm/select` returning a boolean — *hard, blocking* |
| **Resume** | "Just re-run the phase; it reads artifacts from disk" | Durable board + `appendEntry` run-state + `before_agent_start` resume prompt + interrupted-task detection |
| **Stall recovery** | None (not a concern — no long-running engine) | `STALL_IDLE_MS`/`MAX_TASK_MS` heartbeat in `runner.ts` → task→`blocked`→gate 4 |
| **New subagents** | `security-reviewer`, `business-reviewer`, `release-notes-writer` | `product-owner`, `analyst` (+ reuse `planner`/`worker`/`reviewer`) |
| **New tools** | **None** | `pm` tool (create/update/list/get/breakdown) |
| **New commands** | `/plan-feature`, `/spec`, `/review`, `/nightly`, `/stable` | `/sprint`, `/board`, `/pm` |
| **Persistence location** | `docs/features/<slug>/…` + `docs/releases/…` (visible, human design-doc tree) | `.pi/pm/…` (agent-managed tree, `.runs/` gitignored) |
| **Release story** | First-class: `/nightly` + `/stable` produce `REL-` reports from git + reviews | Not a focus (release = whatever the board shows shipped) |
| **v2 philosophy fit** | **Preserves it** — extends the `/init` zero-code bet | **Reverses it** — knowingly re-adds board/workspace/resume |
| **Build effort** | Low: prompts + templates + 3 agent `.md` files | High: 9 work packages, TDD, a scheduler, gates, resume, TUI |
| **Failure mode** | Drift (LLM forgets to update `STATUS.md`, mis-transitions state) | Complexity (a stateful engine coupled to the host session) |

---

## 4. Scenarios — how each behaves in practice

The requested "comprehensive scenario" section. Each scenario runs the *same*
situation through *both* designs so the trade-off is concrete, not abstract.

### Scenario A — Solo dev, one small feature ("add a dark-mode toggle")

**SDD:** User runs `/plan-feature` → answers a couple questions → approves a ~40-line
`plan.md` (one goal `G-1`). Runs `/spec` → approves a `spec.md` (two tasks, one
test). Runs `/implement` (existing chain) against the spec. Runs `/review` →
three lenses fan out → verdict `pass`. Five prompt invocations, five markdown files,
no new machinery. **Feels like:** a guided checklist.

**Agile Engine:** User must stand up a board: `pm breakdown` on an objective → gate 1
approves an epic → a story → tasks → `/sprint` runs a wave → gate 2 → gate 3
(review) → done. For a one-goal feature this is **heavier than the work itself** —
the doc's own O4 flags this ("allow ad-hoc top-level tasks… fast path for small
work"). **Feels like:** filing Jira tickets to change a CSS variable.

> **Winner: SDD**, clearly. Small work is where zero-code shines and the engine's
> ceremony hurts.

### Scenario B — Complex, multi-day project, 5 features, many parallel tasks

**SDD:** Each feature gets its own `docs/features/<slug>/` trio. Cross-feature
ordering and "what's ready to work on now" live only in the user's head + a
hand-maintained `STATUS.md`. Nothing *runs* work — the user drives each `/implement`
manually. With 5 features × several tasks, `STATUS.md` drift becomes real (§6's
admitted weakness). **Feels like:** a well-organized binder that someone still has to
carry.

**Agile Engine:** This is the case it was *built for* (§1: "a complex, organized,
multi-day project is precisely the case a prompt-only board can't hold"). The DAG
computes readiness; `runWave` executes independent tasks in parallel (cap 4) and
dependent ones as chains; the board is always authoritative; gates keep the human in
control. **Feels like:** a project actually being managed.

> **Winner: Agile Engine**, decisively. Scale and parallelism are its reason to
> exist.

### Scenario C — Interruption (terminal closed mid-work), resume next day

**SDD:** "Resume = the next session runs `/spec` (etc.) and reads artifacts from
disk" (§9). There's nothing *in flight* to lose because nothing was running — the
user simply reopens and continues the pipeline. Clean, but only because SDD never
had running work to interrupt.

**Agile Engine:** Genuine resume: the board is on disk, run-state is in a
`minion-pm-run` session entry, and on `session_start(reason:"resume")` any task left
`in_progress` is detected as **interrupted** → `blocked` → surfaced at gate 4. A
`before_agent_start` prompt tells the agent every turn what's open. This is real
crash-recovery of active execution.

> **Winner: depends on the question.** If "resume" means "pick up a document
> pipeline," SDD's answer is adequate and free. If it means "recover a half-run
> parallel wave," only the Agile Engine actually does it — because only it *runs*
> waves.

### Scenario D — A subagent hangs (infinite tool loop, no output)

**SDD:** Not addressed, and mostly not applicable — subagents are invoked one-off
inside a phase; a hung one is a single stuck `/review` the user can Ctrl-C. No engine
means no wave to poison.

**Agile Engine:** Explicitly handled (§8.2): a heartbeat in `runner.ts`
(`STALL_IDLE_MS=120s`, `MAX_TASK_MS=15m`) kills the process, marks the task
`stalled`→`blocked`, increments `attempts`, and routes to gate 4 with accumulated
notes so a retry has context. Necessary *because* it runs unattended waves.

> **Winner: Agile Engine** — but note this is a cost it *incurs on itself*.
> Autonomous execution creates the stall problem that autonomous execution must then
> solve.

### Scenario E — Team collaboration; the plan should be reviewed in a PR

**SDD:** Artifacts live in the visible `docs/` tree, so `plan.md`/`spec.md`/`review.md`
show up in PRs naturally and read like design docs a human wrote. But the "board"
(`STATUS.md`) is a flat table with no live view.

**Agile Engine:** Recommends **in-repo `.pi/pm/`** precisely so the board travels
with the branch and is PR-reviewable (§4), *and* offers a live TUI kanban for the
person driving it. Richer, but the `.pi/pm/` tree is agent-managed churn that some
teams won't want in git diffs (§4's own trade-off table).

> **Winner: tie, different flavors.** SDD's artifacts read as human docs; the
> Engine's board reads as a tracked tool with a live view. Pick by whether your team
> wants "design docs" or "a tracker."

### Scenario F — Release reporting (what shipped to nightly / stable)

**SDD:** First-class. `/nightly` and `/stable` read git history + `review.md`
verdicts and emit `REL-` reports; the golden thread runs all the way to a
version-stamped, user-facing changelog. Release integrity is a mechanical check ("no
`REL-` includes a feature whose review ≠ pass").

**Agile Engine:** Largely **out of scope** — it manages work *to* done but doesn't
model channels/releases. You'd know what shipped from the board, but there's no
`nightly-*.md`/`stable-*.md` artifact or `REL-` traceability.

> **Winner: SDD** — release reporting is a capability the Engine simply doesn't have.

### Scenario G — Traceability audit ("does every line trace to a business objective?")

**SDD:** The whole point of P4's ID chain. "Is this aligned with the plan?" becomes
"list every `G-` with no matching `CHK-`" — a lookup over tables. Consistency checks
(§4) are mechanical *if the LLM maintains the IDs faithfully* — which is exactly the
drift risk.

**Agile Engine:** Traceability is structural (`parent` links, `dependsOn`) and code
can enforce it, but the chain is shallower (no `TEST-`/`CHK-`/`REL-` layer) — it
tracks *work items*, not *proof-of-objective*.

> **Winner: SDD on depth of the golden thread**, Agile Engine on *enforceability* of
> the (shallower) links it does have.

---

## 5. Trade-off summary

| | `thought.md` (SDD) | `agile-thought.md` (Agile Engine) |
|---|---|---|
| **Strengths** | Zero build cost; ships fast; preserves v2 philosophy; deep traceability; first-class release reports; artifacts read like human docs | Real scheduling (parallel/chain); authoritative state; blocking gates; genuine resume + stall recovery; scales to complex multi-day work; live TUI board |
| **Weaknesses** | No scheduling/parallelism across features; `STATUS.md` drift; soft gates the LLM can rationalize past; no resume of *running* work (has none); manual driving | Large surface (9 WPs, TDD); reintroduces removed subsystems; ceremony overkill for small work; engine coupled to host session; no release reporting; `.pi/pm/` git churn |
| **Best when** | Solo/small teams, incremental features, doc-driven culture, want it *now* | Complex projects, many parallel tasks, unattended execution, teams that want a real tracker |
| **Risk if wrong** | The board drifts and the golden thread quietly breaks | You rebuild v1's heavy, entangled machinery that v2 deleted for good reasons |

---

## 6. Alignment with the v2 charter

The v2 design (`docs/v2.0/design.md §3`) **removed** the kanban `task` board, the
`~/.pi/projects/<id>/` workspace, deterministic project IDs, and session resume.

- **`thought.md` stays inside that charter.** It gets the *benefit* v1 reached for
  (a trackable lifecycle) with no machinery — the board is a file, resume is a
  `read`. It's a natural extension of the Phase-1 `/init` bet.
- **`agile-thought.md` deliberately breaks that charter.** It re-adds a persistent
  board, a project notion, and session resume — and spends its §1 and §12 justifying
  the reversal (complex-project premise; reuse v1's proven model; opt-in &
  fail-non-fatal so the lean core is untouched for users who don't opt in).

> This is the single biggest strategic question: **is v2's zero-machinery stance a
> principle to hold, or a default to override when the problem is genuinely big?**
> SDD says hold it; the Agile Engine says override it *for this specific, opt-in use
> case*.

---

## 7. Can they coexist? (the hidden third option)

Both docs raise it (`thought.md` O-none directly; `agile-thought.md` **O6**: "Could
the two coexist — agile engine emits the same `plan.md`/`spec.md` artifacts?"). Three
ways to combine:

1. **SDD now, Engine later.** Ship zero-code SDD (fast, charter-safe), and add the
   Agile Engine as an opt-in Phase 3 only if real projects prove SDD can't hold
   scale. Lowest risk; matches `thought.md`'s own "prove the workflow before adding
   code" stance (§6).
2. **Engine emits SDD artifacts.** The Agile Engine becomes the *runtime*; its
   work-items serialize to `plan.md`/`spec.md`/`review.md` so you get the golden
   thread + release reports *and* real scheduling. Most powerful, most work.
3. **SDD + the read-only lens.** SDD plus `thought.md`'s optional `pm_check`/
   `pm_status` (§6) — a *pure function over the markdown* that derives the board and
   validates the ID graph, curing drift **without** persisted state. A principled
   middle: catches SDD's one real weakness while honoring the "no source of truth in
   code" invariant.

> **The line that decides #2 vs #3:** `thought.md` insists any code be a *lens*
> (pure function over artifacts, never authoritative). `agile-thought.md`'s engine is
> the *opposite* — code is the source of truth. You can't blend those two invariants;
> you pick which one owns the state.

---

## 8. Decision guide

Answer these to choose:

1. **How big is the typical project?** Small/incremental → **SDD**. Complex,
   multi-day, many parallel tasks → **Agile Engine**.
2. **Do you need unattended execution** (an engine that *runs* tasks, recovers from
   crashes and stalls)? No → **SDD**. Yes → **Agile Engine**.
3. **How much do you value the v2 zero-machinery charter?** As a principle → **SDD**.
   As overridable for a big opt-in feature → **Agile Engine**.
4. **Do you need release reporting / deep objective traceability?** Yes → **SDD**
   (only it has `/nightly`, `/stable`, the full `OBJ→…→REL` chain).
5. **How much build budget do you have now?** Little → **SDD** (prompts + templates).
   A real project's worth → **Agile Engine** (9 WPs, TDD).

**Suggested path (synthesis, not a mandate):** ship **SDD first** — it's fast,
charter-aligned, and the request's release/traceability parts *only* exist there — and
treat the **Agile Engine as an earned upgrade** (coexistence option #1/#3): add the
read-only lens if drift bites, and the full engine only if real multi-day projects
prove the prompt-only board can't hold them. This gets value now and defers the
charter reversal until it's clearly justified by use.

---

## 9. At-a-glance recap

```
                         thought.md (SDD)            agile-thought.md (Engine)
who manages the project   the LLM (via prompts)       code (LLM decides locally)
the board is              a markdown file             a code state machine + cards + TUI
work is run by            the user (manual /phases)   the engine (runWave, parallel/chain)
gates are                 prompt "STOP" (soft)        ctx.ui.confirm (hard, blocking)
resume                    re-read artifacts           durable state + stall recovery
new code                  ~none                       a pm/ package (9 WPs)
release reports           yes (/nightly, /stable)     no
v2 charter                preserved                   deliberately reversed
sweet spot                small/incremental, fast     complex/parallel, multi-day
```

> **Bottom line:** these aren't two versions of the same feature — they're two
> philosophies of what "an LLM managing a project" should mean. SDD makes the LLM
> disciplined; the Agile Engine makes the LLM unnecessary for the parts it's bad at.
> Choose by project scale and by how firmly you hold the v2 no-machinery line.
