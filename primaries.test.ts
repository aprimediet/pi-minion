/**
 * Tests for `primaries.ts` (v2.1).
 *
 * The PrimaryController is exercised **only with an injected fake `pi`** —
 * we never spin up a real pi session, and never spawn subprocesses. The
 * writer (`writeAgentOverride`) is also injected so model-persistence can
 * be asserted hermetically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	loadBundledPrimaries,
	resolvePrimaries,
	createPrimaryController,
	type PrimaryAgent,
	type PrimaryControllerPi,
	type PrimaryControllerContext,
} from "./primaries.ts";
import type { AgentConfig } from "./agents.ts";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minion-primaries-test-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makePrimary(overrides: Partial<PrimaryAgent> = {}): PrimaryAgent {
	return {
		name: "build",
		description: "full-capability execution",
		systemPrompt: "be build",
		source: "bundled",
		filePath: "/bundled/build.md",
		...overrides,
	};
}

function makePlanPrimary(): PrimaryAgent {
	return makePrimary({
		name: "plan",
		description: "read-only planning",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt: "be plan",
	});
}

function makeDiscoveredAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "foo",
		description: "d",
		systemPrompt: "b",
		source: "user",
		filePath: "/user/foo.md",
		type: "primary",
		...overrides,
	};
}

/** Build a fake `pi` that records every mutating call we care about. */
function fakePi() {
	const calls = {
		setActiveTools: [] as string[][],
		setModel: [] as Array<unknown>,
		setThinkingLevel: [] as string[],
		appendEntry: [] as Array<{ type: string; data: unknown }>,
		notify: [] as string[],
		getActiveTools: vi.fn(() => ["read", "bash", "edit", "write"]),
		getAllTools: vi.fn(() => [
			{ name: "read" },
			{ name: "grep" },
			{ name: "find" },
			{ name: "ls" },
			{ name: "bash" },
			{ name: "edit" },
			{ name: "write" },
		]),
		getThinkingLevel: vi.fn(() => "off" as const),
		setModelFn: vi.fn(async (_m: unknown) => true),
	};
	// `satisfies` keeps the structural shape AND infers literal types where
	// possible, so we can drop the `as never` casts at call sites without
	// losing access to the `vi.fn()` mock state.
	const pi = {
		setActiveTools: vi.fn((tools: string[]) => calls.setActiveTools.push(tools)),
		setModel: calls.setModelFn,
		getActiveTools: calls.getActiveTools,
		getAllTools: calls.getAllTools,
		getThinkingLevel: calls.getThinkingLevel,
		setThinkingLevel: vi.fn((level: string) => calls.setThinkingLevel.push(level)),
		appendEntry: vi.fn((type: string, data: unknown) => calls.appendEntry.push({ type, data })),
	} satisfies PrimaryControllerPi;
	return { pi, calls };
}

/**
 * Minimal context matching `PrimaryControllerContext` exactly. Using a typed
 * helper instead of `as never` casts catches future schema drift at compile
 * time — if `PrimaryControllerContext` adds a required field, this helper
 * becomes a type error rather than a silent runtime bug.
 */
function fakeCtx(overrides: {
	cwd?: string;
	model?: unknown;
	modelRegistry?: PrimaryControllerContext["modelRegistry"];
} = {}): PrimaryControllerContext & {
		ui: PrimaryControllerContext["ui"] & {
			setStatus: ReturnType<typeof vi.fn>;
			notify: ReturnType<typeof vi.fn>;
		};
	} {
		return {
			cwd: overrides.cwd ?? "/tmp",
			hasUI: true,
			ui: { notify: vi.fn(), setStatus: vi.fn() },
			model: overrides.model as PrimaryControllerContext["model"],
			sessionManager: { getEntries: vi.fn(() => []) },
			modelRegistry: overrides.modelRegistry ?? { find: vi.fn(() => undefined) },
		};
	}

