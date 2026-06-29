/**
 * @aprimediet/minion
 *
 * Claude-Code-style delegation for the pi coding agent:
 *   - subagent    (Task: single / parallel / chain, isolated pi subprocesses)
 *   - a bundled library of 12 specialized agents, with per-agent model config
 *
 * Agents are bundled inside the extension and loaded directly (no install step).
 * The default model map (minion.json) is copied into ~/.pi/agent/ on first run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildDelegationSystemPrompt, bundledAgentsDir, bundledModelsFile, setDefaultAgentModel } from "./agents.ts";
import { ensureProject, resolveProject } from "./project.ts";
import { registerSubagentTool } from "./subagent.ts";
import { buildResumePrompt, getTask, listTasks, registerTaskTool, renderBoard } from "./tasks.ts";

function copyAgentFiles(srcDir: string, destDir: string): { copied: number; skipped: number } {
	fs.mkdirSync(destDir, { recursive: true });
	let copied = 0;
	let skipped = 0;
	for (const name of fs.readdirSync(srcDir)) {
		if (!name.endsWith(".md")) continue;
		const dest = path.join(destDir, name);
		if (fs.existsSync(dest)) {
			skipped++;
			continue;
		}
		fs.copyFileSync(path.join(srcDir, name), dest);
		copied++;
	}
	return { copied, skipped };
}

export default function minionExtension(pi: ExtensionAPI): void {
	registerSubagentTool(pi);
	registerTaskTool(pi);

	pi.registerFlag("default-agent-model", {
		description: "Fallback model for subagents with no configured/frontmatter model",
		type: "string",
	});

	// Seed the per-agent model config into ~/.pi/agent/minion.json on first run (idempotent), and
	// create the project workspace (~/.pi/projects/<id>/ + the cwd marker), keeping cwd clean.
	pi.on("session_start", async (_e, ctx: ExtensionContext) => {
		const flag = pi.getFlag("default-agent-model");
		if (typeof flag === "string" && flag) setDefaultAgentModel(flag);

		try {
			const target = path.join(getAgentDir(), "minion.json");
			if (!fs.existsSync(target)) {
				const src = bundledModelsFile();
				if (fs.existsSync(src)) {
					fs.mkdirSync(path.dirname(target), { recursive: true });
					fs.copyFileSync(src, target);
				}
			}
		} catch {
			/* non-fatal */
		}

		try {
			await ensureProject(ctx.cwd);
		} catch {
			/* non-fatal */
		}
	});

	// Make pi aware, every turn, that it can delegate and which subagents exist — by appending a
	// "Subagent delegation" section (with the live agent list) to the system prompt. Rebuilt per
	// turn from base options, so it stays in sync with bundled/user/project agent changes.
	// Also surface unfinished board tasks each turn so the agent resumes them by delegating to the
	// designated agent (subagent + taskId). This is the "check status → delegate" behavior.
	pi.on("before_agent_start", async (event, ctx) => {
		const parts = [buildDelegationSystemPrompt(ctx.cwd), buildResumePrompt(ctx.cwd)].filter(Boolean);
		if (parts.length === 0) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n")}` };
	});

	// Optional convenience: export the bundled agents (and model config) for editing / native use.
	pi.registerCommand("minion", {
		description: "minion: 'install-agents [--project]' exports the bundled agents for editing",
		handler: async (args, ctx: ExtensionContext) => {
			const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0];
			if (sub !== "install-agents") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /minion install-agents [--project]", "info");
				return;
			}
			const toProject = tokens.includes("--project");
			const destAgents = toProject
				? path.join(ctx.cwd, CONFIG_DIR_NAME, "agents")
				: path.join(getAgentDir(), "agents");
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Export bundled agents?",
					`Copy the 12 bundled agents to:\n${destAgents}\n(existing files are kept, not overwritten)`,
				);
				if (!ok) return;
			}
			try {
				const { copied, skipped } = copyAgentFiles(bundledAgentsDir(), destAgents);
				// Also drop the model config in the matching scope if absent.
				const modelsTarget = toProject
					? path.join(ctx.cwd, CONFIG_DIR_NAME, "minion.json")
					: path.join(getAgentDir(), "minion.json");
				if (!fs.existsSync(modelsTarget) && fs.existsSync(bundledModelsFile())) {
					fs.mkdirSync(path.dirname(modelsTarget), { recursive: true });
					fs.copyFileSync(bundledModelsFile(), modelsTarget);
				}
				if (ctx.hasUI) ctx.ui.notify(`Exported ${copied} agent(s), skipped ${skipped} existing → ${destAgents}`, "info");
			} catch (err) {
				if (ctx.hasUI) ctx.ui.notify(`Export failed: ${(err as Error).message}`, "error");
			}
		},
	});

	// View the persistent kanban board for this project.
	pi.registerCommand("tasks", {
		description: "tasks: show the project kanban board ('/tasks all' includes done/cancelled; '/tasks <id>' shows one)",
		handler: async (args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const project = resolveProject(ctx.cwd);
			if (tokens[0] && tokens[0] !== "all") {
				const t = getTask(project.tasksDir, tokens[0]);
				ctx.ui.notify(
					t
						? `${t.id} [${t.status}]${t.agent ? ` @${t.agent}` : ""}\n${t.title}\n\nInstruction:\n${t.instruction || "(none)"}`
						: `No task ${tokens[0]}.`,
					t ? "info" : "error",
				);
				return;
			}
			const all = listTasks(project.tasksDir);
			const shown = tokens[0] === "all" ? all : all.filter((t) => t.status !== "done" && t.status !== "cancelled");
			ctx.ui.notify(`Board (${project.id}):\n${renderBoard(shown)}`, "info");
		},
	});
}
