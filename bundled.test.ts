import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadAgentsFromDir } from "./agents.ts";
import { loadBundledPrimaries } from "./primaries.ts";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(HERE, "agents");
const PRIMARIES_DIR = path.join(HERE, "primaries");
const PROMPTS_DIR = path.join(HERE, "prompts");
const TEMPLATES_DIR = path.join(HERE, "templates");

const EXPECTED_AGENTS = ["scout", "planner", "reviewer", "worker", "docs-writer"] as const;

describe("bundled agents/*.md manifest", () => {
	const bundled = loadAgentsFromDir(AGENTS_DIR, "user");

	it("parses every file via loadAgentsFromDir", () => {
		expect(bundled.length).toBeGreaterThan(0);
	});

	it("agent set is exactly { scout, planner, reviewer, worker, docs-writer }", () => {
		const names = bundled.map((a) => a.name).sort();
		expect(names).toEqual([...EXPECTED_AGENTS].sort());
	});

	it.each(EXPECTED_AGENTS)("%s has non-empty systemPrompt body", (name) => {
		const a = bundled.find((x) => x.name === name);
		expect(a).toBeDefined();
		expect((a!.systemPrompt ?? "").trim().length).toBeGreaterThan(20);
	});

	it("every bundled agent explicitly declares `type: subagent`", () => {
		for (const a of bundled) {
			expect(a.type).toBe("subagent");
			// Re-read the file to assert the frontmatter is well-formed.
			const p = path.join(AGENTS_DIR, `${a.name}.md`);
			const raw = fs.readFileSync(p, "utf-8");
			const { frontmatter } = parseFrontmatter<Record<string, string>>(raw);
			expect(frontmatter.type).toBe("subagent");
		}
	});
});

// =============================================================================
// v2.1 — Bundled primaries
// =============================================================================