// ----------------------------------------------------------------------------
// loadBundledPrimaries
// ----------------------------------------------------------------------------

describe("loadBundledPrimaries", () => {
	it("returns [] when dir does not exist", () => {
		expect(loadBundledPrimaries(path.join(tmp, "missing"))).toEqual([]);
	});

	it("parses a single .md file into a PrimaryAgent (source='bundled')", () => {
		const dir = path.join(tmp, "primaries");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "build.md"),
			`---
name: build
type: primary
description: full execution
---

You are in BUILD mode.`,
		);
		const out = loadBundledPrimaries(dir);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			name: "build",
			description: "full execution",
			source: "bundled",
			filePath: path.join(dir, "build.md"),
		});
		expect(out[0].systemPrompt.trim()).toBe("You are in BUILD mode.");
	});

	it("parses every .md file in the dir, ignoring non-md", () => {
		const dir = path.join(tmp, "primaries");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "build.md"), `---\nname: build\ntype: primary\ndescription: d\n---\nb`);
		fs.writeFileSync(path.join(dir, "plan.md"), `---\nname: plan\ntype: primary\ndescription: d\n---\nb`);
		fs.writeFileSync(path.join(dir, "ignore.txt"), "---\nname: x\ntype: primary\n---\nb");
		const out = loadBundledPrimaries(dir);
		const names = out.map((p) => p.name).sort();
		expect(names).toEqual(["build", "plan"]);
		for (const p of out) expect(p.source).toBe("bundled");
	});

	it("captures tools and model from frontmatter", () => {
		const dir = path.join(tmp, "primaries");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "plan.md"),
			`---
name: plan
type: primary
description: planning
tools: read, grep, find, ls
model: claude-opus-4-5
---

b`,
		);
		const out = loadBundledPrimaries(dir);
		expect(out[0].tools).toEqual(["read", "grep", "find", "ls"]);
		expect(out[0].model).toBe("claude-opus-4-5");
	});

	it("skips a malformed file fail-soft (does not throw)", () => {
		const dir = path.join(tmp, "primaries");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "broken.md"), `not frontmatter at all`);
		fs.writeFileSync(
			path.join(dir, "good.md"),
			`---\nname: good\ntype: primary\ndescription: d\n---\nb`,
		);
		const out = loadBundledPrimaries(dir);
		expect(out.map((p) => p.name)).toEqual(["good"]);
	});

	it("skips a file missing required name/description", () => {
		const dir = path.join(tmp, "primaries");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "no-name.md"),
			`---\ntype: primary\ndescription: d\n---\nb`,
		);
		expect(loadBundledPrimaries(dir)).toEqual([]);
	});
});

// ----------------------------------------------------------------------------
// resolvePrimaries
// ----------------------------------------------------------------------------

