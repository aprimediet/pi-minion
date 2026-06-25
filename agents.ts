/**
 * Agent discovery (bundled + user + project) and per-agent model resolution.
 *
 * Extends pi's bundled subagent example with:
 *  - a third "bundled" source (the agents shipped inside this extension),
 *  - per-agent model config read from minion.json (project then global).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "bundled" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

const HERE =
	typeof import.meta.dirname === "string" ? import.meta.dirname : path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_AGENTS_DIR = path.join(HERE, "agents");
const BUNDLED_MODELS_FILE = path.join(HERE, "minion.json");

export function bundledAgentsDir(): string {
	return BUNDLED_AGENTS_DIR;
}
export function bundledModelsFile(): string {
	return BUNDLED_MODELS_FILE;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let dir = cwd;
	for (;;) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** bundled (always) → user (unless scope==="project") → project (scope project|both). Later wins. */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const bundled = loadAgentsFromDir(BUNDLED_AGENTS_DIR, "bundled");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const map = new Map<string, AgentConfig>();
	for (const a of bundled) map.set(a.name, a);
	for (const a of userAgents) map.set(a.name, a);
	for (const a of projectAgents) map.set(a.name, a);

	return { agents: Array.from(map.values()), projectAgentsDir };
}

/**
 * Build the "Subagent delegation" section appended to pi's system prompt each turn, so the main
 * agent always knows it can delegate and which agents exist. Lists the agents usable by default
 * (bundled + user); notes project-local agents (which require agentScope:"both"). Returns null
 * when no agents are discovered.
 */
export function buildDelegationSystemPrompt(cwd: string): string | null {
	let discovery: AgentDiscoveryResult;
	try {
		discovery = discoverAgents(cwd, "both");
	} catch {
		return null;
	}
	if (discovery.agents.length === 0) return null;

	const usable = discovery.agents.filter((a) => a.source !== "project");
	const project = discovery.agents.filter((a) => a.source === "project");

	const fmt = (a: AgentConfig): string => {
		const desc = a.description.replace(/\s+/g, " ").trim();
		const short = desc.length > 140 ? `${desc.slice(0, 140)}…` : desc;
		return `- ${a.name} — ${short}`;
	};

	const lines = [
		"# Subagent delegation",
		"",
		"You can delegate work to specialized subagents with the `subagent` tool. Each subagent runs in its own isolated context window, so delegating keeps your context focused. Delegate well-scoped work that benefits from focused expertise or parallelism — broad code exploration, planning, code review, debugging, writing tests or docs — and decide for yourself when it is worthwhile (do trivial steps directly).",
		"",
		"Modes: single (one `agent` + `task`), parallel (a `tasks` array of independent jobs run at once), and chain (a `chain` array run sequentially, referencing the previous step's output with the {previous} placeholder).",
		"",
		"Available agents (call by exact name):",
		...usable.map(fmt),
	];
	if (project.length > 0) {
		lines.push("");
		lines.push(
			`Project-local agents (trusted repos only; pass agentScope:"both" to use): ${project.map((a) => a.name).join(", ")}.`,
		);
	}
	return lines.join("\n");
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining: agents.length - listed.length,
	};
}

// ------------------------------------------------------- per-agent model config

let flagDefaultModel: string | undefined;
export function setDefaultAgentModel(model: string | undefined): void {
	flagDefaultModel = model && model.trim() ? model.trim() : undefined;
}

function findNearestProjectModelsFile(cwd: string): string | null {
	let dir = cwd;
	for (;;) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, "minion.json");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function readModels(file: string | null): Record<string, string> | undefined {
	if (!file) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { models?: Record<string, string> };
		return parsed?.models;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the model for an agent (first hit wins):
 *   project models[name] → global models[name] → project models["*"] → global models["*"]
 *   → frontmatter model → MINION_DEFAULT_MODEL / --default-agent-model → undefined.
 * Re-reads the JSON each call so edits apply without a reload.
 */
export function resolveAgentModel(agent: AgentConfig, cwd: string): string | undefined {
	const proj = readModels(findNearestProjectModelsFile(cwd));
	const glob = readModels(path.join(getAgentDir(), "minion.json"));
	return (
		proj?.[agent.name] ??
		glob?.[agent.name] ??
		proj?.["*"] ??
		glob?.["*"] ??
		agent.model ??
		process.env.MINION_DEFAULT_MODEL ??
		flagDefaultModel ??
		undefined
	);
}
