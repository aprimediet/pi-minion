/**
 * Agent discovery + frontmatter parsing.
 *
 * Loads `*.md` files from the extension's bundled `agents/` directory (always as base),
 * `<agentDir>/agents` (user), and the nearest `.pi/agents` walking up from cwd (project).
 * Bundled agents are always included as the base layer. User and project agents
 * override bundled agents by name. In `both` scope, project overrides user.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project" | "bundled";
	filePath: string;
	/** v2.1: distinguishes primaries (switchable main persona) from subagents.
	 *  Optional in frontmatter; defaults to `"subagent"` for v2.0 back-compat. */
	type?: "primary" | "subagent";
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export type AgentSource = "user" | "project" | "bundled";

/** Parse a single directory of agent `*.md` files. Skips files lacking `name` or `description`. */
export function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
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

		// v2.1: normalize the `type` field — defaults to "subagent" and falls
		// back fail-soft on any unrecognized value.
		const rawType = (frontmatter.type ?? "").trim().toLowerCase();
		const type: "primary" | "subagent" = rawType === "primary" ? "primary" : "subagent";

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
			type,
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

/** Walk up from cwd until a `.pi/agents` directory is found, or return null. */
export function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export interface DiscoverAgentsOptions {
	/** Override the user-agents directory (default: `<agentDir>/agents`). */
	userAgentsDir?: string;
	/** Override the bundled-agents directory (extension's `agents/` dir). When provided,
	 * bundled agents are loaded as the base layer — user/project agents override
	 * bundled agents by name. */
	bundledAgentsDir?: string;
}

/**
 * Discover agents for the given cwd + scope.
 *
 * Precedence (low→high):
 *   1. Bundled agents (from `bundledAgentsDir`) — always loaded as base
 *   2. User agents — override bundled by name
 *   3. Project agents — override user by name (scope=both/project)
 */
export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	options: DiscoverAgentsOptions = {},
): AgentDiscoveryResult {
	const userDir = options.userAgentsDir ?? path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// Base layer: bundled agents (always loaded when dir is provided)
	const bundledAgents = options.bundledAgentsDir
		? loadAgentsFromDir(options.bundledAgentsDir, "bundled")
		: [];

	// Override layers: user and/or project agents
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents =
		scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	// 1. Bundled agents (base)
	for (const agent of bundledAgents) agentMap.set(agent.name, agent);

	// 2. User agents (override bundled by name)
	if (scope !== "project") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	}

	// 3. Project agents (override user/bundled by name)
	if (scope !== "user") {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/** Render an agent roster as `name (source): description; …` with a `+N more` remainder. */
export function formatAgentList(
	agents: AgentConfig[],
	maxItems: number,
): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}