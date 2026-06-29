/**
 * Subagent orchestration: single / parallel / chain modes + concurrency limiter.
 *
 * `modes` never spawns. It receives `runAgent: RunAgentFn` and orchestrates.
 * This is what makes the orchestration unit-testable without real subprocesses.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentConfig } from "./agents.ts";
import type { ChainItemT, SingleResult, SubagentDetails, TaskItemT } from "./schema.ts";
import { getFinalOutput, isFailedResult, truncateParallelOutput } from "./render.ts";

/** Maximum number of parallel tasks allowed in one call. */
export const MAX_PARALLEL_TASKS = 8;

/** Maximum concurrent in-flight parallel tasks. */
export const MAX_CONCURRENCY = 4;

/** Per-task output byte cap (also exported from render.ts). */
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

// ---------------------------------------------------------------------------
// Injected runner — the modes never import child_process.
// ---------------------------------------------------------------------------

export interface RunAgentRequest {
	agents: AgentConfig[];
	agentName: string;
	task: string;
	cwd: string | undefined;
	defaultCwd: string;
	step: number | undefined;
	signal: AbortSignal | undefined;
	onUpdate:
		| ((partial: { content: { type: string; text: string }[]; details: SubagentDetails }) => void)
		| undefined;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
}

export type RunAgentFn = (req: RunAgentRequest) => Promise<SingleResult>;

export type SubagentToolResult = AgentToolResult<SubagentDetails> & { isError?: boolean };

// ---------------------------------------------------------------------------
// mapWithConcurrencyLimit
// ---------------------------------------------------------------------------

/**
 * Run `fn` over `items` with at most `limit` in flight. Preserves the input order
 * of results. `limit` is clamped to `max(1, items.length)`.
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	limit: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const effective = Math.max(1, Math.min(limit, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(effective).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ---------------------------------------------------------------------------
// decideMode — exactly-one-mode validator
// ---------------------------------------------------------------------------

export type Mode = "single" | "parallel" | "chain" | "list";

/**
 * Returns the mode implied by `params`, or `null` when zero or more than one
 * mode is set. Empty arrays do NOT count as a mode.
 */
export function decideMode(params: {
	agent?: string;
	task?: string;
	tasks?: TaskItemT[];
	chain?: ChainItemT[];
	list?: boolean;
}): Mode | null {
	const hasList = params.list === true;
	const hasSingle = Boolean(params.agent && params.task);
	const hasParallel = Boolean(params.tasks && params.tasks.length > 0);
	const hasChain = Boolean(params.chain && params.chain.length > 0);

	const count = Number(hasList) + Number(hasSingle) + Number(hasParallel) + Number(hasChain);
	if (count !== 1) return null;
	if (hasList) return "list";
	if (hasSingle) return "single";
	if (hasParallel) return "parallel";
	return "chain";
}

// ---------------------------------------------------------------------------
// Common option bag
// ---------------------------------------------------------------------------

interface CommonOpts {
	defaultCwd: string;
	signal: AbortSignal | undefined;
	onUpdate:
		| ((partial: { content: { type: string; text: string }[]; details: SubagentDetails }) => void)
		| undefined;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	runAgent: RunAgentFn;
}

interface SingleOpts extends CommonOpts {
	agents: AgentConfig[];
	agentName: string;
	task: string;
	cwd: string | undefined;
	step: number | undefined;
}

/** Run one agent; wrap into SubagentDetails mode=single. */
export async function runSingle(opts: SingleOpts): Promise<SubagentToolResult> {
	const result = await opts.runAgent({
		agents: opts.agents,
		agentName: opts.agentName,
		task: opts.task,
		cwd: opts.cwd,
		defaultCwd: opts.defaultCwd,
		step: opts.step,
		signal: opts.signal,
		onUpdate: opts.onUpdate,
		makeDetails: opts.makeDetails,
	});
	result.step = opts.step;
	const isError = isFailedResult(result);
	return {
		content: [
			{
				type: "text",
				text: isError
					? `Agent ${result.stopReason || "failed"}: ${result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"}`
					: getFinalOutput(result.messages) || "(no output)",
			},
		],
		details: opts.makeDetails([result]),
		...(isError ? { isError: true as const } : {}),
	};
}

