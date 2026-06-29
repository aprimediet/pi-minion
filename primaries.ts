/**
 * Primary agents (v2.1) — bundled named personas for the *main* loop that
 * the user switches between mid-session. Mirrors opencode's plan/build split.
 *
 * Module layout:
 *   `loadBundledPrimaries(dir?)`    — parses `*.md` from a directory (typically
 *                                      the bundled `primaries/` shipped with
 *                                      this extension).
 *   `resolvePrimaries(bundled, discovered)` — merges bundled + user `type:
 *                                       primary` agents; user overrides bundled
 *                                       by name, new user primaries append.
 *   `createPrimaryController(pi, primaries, opts?)` — owns the active-primary
 *                                      state; applies model/tools/systemPrompt
 *                                      via the injected `pi`, cycles, injects
 *                                      the system prompt on every turn, and
 *                                      persists user-chosen models into
 *                                      `settings.json#agents[name].model`.
 *
 * The controller is **DI-only** — never touches the FS in production paths
 * (the bundled dir is opt-in via `opts.bundledDir`; the writer is opt-in via
 * `opts.writeOverride`). Tests inject a fake `pi` and an in-memory writer.
 *
 * WP0 decision (recorded in commit log + README): pi's built-in Shift+Tab
 * (`app.thinking.cycle`) is in `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS`
 * with `restrictOverride=true`, so an extension that registers `shift+tab` is
 * silently dropped at runtime — see `runner.js#getShortcuts`. We work around
 * this by *user-side override*: instruct users to add to
 * `~/.pi/agent/keybindings.json`:
 *   { "app.thinking.cycle": ["ctrl+shift+tab"] }
 * That moves thinking cycling to `ctrl+shift+tab` (a free key), so
 * `getShortcuts` no longer sees `shift+tab` as reserved and the extension
 * primary-cycle binding on `shift+tab` wins. The `alt+t` binding for thinking
 * level remains as a belt-and-braces alternative. Mirrors what
 * `permission-modes` does for its mode cycle. See docs/v2.1/design.md §O2.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
	resolveAgentRuntime,
	defaultSettingsPath,
	readAgentOverrides,
	writeAgentOverride,
	type AgentOverride,
} from "./config.ts";

export type PrimarySource = "bundled" | "user" | "project";

export interface PrimaryAgent {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: PrimarySource;
	filePath: string;
}

/** Parse a directory of bundled primary-agent `*.md` files. Fail-soft. */
export function loadBundledPrimaries(dir?: string): PrimaryAgent[] {
	const targetDir = dir ?? defaultBundledPrimariesDir();
	const out: PrimaryAgent[] = [];
	if (!fs.existsSync(targetDir)) return out;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(targetDir, { withFileTypes: true });
	} catch {
		return out;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(targetDir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let parsed: { frontmatter: Record<string, string>; body: string };
		try {
			parsed = parseFrontmatter<Record<string, string>>(content);
		} catch {
			continue;
		}
		const { frontmatter, body } = parsed;

		if (!frontmatter.name || !frontmatter.description) continue;

		// Bundled primaries must declare `type: primary`. A missing or wrong
		// value here is treated as a bug — but we still fail-soft and skip.
		const rawType = (frontmatter.type ?? "").trim().toLowerCase();
		if (rawType !== "primary") continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		const toolsOrUndef = tools && tools.length > 0 ? tools : undefined;

		out.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: toolsOrUndef,
			model: frontmatter.model,
			systemPrompt: body,
			source: "bundled",
			filePath,
		});
	}
	return out;
}

export interface ResolvePrimariesOptions {
	/** Bundled-only primary to keep even if a user one shadows it; default false. */
	keepBundledOverride?: boolean;
}

/**
 * Merge bundled + user primaries.
 *   • Bundled primaries kept in input order (caller decides cycle order).
 *   • A user primary with a bundled name **overrides** the bundled entry
 *     (and stays in the same bundled position).
 *   • New user primaries (no bundled shadow) are appended, sorted alphabetically
 *     by name for stable cycle order.
 */