describe("resolvePrimaries", () => {
	it("returns bundled as-is when discovered is empty", () => {
		const bundled = [makePrimary({ name: "build" }), makePlanPrimary()];
		const out = resolvePrimaries(bundled, []);
		expect(out.map((p) => p.name)).toEqual(["build", "plan"]);
	});

	it("filters discovered to type === 'primary'", () => {
		const bundled = [makePrimary({ name: "build" })];
		const discovered = [
			makeDiscoveredAgent({ name: "foo", type: "primary" }),
			makeDiscoveredAgent({ name: "scout", type: "subagent" }),
			// No `type` -> AgentConfig.type is undefined; must be excluded.
			makeDiscoveredAgent({ name: "legacy", type: undefined }),
		];
		const out = resolvePrimaries(bundled, discovered);
		expect(out.map((p) => p.name)).toEqual(["build", "foo"]);
	});

	it("user primary with bundled name overrides the bundled entry", () => {
		const bundled = [makePrimary({ name: "build", description: "bundled desc" })];
		const discovered = [
			makeDiscoveredAgent({
				name: "build",
				description: "user override",
				systemPrompt: "user body",
				source: "user",
				filePath: "/user/build.md",
				type: "primary",
			}),
		];
		const out = resolvePrimaries(bundled, discovered);
		expect(out).toHaveLength(1);
		expect(out[0].description).toBe("user override");
		expect(out[0].systemPrompt.trim()).toBe("user body");
		expect(out[0].source).toBe("user");
	});

	it("appends new user primaries after bundled, alphabetically by name within user", () => {
		const bundled = [makePrimary({ name: "build" }), makePlanPrimary()];
		const discovered = [
			makeDiscoveredAgent({ name: "zebra", type: "primary" }),
			makeDiscoveredAgent({ name: "alpha", type: "primary" }),
		];
		const out = resolvePrimaries(bundled, discovered);
		// bundled in given order, user added sorted by name
		expect(out.map((p) => p.name)).toEqual(["build", "plan", "alpha", "zebra"]);
	});

	it("bundled order is preserved (not re-sorted) before user primaries", () => {
		const bundled = [makePlanPrimary(), makePrimary({ name: "build" })];
		const out = resolvePrimaries(bundled, [makeDiscoveredAgent({ name: "foo", type: "primary" })]);
		expect(out.map((p) => p.name)).toEqual(["plan", "build", "foo"]);
	});
});

// ----------------------------------------------------------------------------
// createPrimaryController
// ----------------------------------------------------------------------------

