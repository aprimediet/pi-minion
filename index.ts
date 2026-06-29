/**
 * Extension entry point — wires `subagent` tool + `/minion` command.
 *
 * Exports `buildExtension(pi, deps)` so tests can inject `discoverAgents`,
 * `runAgentFn`, and `readOverrides`. `defaultExtension` is the real wiring
 * (calls into `./agents.ts`, `./runner.ts`, `./config.ts`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentParams, type AgentOverride, type SubagentDetails } from "./schema.ts";
import { discoverAgents as realDiscoverAgents, formatAgentList, type AgentConfig, type AgentDiscoveryResult } from "./agents.ts";
import { runSingle as realRunSingle, runParallel as realRunParallel, runChain as realRunChain, decideMode, type RunAgentFn } from "./modes.ts";
import { readAgentOverrides as realReadOverrides, resolveAgentRuntime } from "./config.ts";
import { runSingleAgent as realRunSingleAgent } from "./runner.ts";
import { renderCall, renderResult } from "./render.ts";

export interface BuildExtensionDeps {
	discoverAgents: (cwd: string, scope: "user" | "project" | "both") => AgentDiscoveryResult;
	runAgentFn: RunAgentFn;
	readOverrides: (settingsPath?: string) => Record<string, AgentOverride>;
}

/** Apply settings overrides to every agent. Returns a new array (agents are immutable inputs). */
function applyOverrides(
	agents: AgentConfig[],
	overrides: Record<string, AgentOverride>,
): AgentConfig[] {
	return agents.map((a) => {
		const resolved = resolveAgentRuntime(a, overrides, a.name);
		const next: AgentConfig = { ...a };
		if (resolved.model !== undefined) next.model = resolved.model;
		if (resolved.tools !== undefined) next.tools = resolved.tools;
		return next;
	});
}

const HERE =
	typeof import.meta.dirname === "string" ? import.meta.dirname : path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_AGENTS_DIR = path.join(HERE, "agents");

/** Copy bundled `agents/*.md` into `<dest>` unless already present. Returns names copied. */
export function installBundledAgents(dest: string): { copied: string[]; skipped: string[]; errors: string[] } {
	const copied: string[] = [];
	const skipped: string[] = [];
	const errors: string[] = [];
	if (!fs.existsSync(BUNDLED_AGENTS_DIR)) {
		errors.push(`bundled agents dir missing: ${BUNDLED_AGENTS_DIR}`);
		return { copied, skipped, errors };
	}
	fs.mkdirSync(dest, { recursive: true });
	let entries: string[];
	try {
		entries = fs.readdirSync(BUNDLED_AGENTS_DIR);
	} catch (e) {
		errors.push(`cannot read bundled agents: ${(e as Error).message}`);
		return { copied, skipped, errors };
	}
	for (const name of entries) {
		if (!name.endsWith(".md")) continue;
		const target = path.join(dest, name);
		if (fs.existsSync(target)) {
			skipped.push(name);
			continue;
		}
		try {
			fs.copyFileSync(path.join(BUNDLED_AGENTS_DIR, name), target);
			copied.push(name);
		} catch (e) {
			errors.push(`${name}: ${(e as Error).message}`);
		}
	}
	return { copied, skipped, errors };
}

/**
 * Wire up the subagent tool + /minion command and register them with `pi`.
 *
 * Pure(ish) with respect to the injected deps — `discoverAgents`/`runAgentFn`/
 * `readOverrides` are passed in so unit tests can substitute fakes.
 */
