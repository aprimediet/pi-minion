import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	readAgentOverrides,
	resolveAgentRuntime,
	parseCsvTools,
	writeAgentOverride,
} from "./config.ts";

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minion-config-test-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("readAgentOverrides", () => {
	it("returns {} when file is missing", () => {
		expect(readAgentOverrides(path.join(tmp, "missing.json"))).toEqual({});
	});

	it("returns {} when file is malformed JSON", () => {
		const p = path.join(tmp, "settings.json");
		fs.writeFileSync(p, "{ not json");
		expect(readAgentOverrides(p)).toEqual({});
	});

	it("returns {} when settings has no 'agents' key", () => {
		const p = path.join(tmp, "settings.json");
		fs.writeFileSync(p, JSON.stringify({ defaultProvider: "opencode" }));
		expect(readAgentOverrides(p)).toEqual({});
	});

	it("returns the agents map when present", () => {
		const p = path.join(tmp, "settings.json");
		fs.writeFileSync(
			p,
			JSON.stringify({
				agents: {
					scout: { model: "claude-haiku-4-5" },
					worker: { tools: "read,write,bash" },
				},
			}),
		);
		expect(readAgentOverrides(p)).toEqual({
			scout: { model: "claude-haiku-4-5" },
			worker: { tools: "read,write,bash" },
		});
	});

	it("returns {} when 'agents' is not an object", () => {
		const p = path.join(tmp, "settings.json");
		fs.writeFileSync(p, JSON.stringify({ agents: "nope" }));
		expect(readAgentOverrides(p)).toEqual({});
	});
});

describe("parseCsvTools", () => {
	it("returns undefined when input is undefined", () => {
		expect(parseCsvTools(undefined)).toBeUndefined();
	});

	it("returns undefined when input is empty/whitespace", () => {
		expect(parseCsvTools("")).toBeUndefined();
		expect(parseCsvTools("   ")).toBeUndefined();
		expect(parseCsvTools(",,")).toBeUndefined();
	});

	it("trims and drops empties", () => {
		expect(parseCsvTools("read, write , bash")).toEqual(["read", "write", "bash"]);
		expect(parseCsvTools(" read,,write ,")).toEqual(["read", "write"]);
	});
});

describe("resolveAgentRuntime", () => {
	const baseAgent = { name: "scout", description: "d" };

	it("returns undefineds when neither overrides nor frontmatter set the field", () => {
		expect(resolveAgentRuntime({ ...baseAgent }, {})).toEqual({});
	});

	it("settings wins over frontmatter for model", () => {
		expect(
			resolveAgentRuntime(
				{ ...baseAgent, model: "frontmatter-model" },
				{ scout: { model: "settings-model" } },
			),
		).toEqual({ model: "settings-model" });
	});

	it("falls back to frontmatter when settings absent", () => {
		expect(
			resolveAgentRuntime(
				{ ...baseAgent, model: "frontmatter-model" },
				{ other: { model: "other-model" } },
			),
		).toEqual({ model: "frontmatter-model" });
	});

	it("settings.tools wins; falls back to frontmatter.tools via CSV parse", () => {
		expect(
			resolveAgentRuntime(
				{ ...baseAgent, tools: ["read", "grep"] },
				{ scout: { tools: "read,write,bash" } },
			),
		).toEqual({ model: undefined, tools: ["read", "write", "bash"] });
	});

	it("falls back to frontmatter.tools when settings has no tools", () => {
		expect(
			resolveAgentRuntime(
				{ ...baseAgent, tools: ["read", "grep"] },
				{ scout: { model: "m" } },
			),
		).toEqual({ model: "m", tools: ["read", "grep"] });
	});

	it("omits the field entirely when neither has a value", () => {
		const out = resolveAgentRuntime({ ...baseAgent }, {});
		expect("model" in out).toBe(false);
		expect("tools" in out).toBe(false);
	});
});