describe("createPrimaryController", () => {
	const build = makePrimary({ name: "build" });
	const plan = makePlanPrimary();
	const primaries = [build, plan];

	it("list() returns primaries in the resolved order", () => {
		const { pi } = fakePi();
		const c = createPrimaryController(pi, primaries, { defaultName: "build" });
		expect(c.list().map((p) => p.name)).toEqual(["build", "plan"]);
	});

	it("getActive() returns undefined until apply()", () => {
		const { pi } = fakePi();
		const c = createPrimaryController(pi, primaries, { defaultName: "build" });
		expect(c.getActive()).toBeUndefined();
	});

	it("apply('plan') sets the restricted toolset and updates status", async () => {
		const { pi, calls } = fakePi();
		// Isolate from real settings.json so the 'no model' assertion holds.
		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			readOverrides: () => ({}),
		});
		const ctx = fakeCtx();
		await c.apply("plan", ctx);
		expect(c.getActive()?.name).toBe("plan");
		expect(calls.setActiveTools).toEqual([["read", "grep", "find", "ls"]]);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("minion", "primary:plan");
		// No model specified in frontmatter; should NOT call setModel.
		expect(calls.setModelFn).not.toHaveBeenCalled();
	});

	it("apply('build') restores full original tools on first switch", async () => {
		const { pi, calls } = fakePi();
		const c = createPrimaryController(pi, primaries, { defaultName: "build" });
		await c.apply("build", fakeCtx());
		// build has no tools declared -> full default toolset (whatever pi reports).
		expect(calls.setActiveTools).toEqual([["read", "bash", "edit", "write"]]);
	});

	it("apply('plan') with settings override calls pi.setModel with Model object via registry.find", async () => {
		const { pi, calls } = fakePi();
		const fakeModel = { id: "from-settings", provider: "test", name: "from-settings" } as const;
		const modelRegistry = { find: vi.fn(() => fakeModel) };
		const readOverrides = vi.fn(() => ({ plan: { model: "test/from-settings" } }));
		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			readOverrides,
		});
		await c.apply("plan", fakeCtx({ modelRegistry }));
		// registry.find called with correct provider + model name
		expect(modelRegistry.find).toHaveBeenCalledWith("test", "from-settings");
		// setModel called with the Model OBJECT (not a string)
		expect(calls.setModelFn).toHaveBeenCalledWith(fakeModel);
	});

	it("apply('plan') with frontmatter model (no provider) falls back to getAll()", async () => {
		const { pi, calls } = fakePi();
		const fakeModel = { id: "claude-sonnet-4-5", provider: "anthropic", name: "claude-sonnet-4-5" } as const;
		const modelRegistry = {
			find: vi.fn(() => undefined),
			getAll: vi.fn(() => [fakeModel, { id: "other", provider: "x", name: "other" }]),
		};
		const c = createPrimaryController(pi, [
			makePrimary({ name: "plan", model: "claude-sonnet-4-5" }),
		], {
			defaultName: "build",
			readOverrides: vi.fn(() => ({})),
		});
		await c.apply("plan", fakeCtx({ modelRegistry }));
		expect(modelRegistry.getAll).toHaveBeenCalled();
		expect(calls.setModelFn).toHaveBeenCalledWith(fakeModel);
	});

	it("apply('plan') with no model (override nor frontmatter) restores snapshot model from ctx", async () => {
		const { pi, calls } = fakePi();
		const snapshotModel = { id: "original", provider: "test", name: "original" } as const;
		const modelRegistry = { find: vi.fn(() => undefined) };
		const ctx = fakeCtx({ model: snapshotModel, modelRegistry });
		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			readOverrides: vi.fn(() => ({})),
		});
		await c.apply("plan", ctx);
		// plan has no model → restore snapshot model
		expect(calls.setModelFn).toHaveBeenCalledWith(snapshotModel);
	});

	it("apply('plan') gracefully skips model when modelRegistry unavailable", async () => {
		const { pi, calls } = fakePi();
		const readOverrides = vi.fn(() => ({ plan: { model: "test/any" } }));
		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			readOverrides,
		});
		const ctx = fakeCtx();
		delete (ctx as any).modelRegistry;
		await c.apply("plan", ctx);
		// no modelRegistry → fall through → no setModel
		expect(calls.setModelFn).not.toHaveBeenCalled();
	});

	it("apply('plan') falls back to opts.resolveModel when modelRegistry.find/getAll fail", async () => {
		const { pi, calls } = fakePi();
		const resolveModel = vi.fn(() => ({ id: "resolved", provider: "test", name: "resolved" } as const));
		const modelRegistry = {
			find: vi.fn(() => undefined),
			getAll: vi.fn(() => [] as Array<{ id: string; provider: string; name: string }>),
		};
		const readOverrides = vi.fn(() => ({ plan: { model: "test/fallback" } }));
		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			readOverrides,
			resolveModel,
		});
		await c.apply("plan", fakeCtx({ modelRegistry }));
		expect(resolveModel).toHaveBeenCalledWith("test/fallback");
		expect(calls.setModelFn).toHaveBeenCalled();
	});

	it("inherit (no setModel) when modelRegistry returns undefined and no opts.resolveModel", async () => {
		const { pi, calls } = fakePi();
		const modelRegistry = { find: vi.fn(() => undefined), getAll: vi.fn(() => []) };
		const readOverrides = vi.fn(() => ({ plan: { model: "test/nonexistent" } }));
		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			readOverrides,
		});
		await c.apply("plan", fakeCtx({ modelRegistry }));
		expect(calls.setModelFn).not.toHaveBeenCalled();
	});

	it("restores snapshot model when switching to a primary with no model after one with model", async () => {
		const { pi, calls } = fakePi();
		const planModel = { id: "plan-specific", provider: "test", name: "plan" } as const;
		const snapshotModel = { id: "original", provider: "test", name: "original" } as const;
		const modelRegistry = {
			find: vi.fn((provider: string, modelName: string) =>
				provider === "test" && modelName === "plan-model" ? planModel : undefined
			),
		};
		const ctx = fakeCtx({ model: snapshotModel, modelRegistry });
		const readOverrides = vi.fn(() => ({ plan: { model: "test/plan-model" } }));
		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			readOverrides,
		});
		// apply plan → loads planModel
		await c.apply("plan", ctx);
		expect(calls.setModelFn).toHaveBeenLastCalledWith(planModel);
		// apply build (no model) → restores snapshotModel
		await c.apply("build", ctx);
		expect(calls.setModelFn).toHaveBeenLastCalledWith(snapshotModel);
	});

	it("cycle(ctx) advances through list() in order, wrapping", async () => {
		const { pi, calls } = fakePi();
		const c = createPrimaryController(pi, primaries, { defaultName: "build" });
		// Start at plan (via apply).
		await c.apply("plan", fakeCtx());
		expect(c.getActive()?.name).toBe("plan");
		// cycle -> wraps to first (build)
		await c.cycle(fakeCtx());
		expect(c.getActive()?.name).toBe("build");
		// cycle again -> plan
		await c.cycle(fakeCtx());
		expect(c.getActive()?.name).toBe("plan");
		// 2 calls so far to apply('plan'); cycle should not call apply for a single 'plan'.
		// We only assert state transitions here.
		expect(calls.setActiveTools.length).toBeGreaterThanOrEqual(3);
	});

	it("injectSystemPrompt returns undefined when no primary is active", () => {
		const { pi } = fakePi();
		const c = createPrimaryController(pi, primaries, { defaultName: "build" });
		expect(c.injectSystemPrompt({ systemPrompt: "base" })).toBeUndefined();
	});

	it("injectSystemPrompt appends active body when a primary is active", async () => {
		const { pi } = fakePi();
		const c = createPrimaryController(pi, primaries, { defaultName: "build" });
		await c.apply("plan", fakeCtx());
		const out = c.injectSystemPrompt({ systemPrompt: "BASE" });
		expect(out).toEqual({ systemPrompt: "BASE\n\nbe plan" });
	});

	it("onModelChanged while a primary is active calls writeAgentOverride with provider/id format", async () => {
		const { pi } = fakePi();
		const writeOverride = vi.fn(async () => true);
		const settingsPath = path.join(tmp, "settings.json");
		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			settingsPath,
			readOverrides: vi.fn(() => ({})),
			writeOverride,
		});
		await c.apply("plan", fakeCtx());
		// Model has provider + id → must save "provider/id" format
		c.onModelChanged({ id: "claude-opus-4-5", provider: "anthropic" }, fakeCtx());
		expect(writeOverride).toHaveBeenCalledWith(
			"plan",
			{ model: "anthropic/claude-opus-4-5" },
			settingsPath,
		);
	});

	it("onModelChanged falls back to plain id when model has no provider", async () => {
		const { pi } = fakePi();
		const writeOverride = vi.fn(async () => true);
		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			readOverrides: vi.fn(() => ({})),
			writeOverride,
		});
		await c.apply("plan", fakeCtx());
		// No provider on the model → save just the id
		c.onModelChanged({ id: "claude-opus-4-5" }, fakeCtx());
		expect(writeOverride).toHaveBeenCalledWith(
			"plan",
			{ model: "claude-opus-4-5" },
			undefined,
		);
	});

	it("onModelChanged is a no-op when no primary is active", () => {
		const { pi } = fakePi();
		const writeOverride = vi.fn(async () => true);
		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			readOverrides: vi.fn(() => ({})),
			writeOverride,
		});
		c.onModelChanged({ id: "claude-opus-4-5" }, fakeCtx());
		expect(writeOverride).not.toHaveBeenCalled();
	});

	// ===========================================================================
	// v2.1.1 v3 — guard flag: programmatic pi.setModel() must NOT persist
	// to settings.json. Only USER-initiated model changes (via /model command
	// or model cycling UI) should writeOverride.
	// ===========================================================================

	/**
	 * Build a fake pi whose `setModel` defers a `model_select`-like callback
	 * to the next microtask (mirroring real pi's async event emission timing —
	 * after pi synchronously returns the new model).
	 *
	 * In production, real pi applies the model synchronously inside setModel()
	 * but the `model_select` event fires after — so by the time the event
	 * handler runs, the controller may have already advanced its internal
	 * state (e.g., `active` is set). Our deferral matches this behavior:
	 * the callback runs AFTER apply()'s synchronous work completes.
	 */
	function fakePiWithDeferredModelSelect(onModelSelected: (m: unknown) => void) {
		const { pi, calls } = fakePi();
		const realSetModel = pi.setModel;
		const wrapped = {
			...pi,
			setModel: ((m: unknown) => {
				// Defer to next microtask, matching real pi's async event emission.
				queueMicrotask(() => onModelSelected(m));
				return realSetModel(m as never);
			}) as typeof pi.setModel,
		};
		return { pi: wrapped, calls };
	}

	it("programmatic pi.setModel() in setModelFor does NOT trigger writeOverride (guard)", async () => {
		const fakeModel = { id: "loaded", provider: "x", name: "loaded" } as const;
		const modelRegistry = { find: vi.fn(() => fakeModel), getAll: vi.fn(() => [fakeModel]) };
		const readOverrides = vi.fn(() => ({ plan: { model: "x/loaded" } }));
		const writeOverride = vi.fn(async () => true);

		let onModelChangedRef: ((m: any) => void) | undefined;
		const { pi } = fakePiWithDeferredModelSelect((m) => onModelChangedRef?.(m));

		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			readOverrides,
			writeOverride,
		});
		// Bind the callback AFTER controller is created so it has access to
		// the closure's _settingModelProgrammatically guard.
		onModelChangedRef = (m) => c.onModelChanged(m, fakeCtx());

		await c.apply("plan", fakeCtx({ modelRegistry }));
		// Flush all microtasks so the deferred model_select callback runs.
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		// If the guard works, writeOverride was NEVER called during apply,
		// even though model_select fired inside pi.setModel.
		expect(writeOverride).not.toHaveBeenCalled();
	});

	it("USER-initiated onModelChanged (no prior programmatic set) DOES persist", async () => {
		const { pi } = fakePi();
		const writeOverride = vi.fn(async () => true);
		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			readOverrides: vi.fn(() => ({})),
			writeOverride,
		});
		await c.apply("plan", fakeCtx());
		c.onModelChanged({ id: "claude-sonnet-4-5", provider: "anthropic" }, fakeCtx());
		expect(writeOverride).toHaveBeenCalledWith(
			"plan",
			{ model: "anthropic/claude-sonnet-4-5" },
			undefined,
		);
	});

	it("guard resets after setModelFor — guard is per-call scoped", async () => {
		// Verify that the guard isn't accidentally sticky: after apply() returns,
		// a USER-initiated onModelChanged should persist.
		const fakeModel = { id: "loaded", provider: "x", name: "loaded" } as const;
		const modelRegistry = { find: vi.fn(() => fakeModel) };
		const readOverrides = vi.fn(() => ({ plan: { model: "x/loaded" } }));
		const writeOverride = vi.fn(async () => true);

		let onModelChangedRef: ((m: any) => void) | undefined;
		const { pi } = fakePiWithDeferredModelSelect((m) => onModelChangedRef?.(m));
		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			readOverrides,
			writeOverride,
		});
		onModelChangedRef = (m) => c.onModelChanged(m, fakeCtx());

		await c.apply("plan", fakeCtx({ modelRegistry }));
		// Flush microtasks so deferred model_select runs (and writeOverride is NOT called).
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(writeOverride).not.toHaveBeenCalled();
		// Now USER changes model manually → SHOULD persist (guard is reset).
		c.onModelChanged({ id: "user-choice", provider: "x" }, fakeCtx());
		expect(writeOverride).toHaveBeenCalledWith(
			"plan",
			{ model: "x/user-choice" },
			undefined,
		);
	});

	it("falls back to default 'build' when defaultName not specified", async () => {
		const { pi } = fakePi();
		const c = createPrimaryController(pi, primaries);
		await c.apply("build", fakeCtx());
		expect(c.getActive()?.name).toBe("build");
	});
});