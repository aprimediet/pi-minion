/**
 * Persistent delegation/task board — a lightweight kanban (à la Hermes' agent board) stored as
 * one markdown card per task under ~/.pi/projects/<id>/tasks/. Each card carries a status
 * (column), a designated agent (assignee), a structured instruction the subagent can execute
 * directly, acceptance criteria, dependencies, and an activity log. Delegation records are written
 * under .../delegations/ so every delegation's full detail is captured.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, parseFrontmatter, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveProject } from "./project.ts";

export type TaskStatus = "backlog" | "todo" | "in_progress" | "blocked" | "review" | "done" | "cancelled";
export const STATUS_ORDER: TaskStatus[] = ["backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled"];
/** Statuses that should be re-delegated when work resumes in a new session. */
const RESUMABLE = new Set<TaskStatus>(["todo", "in_progress", "blocked"]);
const OPEN = new Set<TaskStatus>(["backlog", "todo", "in_progress", "blocked", "review"]);

export interface Task {
	id: string;
	title: string;
	status: TaskStatus;
	agent: string;
	priority: "low" | "normal" | "high";
	labels: string[];
	dependsOn: string[];
	created: string;
	updated: string;
	attempts: number;
	session: string;
	instruction: string;
	acceptance: string[];
	notes: string;
	activity: string[];
}

function nowISO(): string {
	return new Date().toISOString();
}
export function generateTaskId(): string {
	return `t-${Math.random().toString(36).slice(2, 8)}`;
}

// --------------------------------------------------------------- (de)serialize