describe("writeAgentOverride (v2.1)", () => {
	it("creates the file + 'agents' key when missing", async () => {
		const p = path.join(tmp, "settings.json");
		expect(fs.existsSync(p)).toBe(false);
		const ok = await writeAgentOverride("plan", { model: "m1" }, p);
		expect(ok).toBe(true);
		expect(fs.existsSync(p)).toBe(true);
		expect(readAgentOverrides(p)).toEqual({ plan: { model: "m1" } });
	});

	it("merges patch into an existing agents[name] entry, preserving other agents", async () => {
		const p = path.join(tmp, "settings.json");
		fs.writeFileSync(
			p,
			JSON.stringify({
				defaultProvider: "opencode",
				agents: {
					scout: { model: "haiku" },
					plan: { model: "old", tools: "read" },
				},
			}),
		);
		const ok = await writeAgentOverride("plan", { model: "new-model" }, p);
		expect(ok).toBe(true);
		const after = JSON.parse(fs.readFileSync(p, "utf-8"));
		expect(after.defaultProvider).toBe("opencode"); // unrelated top-level key preserved
		expect(after.agents.scout).toEqual({ model: "haiku" });
		// model replaced, tools preserved from prior override
		expect(after.agents.plan).toEqual({ model: "new-model", tools: "read" });
	});

	it("round-trips: writeAgentOverride -> readAgentOverrides", async () => {
		const p = path.join(tmp, "settings.json");
		await writeAgentOverride("plan", { model: "m" }, p);
		expect(readAgentOverrides(p)).toEqual({ plan: { model: "m" } });
	});

	it("supports patching tools field", async () => {
		const p = path.join(tmp, "settings.json");
		await writeAgentOverride("plan", { tools: "read,write,bash" }, p);
		const o = readAgentOverrides(p);
		expect(o.plan).toEqual({ tools: "read,write,bash" });
	});

	it("creates a new agent entry when name doesn't exist yet", async () => {
		const p = path.join(tmp, "settings.json");
		fs.writeFileSync(p, JSON.stringify({ agents: { scout: { model: "haiku" } } }));
		await writeAgentOverride("newone", { model: "x" }, p);
		const after = JSON.parse(fs.readFileSync(p, "utf-8"));
		expect(after.agents.scout).toEqual({ model: "haiku" });
		expect(after.agents.newone).toEqual({ model: "x" });
	});

	it("returns false and does not throw when path is unwritable", async () => {
		// Construct a path that cannot be written: a "directory" component is
		// actually a regular file, so mkdirSync(..., {recursive:true}) fails.
		const blocker = path.join(tmp, "blocker");
		fs.writeFileSync(blocker, "i am a file, not a dir");
		const bad = path.join(blocker, "subdir", "settings.json");
		const ok = await writeAgentOverride("plan", { model: "x" }, bad);
		expect(ok).toBe(false);
		expect(fs.existsSync(bad)).toBe(false);
		// blocker file untouched
		expect(fs.readFileSync(blocker, "utf-8")).toBe("i am a file, not a dir");
	});

	it("does not destroy malformed existing JSON; returns false", async () => {
		const p = path.join(tmp, "settings.json");
		fs.writeFileSync(p, "{ not json");
		const ok = await writeAgentOverride("plan", { model: "x" }, p);
		expect(ok).toBe(false);
		// File content unchanged (still malformed)
		expect(fs.readFileSync(p, "utf-8")).toBe("{ not json");
	});

	it("writes through the public default-path overload (smoke)", async () => {
		// Pass a controlled path explicitly; this confirms the async path
		// returns a Promise<boolean>. The "default" path is exercised in
		// end-to-end usage and covered indirectly by the read-back tests.
		const p = path.join(tmp, "settings.json");
		const ok = await writeAgentOverride("plan", { model: "x" }, p);
		expect(ok).toBe(true);
	});

	it("does not leave orphan .tmp files when write fails early (EISDIR)", async () => {
		// Defense-in-depth test for the orphan-tmp cleanup. The realistic
		// rename-failure branch (`writeFileSync` succeeded but `renameSync`
		// threw) is hard to trigger portably without root-only operations,
		// so we use the EISDIR scenario on target — it short-circuits at
		// `readFileSync`, but the invariant we care about holds regardless:
		// no `.tmp` file should ever be left on disk after a failed call.
		const p = path.join(tmp, "settings.json");
		fs.mkdirSync(p); // target is a directory → EISDIR on readFileSync
		const tmpFile = `${p}.tmp`;
		const ok = await writeAgentOverride("plan", { model: "x" }, p);
		expect(ok).toBe(false);
		// No orphan tmp (neither directly in tmpdir nor inside the dir-as-target).
		expect(fs.existsSync(tmpFile)).toBe(false);
		expect(fs.readdirSync(p)).toEqual([]);
	});

	it("does not crash when tmp path is obstructed by a pre-existing directory", async () => {
		// Scenario: a previous crashed write left `<target>.tmp` as a directory
		// (not a file). The new write should fail-soft, NOT throw.
		const p = path.join(tmp, "settings.json");
		const tmpDir = `${p}.tmp`;
		fs.mkdirSync(tmpDir);
		const ok = await writeAgentOverride("plan", { model: "x" }, p);
		expect(ok).toBe(false);
		// The obstructive dir is still there (we don't destroy user data).
		expect(fs.existsSync(tmpDir)).toBe(true);
	});

	it("writeAgentOverride return type is Promise<boolean> (compile-time + runtime)", async () => {
		const p = path.join(tmp, "settings.json");
		const result = writeAgentOverride("plan", { model: "x" }, p);
		// Compile-time: must be a Promise; runtime: resolves to true.
		expect(result).toBeInstanceOf(Promise);
		expect(await result).toBe(true);
	});
});