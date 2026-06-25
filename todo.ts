/**
 * `todo_write` — Claude Code's TodoWrite for pi.
 *
 * The model calls it with the full, updated task list (it replaces prior state).
 * State lives in the tool result's `details` (branch-correct on session fork) and
 * is reconstructed by scanning the session branch on session_start / session_tree.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveProject } from "./project.ts";

type Status = "pending" | "in_progress" | "completed";
interface Todo {
	content: string;
	activeForm: string;
	status: Status;
}
interface TodoDetails {
	todos: Todo[];
	warning?: string;
}

const TodoItem = Type.Object({
	content: Type.String({ description: "Imperative form, e.g. 'Run tests'" }),
	activeForm: Type.String({ description: "Present-continuous form shown while active, e.g. 'Running tests'" }),
	status: StringEnum(["pending", "in_progress", "completed"] as const),
});
const TodoWriteParams = Type.Object({
	todos: Type.Array(TodoItem, { description: "The full, updated todo list (replaces prior state)" }),
});

const ICON: Record<Status, string> = { pending: "☐", in_progress: "◐", completed: "☑" };

function renderChecklist(todos: Todo[], fg?: (role: string, s: string) => string, strike?: (s: string) => string): string {
	if (todos.length === 0) return "(no todos)";
	const done = todos.filter((t) => t.status === "completed").length;
	const header = `${done}/${todos.length} completed`;
	const lines = todos.map((t) => {
		const label = t.status === "in_progress" ? t.activeForm : t.content;
		if (!fg) return `${ICON[t.status]} ${label}`;
		if (t.status === "completed") return fg("success", `${ICON.completed} `) + fg("muted", strike ? strike(label) : label);
		if (t.status === "in_progress") return fg("accent", `${ICON.in_progress} `) + fg("text", label);
		return fg("muted", `${ICON.pending} `) + label;
	});
	return `${header}\n${lines.join("\n")}`;
}

export function registerTodoTool(pi: ExtensionAPI): void {
	let todos: Todo[] = [];
	// one snapshot file per session, overwritten as the list changes
	const snapshotName = `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}.md`;

	const persistSnapshot = (ctx: ExtensionContext) => {
		try {
			const { todosDir } = resolveProject(ctx.cwd);
			fs.mkdirSync(todosDir, { recursive: true });
			const text = `# Todo snapshot — ${new Date().toISOString()}\n\n${renderChecklist(todos)}\n`;
			fs.writeFileSync(path.join(todosDir, snapshotName), text, { encoding: "utf-8", mode: 0o600 });
		} catch {
			/* non-fatal */
		}
	};

	const reconstruct = (ctx: ExtensionContext) => {
		todos = [];
		try {
			for (const entry of (ctx.sessionManager as any).getBranch() ?? []) {
				if (entry?.type !== "message") continue;
				const msg = entry.message;
				if (msg?.role !== "toolResult" || msg?.toolName !== "todo_write") continue;
				const details = msg.details as TodoDetails | undefined;
				if (details?.todos) todos = details.todos;
			}
		} catch {
			/* ignore */
		}
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (todos.length === 0) {
			ctx.ui.setStatus("todos", undefined);
			return;
		}
		const done = todos.filter((t) => t.status === "completed").length;
		ctx.ui.setStatus("todos", ctx.ui.theme.fg("muted", `▣ ${done}/${todos.length}`));
	};

	pi.on("session_start", async (_e, ctx) => {
		reconstruct(ctx);
		updateStatus(ctx);
	});
	pi.on("session_tree", async (_e, ctx) => {
		reconstruct(ctx);
		updateStatus(ctx);
	});

	pi.registerTool({
		name: "todo_write",
		label: "Todos",
		description:
			"Manage the task list for the current work. Call with the FULL updated list whenever a task starts or finishes — it replaces the previous list. Keep exactly one task 'in_progress' at a time and mark a task 'completed' immediately when done (do not batch).",
		promptSnippet: "Track multi-step work with a todo list",
		promptGuidelines: [
			"Use todo_write for any non-trivial multi-step task; update it as you start/finish each step.",
			"Exactly one todo should be in_progress at a time.",
		],
		parameters: TodoWriteParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			todos = params.todos as Todo[];
			const inProgress = todos.filter((t) => t.status === "in_progress").length;
			let warning: string | undefined;
			if (todos.length > 0 && inProgress !== 1) {
				warning = `Expected exactly one in_progress task, found ${inProgress}.`;
			}
			updateStatus(ctx);
			persistSnapshot(ctx);
			const text = renderChecklist(todos);
			return {
				content: [{ type: "text" as const, text: warning ? `${text}\n\n⚠ ${warning}` : text }],
				details: { todos, warning } satisfies TodoDetails,
			};
		},

		renderResult(result, _opts, theme) {
			const d = result.details as TodoDetails | undefined;
			const list = d?.todos ?? [];
			let text = renderChecklist(list, (role, s) => theme.fg(role, s), (s) => theme.strikethrough(s));
			if (d?.warning) text += `\n${theme.fg("warning", `⚠ ${d.warning}`)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current task list",
		handler: async (_args, ctx) => {
			reconstruct(ctx);
			if (!ctx.hasUI) return;
			const text = renderChecklist(todos, (role, s) => ctx.ui.theme.fg(role, s), (s) => ctx.ui.theme.strikethrough(s));
			ctx.ui.notify(`Todos:\n${text}`, "info");
		},
	});
}
