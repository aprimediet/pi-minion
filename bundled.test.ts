import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadAgentsFromDir } from "./agents.ts";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(HERE, "agents");
const PROMPTS_DIR = path.join(HERE, "prompts");

const EXPECTED_AGENTS = ["scout", "planner", "reviewer", "worker"] as const;

describe("bundled agents/*.md manifest", () => {
	const bundled = loadAgentsFromDir(AGENTS_DIR, "user");

	it("parses every file via loadAgentsFromDir", () => {
		expect(bundled.length).toBeGreaterThan(0);
	});

	it("agent set is exactly { scout, planner, reviewer, worker }", () => {
		const names = bundled.map((a) => a.name).sort();
		expect(names).toEqual([...EXPECTED_AGENTS].sort());
	});

	it.each(EXPECTED_AGENTS)("%s has non-empty systemPrompt body", (name) => {
		const a = bundled.find((x) => x.name === name);
		expect(a).toBeDefined();
		expect((a!.systemPrompt ?? "").trim().length).toBeGreaterThan(20);
	});
});

describe("bundled prompts/*.md manifest", () => {
	const expected = ["implement.md", "scout-and-plan.md", "implement-and-review.md"];

	it.each(expected)("%s exists with a frontmatter description", (file) => {
		const p = path.join(PROMPTS_DIR, file);
		expect(fs.existsSync(p)).toBe(true);
		const raw = fs.readFileSync(p, "utf-8");
		const { frontmatter } = parseFrontmatter<Record<string, string>>(raw);
		expect(typeof frontmatter.description).toBe("string");
		expect(frontmatter.description.length).toBeGreaterThan(5);
	});

	it("each prompt mentions the subagent tool or chain/tasks flow", () => {
		for (const file of expected) {
			const raw = fs.readFileSync(path.join(PROMPTS_DIR, file), "utf-8");
			expect(raw).toMatch(/subagent|chain/i);
		}
	});

	it("each prompt uses {previous} placeholder or chain syntax", () => {
		for (const file of expected) {
			const raw = fs.readFileSync(path.join(PROMPTS_DIR, file), "utf-8");
			expect(raw).toMatch(/\{previous\}|chain/);
		}
	});
});