describe("bundled primaries/*.md manifest (v2.1)", () => {
	it("primaries/ directory exists", () => {
		expect(fs.existsSync(PRIMARIES_DIR)).toBe(true);
	});

	const primaries = loadBundledPrimaries(PRIMARIES_DIR);

	it("parses both bundled primaries", () => {
		const names = primaries.map((p) => p.name).sort();
		expect(names).toEqual(["build", "plan"]);
	});

	it("every parsed primary has `source: 'bundled'`", () => {
		for (const p of primaries) expect(p.source).toBe("bundled");
	});

	it("plan declares read-only tools: [read, grep, find, ls]", () => {
		const plan = primaries.find((p) => p.name === "plan");
		expect(plan?.tools).toEqual(["read", "grep", "find", "ls"]);
	});

	it("build has no `tools` frontmatter (full default set)", () => {
		const build = primaries.find((p) => p.name === "build");
		expect(build?.tools).toBeUndefined();
	});

	it("each bundled primary declares `type: primary` in frontmatter", () => {
		for (const name of ["build", "plan"]) {
			const p = path.join(PRIMARIES_DIR, `${name}.md`);
			const raw = fs.readFileSync(p, "utf-8");
			const { frontmatter } = parseFrontmatter<Record<string, string>>(raw);
			expect(frontmatter.type).toBe("primary");
			expect(frontmatter.name).toBe(name);
			expect(typeof frontmatter.description).toBe("string");
		}
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

// =============================================================================
// v2.2.0 — Interactive /init prompt + bundled templates
// =============================================================================

describe("bundled init prompt (interactive workflow)", () => {
	const initPath = path.join(PROMPTS_DIR, "init.md");

	it("prompts/init.md exists with a frontmatter description", () => {
		expect(fs.existsSync(initPath)).toBe(true);
		const raw = fs.readFileSync(initPath, "utf-8");
		const { frontmatter } = parseFrontmatter<Record<string, string>>(raw);
		expect(typeof frontmatter.description).toBe("string");
		expect(frontmatter.description.length).toBeGreaterThan(5);
	});

	it("uses one-question-per-turn interactive pattern", () => {
		const raw = fs.readFileSync(initPath, "utf-8");
		expect(raw).toMatch(/one question per turn|one at a time/i);
	});

	it("prefers multiple choice / MCQ format", () => {
		const raw = fs.readFileSync(initPath, "utf-8");
		expect(raw).toMatch(/multiple choice|MCQ/i);
	});

	it("declares a HARD-GATE before file writes", () => {
		const raw = fs.readFileSync(initPath, "utf-8");
		expect(raw).toMatch(/HARD-GATE/);
	});

	it("declares 4 approval gates", () => {
		const raw = fs.readFileSync(initPath, "utf-8");
		expect(raw).toMatch(/Gate 1/);
		expect(raw).toMatch(/Gate 2/);
		expect(raw).toMatch(/Gate 3/);
		expect(raw).toMatch(/Gate 4/);
	});

	it("checks the active primary / build mode before writing", () => {
		const raw = fs.readFileSync(initPath, "utf-8");
		expect(raw).toMatch(/primary|build mode|write access/i);
	});

	it("references both template files (AGENT + PRD)", () => {
		const raw = fs.readFileSync(initPath, "utf-8");
		expect(raw).toMatch(/AGENT\.template\.md/);
		expect(raw).toMatch(/PRD\.template\.md/);
	});

	it("covers the 8 interview topics (project type, stack, vision, users, goals, arch, out-of-scope, roadmap)", () => {
		const raw = fs.readFileSync(initPath, "utf-8");
		expect(raw).toMatch(/Q1/);
		expect(raw).toMatch(/Q2/);
		expect(raw).toMatch(/Q3/);
		expect(raw).toMatch(/Q4/);
		expect(raw).toMatch(/Q5/);
		expect(raw).toMatch(/Q6/);
		expect(raw).toMatch(/Q7/);
		expect(raw).toMatch(/Q8/);
	});

	it("delegates file writing to docs-writer subagent", () => {
		const raw = fs.readFileSync(initPath, "utf-8");
		expect(raw).toMatch(/docs-writer/);
		expect(raw).toMatch(/subagent\s*\(\s*\{[^}]*agent:\s*["']docs-writer["']/s);
	});

	it("explains how to create docs-writer at .pi/agents/ if missing", () => {
		const raw = fs.readFileSync(initPath, "utf-8");
		expect(raw).toMatch(/\.pi\/agents\/docs-writer\.md/);
	});

	it("includes the docs-writer agent definition for runtime creation", () => {
		const raw = fs.readFileSync(initPath, "utf-8");
		expect(raw).toMatch(/name:\s*docs-writer/);
		expect(raw).toMatch(/type:\s*subagent/);
	});
});

describe("bundled templates/init/*.md manifest", () => {
	const agentTpl = path.join(TEMPLATES_DIR, "init", "AGENT.template.md");
	const prdTpl = path.join(TEMPLATES_DIR, "init", "PRD.template.md");

	it("templates/init/ directory exists", () => {
		expect(fs.existsSync(path.join(TEMPLATES_DIR, "init"))).toBe(true);
	});

	it("AGENT.template.md exists", () => {
		expect(fs.existsSync(agentTpl)).toBe(true);
	});

	it("PRD.template.md exists", () => {
		expect(fs.existsSync(prdTpl)).toBe(true);
	});

	it("AGENT.template.md contains {{placeholder}} substitution patterns", () => {
		const raw = fs.readFileSync(agentTpl, "utf-8");
		// Expect at least 3 distinct placeholders
		const placeholders = raw.match(/\{\{[a-z_0-9]+\}\}/gi) ?? [];
		expect(placeholders.length).toBeGreaterThanOrEqual(3);
	});

	it("PRD.template.md contains {{placeholder}} substitution patterns", () => {
		const raw = fs.readFileSync(prdTpl, "utf-8");
		const placeholders = raw.match(/\{\{[a-z_0-9]+\}\}/gi) ?? [];
		expect(placeholders.length).toBeGreaterThanOrEqual(3);
	});

	it("AGENT.template.md documents the {{placeholder}} -> question map (template reference section)", () => {
		const raw = fs.readFileSync(agentTpl, "utf-8");
		expect(raw).toMatch(/Template Reference/i);
	});

	it("PRD.template.md documents the {{placeholder}} -> question map (template reference section)", () => {
		const raw = fs.readFileSync(prdTpl, "utf-8");
		expect(raw).toMatch(/Template Reference/i);
	});
});