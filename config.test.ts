import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	readAgentOverrides,
	resolveAgentRuntime,
	parseCsvTools,
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