function csv(v: string[]): string {
	return v.filter(Boolean).join(", ");
}
function splitCsv(v: string | undefined): string[] {
	return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function section(title: string, content: string): string {
	return `## ${title}\n${content.trim()}\n`;
}

function serialize(t: Task): string {
	const fm = [
		"---",
		`id: ${t.id}`,
		`title: ${t.title}`,
		`status: ${t.status}`,
		`agent: ${t.agent}`,
		`priority: ${t.priority}`,
		`labels: ${csv(t.labels)}`,
		`depends_on: ${csv(t.dependsOn)}`,
		`created: ${t.created}`,
		`updated: ${t.updated}`,
		`attempts: ${t.attempts}`,
		`session: ${t.session}`,
		"---",
		"",
	].join("\n");
	const body = [
		section("Instruction", t.instruction || "(none)"),
		section("Acceptance criteria", t.acceptance.length ? t.acceptance.map((a) => `- ${a}`).join("\n") : "(none)"),
		section("Notes", t.notes || "(none)"),
		section("Activity", t.activity.length ? t.activity.map((a) => `- ${a}`).join("\n") : "(none)"),
	].join("\n");
	return `${fm}${body}`;
}

function parseSections(body: string): Record<string, string> {
	const out: Record<string, string> = {};
	const parts = body.split(/^## /m);
	for (const part of parts) {
		const nl = part.indexOf("\n");
		if (nl === -1) continue;
		const heading = part.slice(0, nl).trim().toLowerCase();
		if (!heading) continue;
		out[heading] = part.slice(nl + 1).trim();
	}
	return out;
}

function parse(content: string, fallbackId: string): Task | null {
	try {
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter?.id && !frontmatter?.title) return null;
		const s = parseSections(body);
		const listFrom = (txt: string | undefined): string[] =>
			(txt && txt !== "(none)" ? txt.split("\n") : [])
				.map((l) => l.replace(/^[-*]\s*/, "").trim())
				.filter(Boolean);
		const text = (txt: string | undefined): string => (txt && txt !== "(none)" ? txt : "");
		return {
			id: frontmatter.id || fallbackId,
			title: frontmatter.title || "(untitled)",
			status: (frontmatter.status as TaskStatus) || "todo",
			agent: frontmatter.agent || "",
			priority: (frontmatter.priority as Task["priority"]) || "normal",
			labels: splitCsv(frontmatter.labels),
			dependsOn: splitCsv(frontmatter.depends_on),
			created: frontmatter.created || nowISO(),
			updated: frontmatter.updated || frontmatter.created || nowISO(),
			attempts: Number.parseInt(frontmatter.attempts ?? "0", 10) || 0,
			session: frontmatter.session || "",
			instruction: text(s.instruction),
			acceptance: listFrom(s["acceptance criteria"]),
			notes: text(s.notes),
			activity: listFrom(s.activity),
		};
	} catch {
		return null;
	}
}

// --------------------------------------------------------------- store ops

function taskPath(tasksDir: string, id: string): string {
	return path.join(tasksDir, `${id}.md`);
}

export function listTasks(tasksDir: string): Task[] {
	if (!fs.existsSync(tasksDir)) return [];
	const out: Task[] = [];
	for (const name of fs.readdirSync(tasksDir)) {
		if (!name.endsWith(".md")) continue;
		try {
			const t = parse(fs.readFileSync(path.join(tasksDir, name), "utf-8"), name.replace(/\.md$/, ""));
			if (t) out.push(t);
		} catch {
			/* skip */
		}
	}
	return out;
}

export function getTask(tasksDir: string, id: string): Task | null {
	const file = taskPath(tasksDir, id);
	if (!fs.existsSync(file)) return null;
	try {
		return parse(fs.readFileSync(file, "utf-8"), id);
	} catch {
		return null;
	}
}

export async function writeTask(tasksDir: string, t: Task): Promise<void> {
	const file = taskPath(tasksDir, t.id);
	fs.mkdirSync(tasksDir, { recursive: true });
	await withFileMutationQueue(file, async () => {
		const tmp = `${file}.tmp`;
		await fs.promises.writeFile(tmp, serialize(t), { encoding: "utf-8", mode: 0o600 });
		await fs.promises.rename(tmp, file);
	});
}

export function listResumable(tasksDir: string): Task[] {
	return listTasks(tasksDir).filter((t) => RESUMABLE.has(t.status));
}
export function listOpen(tasksDir: string): Task[] {
	return listTasks(tasksDir).filter((t) => OPEN.has(t.status));
}

// --------------------------------------------------------------- delegation linkage

export function loadTaskInstruction(tasksDir: string, id: string): { instruction: string; agent: string } | null {
	const t = getTask(tasksDir, id);
	if (!t) return null;
	const parts = [t.instruction];
	if (t.acceptance.length) parts.push(`\nAcceptance criteria:\n${t.acceptance.map((a) => `- ${a}`).join("\n")}`);
	if (t.notes) parts.push(`\nNotes:\n${t.notes}`);
	return { instruction: parts.filter(Boolean).join("\n").trim() || t.title, agent: t.agent };
}

export async function markTaskDelegating(tasksDir: string, id: string, agent: string, session: string): Promise<void> {
	const t = getTask(tasksDir, id);
	if (!t) return;
	t.status = "in_progress";
	if (agent) t.agent = agent;
	t.attempts += 1;
	t.updated = nowISO();
	t.activity.push(`${nowISO()} — delegated to ${agent || t.agent || "?"} (attempt ${t.attempts}, session ${session.slice(0, 8)})`);
	await writeTask(tasksDir, t);
}

export async function updateTaskAfterDelegation(tasksDir: string, id: string, summary: string, ok: boolean): Promise<void> {
	const t = getTask(tasksDir, id);
	if (!t) return;
	t.status = ok ? "review" : "blocked";
	t.updated = nowISO();
	const clipped = summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
	t.activity.push(`${nowISO()} — ${ok ? "completed → review" : "failed → blocked"}: ${clipped.replace(/\n/g, " ")}`);
	await writeTask(tasksDir, t);
}

// --------------------------------------------------------------- delegation records

export interface DelegationResult {
	agent: string;
	task: string;
	output: string;
	failed: boolean;
	stopReason?: string;
	model?: string;
}

export async function recordDelegation(
	delegationsDir: string,
	mode: string,
	results: DelegationResult[],
): Promise<void> {
	try {
		fs.mkdirSync(delegationsDir, { recursive: true });
		const ts = nowISO();
		const stamp = ts.replace(/[:.]/g, "-");
		const first = results[0]?.agent ?? "agent";
		const file = path.join(delegationsDir, `${stamp}-${mode}-${first}.md`);
		const blocks = results.map((r, i) => {
			const head = `### [${i + 1}] ${r.agent} — ${r.failed ? `failed${r.stopReason ? ` (${r.stopReason})` : ""}` : "completed"}${r.model ? ` · ${r.model}` : ""}`;
			return [head, "", "**Task**", r.task.trim(), "", "**Result**", (r.output || "(no output)").trim(), ""].join("\n");
		});
		const body = [`# Delegation — ${ts}`, `mode: ${mode}`, "", ...blocks].join("\n");
		await withFileMutationQueue(file, async () => {
			await fs.promises.writeFile(file, body, { encoding: "utf-8", mode: 0o600 });
		});
	} catch {
		/* non-fatal */
	}
}

// --------------------------------------------------------------- rendering

export function renderBoard(tasks: Task[]): string {
	if (tasks.length === 0) return "(board empty)";
	const lines: string[] = [];
	for (const status of STATUS_ORDER) {
		const col = tasks.filter((t) => t.status === status);
		if (col.length === 0) continue;
		lines.push(`${status} (${col.length}):`);
		for (const t of col) lines.push(`  - ${t.id} ${t.agent ? `@${t.agent} ` : ""}${t.title}`);
	}
	return lines.join("\n");
}

/** The session-start "resume" block: lists resumable tasks and instructs delegation. */
export function buildResumePrompt(cwd: string): string | null {
	const tasks = listResumable(resolveProject(cwd).tasksDir);
	if (tasks.length === 0) return null;
	const lines = [
		"# Open tasks — resume these",
		"This project has unfinished tasks on its board (persisted from earlier sessions). Resume each",
		"by delegating it to its designated agent with the `subagent` tool in single mode, passing",
		"`taskId` so the agent loads the full structured instruction. Keep each task's status current",
		"(it moves to `review` on success or `blocked` on failure automatically).",
		"",
		...tasks.map((t) => `- ${t.id} [${t.status}] ${t.agent ? `→ ${t.agent}` : "(no agent assigned)"}: ${t.title}`),
	];
	return lines.join("\n");
}

// --------------------------------------------------------------- the `task` tool

const TaskParams = Type.Object({
	action: StringEnum(["create", "update", "list", "get"] as const, {
		description: "create a task; update fields/status; list the board; get one task's full detail",
	}),
	id: Type.Optional(Type.String({ description: "Task id (required for update/get)" })),
	title: Type.Optional(Type.String({ description: "Short task title (create)" })),
	instruction: Type.Optional(Type.String({ description: "Full, self-contained instruction the subagent will execute" })),
	agent: Type.Optional(Type.String({ description: "Designated agent to execute this task (assignee)" })),
	status: Type.Optional(
		StringEnum(["backlog", "todo", "in_progress", "blocked", "review", "done", "cancelled"] as const, {
			description: "Kanban column / status",
		}),
	),
	priority: Type.Optional(StringEnum(["low", "normal", "high"] as const)),
	acceptance: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria (create/update)" })),
	labels: Type.Optional(Type.Array(Type.String())),
	dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task ids this depends on" })),
	note: Type.Optional(Type.String({ description: "Append a note to the task (update)" })),
	filter: Type.Optional(StringEnum(["open", "all"] as const, { description: "list filter (default open)" })),
});

export function registerTaskTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "task",
		label: "Task board",
		description:
			"Manage the persistent project task board (a kanban for delegation). Create tasks with a designated agent and a structured instruction, update status/fields, and list or read tasks. Tasks survive across sessions; unfinished ones are resumed by delegating to their agent (use subagent with taskId).",
		promptSnippet: "Manage the persistent kanban task board for delegation",
		promptGuidelines: [
			"Use the task tool to record durable, multi-step or to-be-delegated work as kanban cards with a designated agent and a clear instruction + acceptance criteria.",
			"Execute a task by delegating it: call subagent in single mode with that task's taskId; its status updates to review (success) or blocked (failure) automatically.",
		],
		parameters: TaskParams,
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const { tasksDir } = resolveProject(ctx.cwd);
			const action = params.action as string;

			if (action === "list") {
				const all = listTasks(tasksDir);
				const shown = (params.filter ?? "open") === "all" ? all : all.filter((t) => OPEN.has(t.status));
				return { content: [{ type: "text", text: renderBoard(shown) }], details: { count: shown.length } };
			}

			if (action === "get") {
				if (!params.id) return { content: [{ type: "text", text: "get requires id" }], details: { error: true } };
				const t = getTask(tasksDir, params.id as string);
				if (!t) return { content: [{ type: "text", text: `No task ${params.id}` }], details: { error: true } };
				return { content: [{ type: "text", text: serialize(t) }], details: { id: t.id } };
			}

			if (action === "create") {
				if (!params.title) return { content: [{ type: "text", text: "create requires title" }], details: { error: true } };
				const now = nowISO();
				const t: Task = {
					id: generateTaskId(),
					title: params.title as string,
					status: (params.status as TaskStatus) ?? "todo",
					agent: (params.agent as string) ?? "",
					priority: (params.priority as Task["priority"]) ?? "normal",
					labels: (params.labels as string[]) ?? [],
					dependsOn: (params.dependsOn as string[]) ?? [],
					created: now,
					updated: now,
					attempts: 0,
					session: "",
					instruction: (params.instruction as string) ?? "",
					acceptance: (params.acceptance as string[]) ?? [],
					notes: "",
					activity: [`${now} — created`],
				};
				await writeTask(tasksDir, t);
				return { content: [{ type: "text", text: `Created task ${t.id} (${t.status}${t.agent ? `, @${t.agent}` : ""}).` }], details: { id: t.id } };
			}

			if (action === "update") {
				if (!params.id) return { content: [{ type: "text", text: "update requires id" }], details: { error: true } };
				const t = getTask(tasksDir, params.id as string);
				if (!t) return { content: [{ type: "text", text: `No task ${params.id}` }], details: { error: true } };
				const changes: string[] = [];
				if (params.status) { changes.push(`status→${params.status}`); t.status = params.status as TaskStatus; }
				if (params.agent !== undefined) { changes.push(`agent→${params.agent}`); t.agent = params.agent as string; }
				if (params.priority) { changes.push(`priority→${params.priority}`); t.priority = params.priority as Task["priority"]; }
				if (params.title) t.title = params.title as string;
				if (params.instruction !== undefined) t.instruction = params.instruction as string;
				if (params.acceptance) t.acceptance = params.acceptance as string[];
				if (params.labels) t.labels = params.labels as string[];
				if (params.dependsOn) t.dependsOn = params.dependsOn as string[];
				if (params.note) t.notes = t.notes ? `${t.notes}\n${params.note}` : (params.note as string);
				t.updated = nowISO();
				t.activity.push(`${nowISO()} — updated${changes.length ? ` (${changes.join(", ")})` : ""}${params.note ? `: ${params.note}` : ""}`);
				await writeTask(tasksDir, t);
				return { content: [{ type: "text", text: `Updated task ${t.id}.` }], details: { id: t.id } };
			}

			return { content: [{ type: "text", text: "Unknown action" }], details: { error: true } };
		},
		renderResult(result, _opts, theme) {
			const text = result.content[0];
			return new Text(theme.fg("muted", "▣ ") + (text?.type === "text" ? text.text : ""), 0, 0);
		},
	});
}