export function resolvePrimaries(
	bundled: PrimaryAgent[],
	discovered: AgentConfigLike[],
): PrimaryAgent[] {
	// Map of user-discovered primaries by name (filtered to `type: "primary"`).
	const userByName = new Map<string, PrimaryAgent>();
	for (const d of discovered) {
		if (d.type !== "primary") continue;
		userByName.set(d.name, {
			name: d.name,
			description: d.description,
			tools: d.tools,
			model: d.model,
			systemPrompt: d.systemPrompt,
			source: d.source === "project" ? "project" : "user",
			filePath: d.filePath,
		});
	}

	// Walk bundled in input order; user entry (if any) wins at the same slot.
	const ordered: PrimaryAgent[] = [];
	const seen = new Set<string>();
	for (const b of bundled) {
		const u = userByName.get(b.name);
		ordered.push(u ?? b);
		seen.add(b.name);
	}

	// Append user primaries NOT shadowing bundled, sorted alphabetically.
	const extra = Array.from(userByName.values())
		.filter((u) => !seen.has(u.name))
		.sort((a, b) => a.name.localeCompare(b.name));
	ordered.push(...extra);

	return ordered;
}

// Minimal shape of an AgentConfig so this module doesn't depend on agents.ts
// (which would be a circular dep via index.ts). Mirrors the AgentConfig subset
// the controller actually reads.
export interface AgentConfigLike {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
	type?: "primary" | "subagent";
}

// =============================================================================
// Controller
// =============================================================================