export function buildExtension(pi: ExtensionAPI, deps: BuildExtensionDeps): void {
	const { discoverAgents, runAgentFn, readOverrides } = deps;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
			'Call { list: true } first to see available agents before delegating.',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope = (params.agentScope ?? "user") as "user" | "project" | "both";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const overrides = readOverrides();
			const agents = applyOverrides(discovery.agents, overrides);
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const mode = decideMode({
				agent: params.agent,
				task: params.task,
				tasks: params.tasks,
				chain: params.chain,
				list: params.list,
			});

			const makeDetails =
				(m: "single" | "parallel" | "chain") =>
				(results: ReturnType<typeof toResult>[]): SubagentDetails => ({
					mode: m,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (mode === null) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` },
					],
					details: makeDetails("single")([]),
				};
			}

			if (mode === "list") {
				const list = formatAgentList(agents, 50);
				const tail = list.remaining > 0 ? ` (+${list.remaining} more)` : "";
				return {
					content: [{ type: "text", text: `${list.text}${tail}` }],
					details: makeDetails("single")([]),
				};
			}

			// Project-agent confirmation gate
			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI
			) {
				const requested = new Set<string>();
				if (params.chain) for (const s of params.chain) requested.add(s.agent);
				if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
				if (params.agent) requested.add(params.agent);

				const projectAgents = Array.from(requested)
					.map((n) => agents.find((a) => a.name === n))
					.filter((a): a is AgentConfig => !!a && a.source === "project");

				if (projectAgents.length > 0) {
					const names = projectAgents.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(mode === "chain" ? "chain" : mode === "parallel" ? "parallel" : "single")([]),
						};
					}
				}
			}

			if (mode === "chain" && params.chain && params.chain.length > 0) {
				return realRunChain({
					items: params.chain,
					defaultCwd: ctx.cwd,
					signal,
					onUpdate,
					makeDetails: makeDetails("chain"),
					runAgent: runAgentFn,
					agents,
				});
			}

			if (mode === "parallel" && params.tasks && params.tasks.length > 0) {
				return realRunParallel({
					items: params.tasks,
					defaultCwd: ctx.cwd,
					signal,
					onUpdate,
					makeDetails: makeDetails("parallel"),
					runAgent: runAgentFn,
				});
			}

			// mode === "single"
			return realRunSingle({
				agents,
				agentName: params.agent!,
				task: params.task!,
				cwd: params.cwd,
				defaultCwd: ctx.cwd,
				step: undefined,
				signal,
				onUpdate,
				makeDetails: makeDetails("single"),
				runAgent: runAgentFn,
			});
		},

		renderCall,
		renderResult,
	});

	pi.registerCommand("minion", {
		description: "minion utilities (list / install-agents)",
		async handler(args, ctx) {
			const trimmed = (args ?? "").trim();
			if (trimmed === "list") {
				const discovery = discoverAgents(ctx.cwd, "both");
				const list = formatAgentList(discovery.agents, 50);
				const tail = list.remaining > 0 ? ` (+${list.remaining} more)` : "";
				ctx.ui.notify(`${list.text}${tail}`);
				return;
			}
			if (trimmed.startsWith("install-agents")) {
				const project = trimmed.includes("--project");
				const dest = project
					? path.join(ctx.cwd, CONFIG_DIR_NAME, "agents")
					: path.join(getAgentDir(), "agents");
				const result = installBundledAgents(dest);
				const summary = [
					`copied ${result.copied.length}`,
					`skipped ${result.skipped.length}`,
					...(result.errors.length > 0 ? [`errors: ${result.errors.join("; ")}`] : []),
				].join(", ");
				ctx.ui.notify(`Installed bundled agents into ${dest}: ${summary}`);
				return;
			}
			ctx.ui.notify(
				"Usage: /minion list | /minion install-agents [--project]",
			);
		},
	});
}

/** Real wiring — used as the default export and for production. */
function defaultExtension(pi: ExtensionAPI): void {
	buildExtension(pi, {
		discoverAgents: realDiscoverAgents,
		runAgentFn: (req) =>
			realRunSingleAgent({
				agents: req.agents,
				agentName: req.agentName,
				task: req.task,
				cwd: req.cwd,
				defaultCwd: req.defaultCwd,
				step: req.step,
				signal: req.signal,
				onUpdate: req.onUpdate,
				makeDetails: req.makeDetails,
			}),
		readOverrides: realReadOverrides,
	});
}

// Helper to type-erase the SingleResult shape (avoids circular type noise).
function toResult<T>(x: T): T {
	return x;
}

export default defaultExtension;