interface ParallelOpts extends CommonOpts {
	items: TaskItemT[];
}

/**
 * Run tasks in parallel with MAX_CONCURRENCY in flight. Rejects with `isError:true`
 * when task count exceeds MAX_PARALLEL_TASKS. Each task's visible output is
 * truncated to PER_TASK_OUTPUT_CAP bytes.
 */
export async function runParallel(opts: ParallelOpts): Promise<SubagentToolResult> {
	if (opts.items.length > MAX_PARALLEL_TASKS) {
		return {
			content: [
				{
					type: "text",
					text: `Too many parallel tasks (${opts.items.length}). Max is ${MAX_PARALLEL_TASKS}.`,
				},
			],
			details: opts.makeDetails([]),
			isError: true,
		};
	}

	// Initialize placeholder results (used by onUpdate).
	const placeholders: SingleResult[] = opts.items.map((t) => ({
		agent: t.agent,
		agentSource: "unknown",
		task: t.task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	}));

	const emit = () => {
		if (opts.onUpdate) {
			const running = placeholders.filter((r) => r.exitCode === -1).length;
			const done = placeholders.filter((r) => r.exitCode !== -1).length;
			opts.onUpdate({
				content: [
					{
						type: "text",
						text: `Parallel: ${done}/${placeholders.length} done, ${running} running...`,
					},
				],
				details: opts.makeDetails([...placeholders]),
			});
		}
	};

	const results = await mapWithConcurrencyLimit(opts.items, MAX_CONCURRENCY, async (t, idx) => {
		const r = await opts.runAgent({
			agents: [],
			agentName: t.agent,
			task: t.task,
			cwd: t.cwd,
			defaultCwd: opts.defaultCwd,
			step: undefined,
			signal: opts.signal,
			onUpdate: opts.onUpdate
				? (partial) => {
						if (partial.details?.results[0]) {
							placeholders[idx] = partial.details.results[0];
							emit();
						}
					}
				: undefined,
			makeDetails: opts.makeDetails,
		});
		r.step = undefined; // parallel mode: no per-task step index
		placeholders[idx] = r;
		emit();
		return r;
	});

	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const summaries = results.map((r) => {
		const text = r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)";
		const status = isFailedResult(r)
			? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
			: "completed";
		return `### [${r.agent}] ${status}\n\n${truncateParallelOutput(text)}`;
	});

	return {
		content: [
			{
				type: "text",
				text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
			},
		],
		details: opts.makeDetails(results),
	};
}

interface ChainOpts extends CommonOpts {
	items: ChainItemT[];
	agents: AgentConfig[];
}

/**
 * Run steps sequentially. `{previous}` in each step's task is substituted with
 * the previous step's final output. Stops at first failure; returns
 * 'Chain stopped at step K (agent): …'.
 */
export async function runChain(opts: ChainOpts): Promise<SubagentToolResult> {
	const results: SingleResult[] = [];
	let previousOutput = "";

	for (let i = 0; i < opts.items.length; i++) {
		const step = opts.items[i];
		const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

		const chainUpdate = opts.onUpdate
			? (partial: { content: any; details?: SubagentDetails }) => {
					const cur = partial.details?.results[0];
					if (cur) {
						opts.onUpdate!({
							content: partial.content,
							details: opts.makeDetails([...results, cur]),
						});
					}
				}
			: undefined;

		const result = await opts.runAgent({
			agents: opts.agents,
			agentName: step.agent,
			task: taskWithContext,
			cwd: step.cwd,
			defaultCwd: opts.defaultCwd,
			step: i + 1,
			signal: opts.signal,
			onUpdate: chainUpdate,
			makeDetails: opts.makeDetails,
		});
		result.step = i + 1;
		results.push(result);

		if (isFailedResult(result)) {
			const errorMsg =
				result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
			return {
				content: [
					{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` },
				],
				details: opts.makeDetails(results),
				isError: true,
			};
		}
		previousOutput = getFinalOutput(result.messages);
	}

	const last = results[results.length - 1];
	return {
		content: [{ type: "text", text: getFinalOutput(last.messages) || "(no output)" }],
		details: opts.makeDetails(results),
	};
}