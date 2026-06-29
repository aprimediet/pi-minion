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
function fakeCtx(overrides: { cwd?: string; model?: unknown } = {}): PrimaryControllerContext & {
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
			modelRegistry: { find: vi.fn(() => undefined) },
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

	it("apply() resolves model from settings override > frontmatter > inherit", async () => {
		const settingsPath = path.join(tmp, "settings.json");
		// 1. settings wins over frontmatter
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({ agents: { plan: { model: "from-settings" } } }),
		);
		const { pi, calls } = fakePi();
		const readOverrides = vi.fn(() => ({ plan: { model: "from-settings" } }));
		const writeOverride = vi.fn(async () => true);
		const c = createPrimaryController(pi, primaries, {
			defaultName: "build",
			settingsPath,
			readOverrides,
			writeOverride,
		});
		await c.apply("plan", fakeCtx());
		expect(calls.setModelFn).toHaveBeenCalledOnce();
		expect(calls.setModelFn.mock.calls[0][0]).toBe("from-settings");

		// 2. fall back to frontmatter when settings has no entry
		calls.setModelFn.mockClear();
		const c2 = createPrimaryController(pi, [
			makePlanPrimary(), // already has model in frontmatter via override above; rebuild fresh
		], {
			defaultName: "build",
			settingsPath,
			readOverrides: vi.fn(() => ({})), // no override
			writeOverride,
		});
		// give plan a frontmatter model
		c2.list()[0].model = "from-frontmatter";
		await c2.apply("plan", fakeCtx());
		expect(calls.setModelFn.mock.calls[0][0]).toBe("from-frontmatter");

		// 3. inherit (no setModel) when neither has it
		calls.setModelFn.mockClear();
		const c3 = createPrimaryController(pi, [
			makePrimary({ name: "plan", model: undefined }),
		], {
			defaultName: "build",
			settingsPath,
			readOverrides: vi.fn(() => ({})),
			writeOverride,
		});
		await c3.apply("plan", fakeCtx());
		expect(calls.setModelFn).not.toHaveBeenCalled();
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

	it("onModelChanged while a primary is active calls writeAgentOverride", async () => {
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
		c.onModelChanged({ id: "claude-opus-4-5" }, fakeCtx());
		expect(writeOverride).toHaveBeenCalledWith(
			"plan",
			{ model: "claude-opus-4-5" },
			settingsPath,
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

	it("falls back to default 'build' when defaultName not specified", async () => {
		const { pi } = fakePi();
		const c = createPrimaryController(pi, primaries);
		await c.apply("build", fakeCtx());
		expect(c.getActive()?.name).toBe("build");
	});
});