/** Subset of `ExtensionAPI` that the controller touches. Avoids a hard import. */
export interface PrimaryControllerPi {
	setActiveTools(tools: string[]): void;
	setModel(model: Model<any>): Promise<boolean> | boolean | void;
	getActiveTools(): string[];
	getAllTools(): Array<{ name: string }>;
	getThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	setThinkingLevel(
		level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
	): void;
	appendEntry(customType: string, data: unknown): void;
	/**
	 * Inject a custom message into the conversation. Used to anchor the
	 * current primary's identity in the conversation history so the LLM
	 * sees the active persona + tool allowlist at every turn, including
	 * when switching mid-session.
	 *
	 * Signature mirrors `ExtensionAPI.sendMessage` for the subset we use:
	 * `Pick<CustomMessage, "customType" | "content" | "display" | "details">`.
	 * Optional — older pi versions or test fakes may not implement it.
	 */
	sendMessage?(
		message: {
			customType: string;
			content: string;
			display?: boolean;
			details?: unknown;
		},
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> | void;
}

export interface PrimaryControllerContext {
	hasUI: boolean;
	cwd: string;
	ui: { notify: (msg: string) => void; setStatus: (key: string, text: string | undefined) => void };
	model?: Model<any>;
	modelRegistry?: {
		find: (provider: string, model: string) => Model<any> | undefined;
		getAll?: () => Model<any>[];
	};
	sessionManager?: { getEntries: () => unknown[] };
}

export interface CreatePrimaryControllerOptions {
	/** Default primary to apply at first session start (default: "build"). */
	defaultName?: string;
	/** Override path for the settings file (default: `defaultSettingsPath()`). */
	settingsPath?: string;
	/** Override read of `settings.json#agents` (test seam). */
	readOverrides?: (settingsPath?: string) => Record<string, AgentOverride>;
	/** Override write of `settings.json#agents[name]` (test seam). */
	writeOverride?: (
		name: string,
		patch: { model?: string; tools?: string },
		settingsPath?: string,
	) => Promise<boolean> | boolean;
	/** Override lookup of a model by id (test seam; default uses ctx.modelRegistry). */
	resolveModel?: (id: string) => Model<any> | undefined;
}

export interface PrimaryController {
	getActive(): PrimaryAgent | undefined;
	list(): PrimaryAgent[];
	apply(name: string, ctx: PrimaryControllerContext): Promise<void>;
	cycle(ctx: PrimaryControllerContext): Promise<void>;
	injectSystemPrompt(event: { systemPrompt: string }):
		| { systemPrompt: string }
		| undefined;
	/**
	 * Filter stale `minion-primary-context` messages out of the conversation
	 * before each LLM call. Keeps ONLY the latest marker matching the
	 * currently active primary. Wired to `pi.on("context", ...)` by index.ts.
	 *
	 * Messages are typed as `unknown[]` to avoid importing pi's internal
	 * `AgentMessage` type — we duck-type the `customType` property the same
	 * way `examples/extensions/plan-mode` does.
	 */
	filterContextMessages(messages: unknown[]): unknown[];
	onModelChanged(
		model: { id: string; provider?: string } | Model<any>,
		ctx: PrimaryControllerContext,
	): void;
}

interface Snapshot {
	model: Model<any> | string | undefined;
	tools: string[];
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Custom message tag for the persistent primary marker injected via
 * `pi.sendMessage` and filtered via `pi.on("context", ...)`. Exported so
 * `index.ts` and tests can reference it without copy-paste.
 *
 * Distinct from `appendEntry("minion-primary", ...)` which is for session
 * persistence (restore on resume), NOT for LLM context. They share the
 * "primary" prefix but serve different purposes; that's intentional — the
 * restore entry stays after resume, the context marker is transient.
 */
export const PRIMARY_MARKER_CUSTOMTYPE = "minion-primary-context";

/** Create a primary-agent controller wired to the given (possibly-fake) `pi`. */
export function createPrimaryController(
	pi: PrimaryControllerPi,
	primaries: PrimaryAgent[],
	opts: CreatePrimaryControllerOptions = {},
): PrimaryController {
	const defaultName = opts.defaultName ?? "build";
	const settingsPath = opts.settingsPath; // may be undefined; passed through
	const readOverrides = opts.readOverrides ?? ((p?: string) => readOverridesDefault(p));
	const writeOverride =
		opts.writeOverride ??
		((name, patch, p) => writeOverrideDefault(name, patch, p ?? defaultSettingsPath()));

	const byName = new Map(primaries.map((p) => [p.name, p]));

	let active: PrimaryAgent | undefined;
	let snapshot: Snapshot | undefined;

	// v2.1.1 v3 — Guard flag for the `model_select` event:
	// pi.setModel() inside setModelFor emits a `model_select` event with
	// source="set", which the global handler in index.ts forwards to
	// onModelChanged. Without the guard, that handler would overwrite the
	// stored model in settings.json every time we switch primaries, even
	// though the change was programmatic (extension-initiated), not
	// user-initiated.
	//
	// The guard is a "match-by-id" check: when the controller sets a model,
	// the same Model identity flows back through model_select a tick later.
	// We track the in-flight programmatic set with its identity; the
	// subsequent `model_select` carrying the same model skips persistence.
	// This works regardless of whether pi emits the event synchronously or
	// asynchronously (microtask) — the identity check survives the event loop.
	let _pendingProgrammaticSet: Model<any> | null = null;

	function readOverridesDefault(p?: string): Record<string, AgentOverride> {
		return readAgentOverrides(p ?? defaultSettingsPath());
	}

	function writeOverrideDefault(
		name: string,
		patch: { model?: string; tools?: string },
		p: string,
	): Promise<boolean> | boolean {
		// writeAgentOverride returns Promise<boolean>; surface the value as-is
		// to honour the WriteOverrideFn contract (sync or async).
		return writeAgentOverride(name, patch, p);
	}

	function takeSnapshot(ctx: PrimaryControllerContext): Snapshot {
		if (snapshot) return snapshot;
		snapshot = {
			model: ctx.model,
			tools: pi.getActiveTools(),
			thinkingLevel: pi.getThinkingLevel(),
		};
		return snapshot;
	}

	function resolveTargetTools(p: PrimaryAgent): string[] | undefined {
		return p.tools;
	}

	function setToolsFor(p: PrimaryAgent, ctx: PrimaryControllerContext): void {
		const wanted = resolveTargetTools(p);
		if (wanted && wanted.length > 0) {
			// Validate against the host's available toolset; drop unknown names
			// fail-soft (mirrors preset.ts behavior).
			const known = new Set(pi.getAllTools().map((t) => t.name));
			const valid = wanted.filter((t) => known.has(t));
			if (valid.length > 0) {
				pi.setActiveTools(valid);
			}
		} else {
			// No `tools` in frontmatter → restore the snapshot's full set.
			const snap = takeSnapshot(ctx);
			pi.setActiveTools(snap.tools);
		}
	}

	function setModelFor(p: PrimaryAgent, ctx: PrimaryControllerContext): void {
		const overrides = readOverrides(settingsPath);
		const { model: resolvedModelId } = resolveAgentRuntime(
			{ model: p.model, tools: p.tools },
			overrides,
			p.name,
		);

		if (!resolvedModelId) {
			// No model override → restore snapshot model (if any).
			const snap = takeSnapshot(ctx);
			if (snap.model) {
				_pendingProgrammaticSet = snap.model;
				try {
					pi.setModel(snap.model);
				} finally {
					// Clear after pi synchronously returns. If pi emits
					// model_select asynchronously, onModelChanged's identity
					// check will have already-cleared the flag and we'd lose
					// the match. Better strategy: clear the pending set after
					// a microtask, so the async event still matches.
					queueMicrotask(() => { _pendingProgrammaticSet = null; });
				}
			}
			return;
		}

		// Resolve "provider/model" string to a Model<any> object.
		// ExtensionAPI.setModel() requires a Model object, not a string.
		let model: Model<any> | undefined;

		const parts = resolvedModelId.split('/');
		const hasProvider = parts.length >= 2;
		const provider = hasProvider ? parts[0] : '';
		const modelName = hasProvider ? parts.slice(1).join('/') : resolvedModelId;

		if (hasProvider && ctx.modelRegistry?.find) {
			model = ctx.modelRegistry.find(provider, modelName);
		}

		// No provider in ID, or registry.find missed: try getAll().
		if (!model && ctx.modelRegistry?.getAll) {
			model = ctx.modelRegistry.getAll().find(
				(m) => m.id === resolvedModelId || m.name === resolvedModelId,
			);
		}

		// Test seam / last resort.
		if (!model && opts.resolveModel) {
			model = opts.resolveModel(resolvedModelId);
		}

		if (model) {
			// Track in-flight programmatic set. real pi may emit model_select
			// synchronously *or* asynchronously — using a microtask to clear
			// the pending marker handles both: a sync handler clears it before
			// finally runs (via direct match), and an async handler reads the
			// identity in the next microtask before we null it.
			_pendingProgrammaticSet = model;
			try {
				pi.setModel(model);
			} finally {
				queueMicrotask(() => { _pendingProgrammaticSet = null; });
			}
		}
		// No model resolved → inherit current (no change).
	}

	function updateStatus(p: PrimaryAgent | undefined, ctx: PrimaryControllerContext): void {
		if (p) {
			ctx.ui.setStatus("minion", `primary:${p.name}`);
		} else {
			ctx.ui.setStatus("minion", undefined);
		}
	}

	/**
	 * Build the persistent primary-marker content injected into the
	 * conversation via `pi.sendMessage`. Made explicit so the LLM can
	 * answer "what's active right now and what tools are at my disposal"
	 * from the conversation history alone — without inferring from prior
	 * tool calls in past turns.
	 *
	 * Two-line format keeps it cheap but unambiguous:
	 *   - First line: HUMAN-readable primary name + role
	 *   - Second line: explicit tool allowlist + "NOT available" reminder
	 *
	 * The "NOT available" phrasing directly addresses the user's worry
	 * ("LLM masih pake list tool yang lama pas udah switch"): after a
	 * primary switch, the LLM has explicit text saying the old tools are
	 * gone, so it won't try to call them.
	 */
	function buildPrimaryMarkerContent(p: PrimaryAgent): string {
		const toolsLine = p.tools && p.tools.length > 0
			? p.tools.join(", ")
			: "(no restriction — full default toolset)";
		return (
			`[MINION PRIMARY: ${p.name}]\n` +
			`Active persona: ${p.description}\n` +
			`Available tools this turn: ${toolsLine}.\n` +
			`Other tools (e.g. from previous primaries) are NOT active; the agent cannot call them right now.`
		);
	}

	function apply(name: string, ctx: PrimaryControllerContext): Promise<void> {
		const target = byName.get(name);
		if (!target) {
			ctx.ui.notify(`Unknown primary "${name}". Available: ${primaries.map((p) => p.name).join(", ") || "(none)"}`);
			return Promise.resolve();
		}
		// Snapshot BEFORE first switch only (so apply(build) after apply(plan)
		// keeps plan's snapshot, not build's).
		takeSnapshot(ctx);
		setToolsFor(target, ctx);
		setModelFor(target, ctx);
		active = target;
		updateStatus(target, ctx);
		// Inject a custom message into the conversation anchoring the current
		// persona + tool allowlist. `display: false` so the user doesn't see
		// it in scrollback — only the LLM context. `triggerTurn: false` so we
		// don't start an agent loop just to mark the mode change.
		//
		// Fire-and-forget: `sendMessage` may return a promise; we don't want
		// `apply()` to be conditional on it (the mode switch is the primary
		// effect, the marker is metadata).
		if (pi.sendMessage) {
			try {
				pi.sendMessage(
					{
						customType: PRIMARY_MARKER_CUSTOMTYPE,
						content: buildPrimaryMarkerContent(target),
						display: false,
					},
					{ triggerTurn: false },
				);
			} catch (e) {
				// Fail non-fatally — marker is informational, primary switch
				// is the core effect. Log via notify so the user knows if
				// debugging.
				ctx.ui.notify(
					`Minion: failed to inject primary marker (${(e as Error).message}). The switch itself succeeded.`,
				);
			}
		}
		return Promise.resolve();
	}

	function cycle(ctx: PrimaryControllerContext): Promise<void> {
		const order = primaries;
		if (order.length === 0) return Promise.resolve();
		const curIdx = active ? order.findIndex((p) => p.name === active!.name) : -1;
		// curIdx === -1 (none active) → start at 0. Otherwise advance with wrap.
		const nextIdx = curIdx === -1 ? 0 : (curIdx + 1) % order.length;
		const next = order[nextIdx]!;
		return apply(next.name, ctx);
	}

	function injectSystemPrompt(
		event: { systemPrompt: string },
	): { systemPrompt: string } | undefined {
		if (!active) return undefined;
		const body = (active.systemPrompt ?? "").trim();
		if (!body) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${body}` };
	}

	function modelId(m: { id: string } | Model<any>): string {
		// Model from @earendil-works/pi-ai has `.id`; ModelSelectEvent.model.id.
		return (m as { id?: string }).id ?? "";
	}

	function modelProvider(m: { id: string } | Model<any>): string {
		return (m as { provider?: string }).provider ?? "";
	}

	function onModelChanged(
		model: { id: string; provider?: string } | Model<any>,
		_ctx: PrimaryControllerContext,
	): void {
		if (!active) return;
		// Skip if this model change was triggered programmatically by the
		// controller itself (see setModelFor). Match by identity: if the model
		// being signalled was the same one we just programmatically set, it was
		// an internal load, not a user-initiated change. We compare by reference
		// (===) for objects from modelRegistry; for plain {id, provider} shape
		// passed from tests, compare by id+provider string. The first call to
		// onModelChanged clears the pending marker so we don't suppress the
		// *next* legitimate user change.
		const incomingId = (model as { id?: string }).id ?? "";
		const incomingProvider = (model as { provider?: string }).provider ?? "";
		const pending = _pendingProgrammaticSet;
		if (pending && (pending as { id?: string }).id === incomingId && (pending as { provider?: string }).provider === incomingProvider) {
			_pendingProgrammaticSet = null;
			return;
		}
		const id = modelId(model);
		if (!id) return;
		// Persist full "provider/model-id" so setModelFor can split with /
		// and resolve via modelRegistry.find. If no provider on the model,
		// fall back to plain id (rare; legacy compat).
		const provider = modelProvider(model);
		const fullId = provider ? `${provider}/${id}` : id;
		void writeOverride(active.name, { model: fullId }, settingsPath);
	}

	/**
	 * Strip all `minion-primary-context` messages from a conversation,
	 * then re-add exactly ONE current marker (if any primary is active).
	 *
	 * Why this two-step approach instead of "keep latest matching marker"?
	 * Because `apply()` happens AT switch time, but the `context` event
	 * fires on EVERY LLM call. We need the resulting filtered list to
	 * contain exactly one marker per turn pointing to the current primary,
	 * regardless of how many turns elapsed since the last switch.
	 *
	 * Returns the filtered array; returns the same array reference if no
	 * filtering happened (lets `pi.on("context")` skip no-op rendering).
	 */
	function filterContextMessages(messages: unknown[]): unknown[] {
		const filtered = messages.filter(
			(m) => (m as { customType?: string }).customType !== PRIMARY_MARKER_CUSTOMTYPE,
		);
		if (!active) return filtered;
		// Append the current marker. The conversation receives it via the
		// `context` event on each turn; this is equivalent to injecting at
		// the head of conversation but doesn't accumulate across turns
		// because we just removed every prior occurrence.
		filtered.push({
			role: "custom",
			customType: PRIMARY_MARKER_CUSTOMTYPE,
			content: buildPrimaryMarkerContent(active),
			display: false,
		});
		return filtered;
	}

	return {
		getActive: () => active,
		list: () => primaries.slice(),
		apply,
		cycle,
		injectSystemPrompt,
		filterContextMessages,
		onModelChanged,
	};
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

function defaultBundledPrimariesDir(): string {
	const here =
		typeof import.meta.dirname === "string"
			? import.meta.dirname
			: path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, "primaries");
}

// ----------------------------------------------------------------------------
// Optional helper: cycle thinking level on Alt+T (used by index.ts).
// ----------------------------------------------------------------------------

/** Cycle through the canonical pi thinking-level list, wrapping. */
export function cycleThinkingLevel(pi: PrimaryControllerPi): void {
	const cur = pi.getThinkingLevel();
	const idx = THINKING_LEVELS.indexOf(cur);
	const next = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length] as ThinkingLevel;
	pi.setThinkingLevel(next);
}