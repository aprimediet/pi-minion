/**
 * Run a single subagent subprocess: spawn `pi --mode json`, parse NDJSON events,
 * accumulate usage, support abort + SIGTERM→SIGKILL, clean up temp prompt file.
 *
 * Pure logic (`buildPiArgs`, `accumulateEvent`, `parseNdjson`) is split out for
 * unit testing. The actual subprocess shell is thin and gets a single integration
 * test against a stub script.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import type { SingleResult, SubagentDetails, UsageStats } from "./schema.ts";
import { emptyUsage } from "./schema.ts";

// ---------------------------------------------------------------------------
// Pure: arg builder
// ---------------------------------------------------------------------------

export interface BuildPiArgsInput {
	model?: string;
	tools?: string[];
	promptPath?: string;
	task: string;
}

/**
 * Build the argv passed to the `pi` subprocess.
 *   `["--mode","json","-p","--no-session"]`
 *   + `--model <m>` iff model
 *   + `--tools a,b` iff tools non-empty
 *   + `--append-system-prompt <path>` iff promptPath
 *   + `Task: <task>` (positional, always last)
 */
export function buildPiArgs(input: BuildPiArgsInput): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (input.model) args.push("--model", input.model);
	if (input.tools && input.tools.length > 0) args.push("--tools", input.tools.join(","));
	if (input.promptPath) args.push("--append-system-prompt", input.promptPath);
	args.push(`Task: ${input.task}`);
	return args;
}

// ---------------------------------------------------------------------------
// Pure: NDJSON parser
// ---------------------------------------------------------------------------

export interface ParseNdjsonResult {
	events: unknown[];
	/** Trailing partial line to prepend to the next chunk. */
	carry: string;
}

/**
 * Split a chunk on `\n`, parse each line as JSON. Lines that fail to parse are
 * silently dropped. The trailing partial line (after the last `\n`) is preserved
 * in `carry` and should be prepended to the next chunk.
 */
export function parseNdjson(chunk: string, carry: string): ParseNdjsonResult {
	const combined = carry + chunk;
	const lines = combined.split("\n");
	const nextCarry = lines.pop() ?? "";
	const events: unknown[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed));
		} catch {
			/* drop garbage lines */
		}
	}
	return { events, carry: nextCarry };
}

// ---------------------------------------------------------------------------
// Pure: event reducer
// ---------------------------------------------------------------------------

export interface RunnerAccumulatorState {
	messages: Message[];
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

function freshState(): RunnerAccumulatorState {
	return { messages: [], usage: emptyUsage() };
}

/**
 * Pure reducer over parsed NDJSON events. Updates the accumulator in place of a
 * fresh copy — caller must use the returned state, not mutate the input.
 *
 *   message_end + assistant -> push msg, turn++, sum usage, capture model/stopReason/errorMessage
 *   message_end + other     -> push msg only
 *   tool_result_end         -> push msg only
 *   anything else           -> state unchanged (new object)
 */
export function accumulateEvent(
	state: RunnerAccumulatorState,
	event: unknown,
): RunnerAccumulatorState {
	if (!event || typeof event !== "object") return { ...state };

	const e = event as { type?: string; message?: Message };
	const next: RunnerAccumulatorState = {
		messages: [...state.messages],
		usage: { ...state.usage },
		model: state.model,
		stopReason: state.stopReason,
		errorMessage: state.errorMessage,
	};

	if (e.type === "message_end" && e.message) {
		const msg = e.message;
		next.messages.push(msg);
		if (msg.role === "assistant") {
			next.usage.turns += 1;
			const usage = (msg as Message & { usage?: any }).usage;
			if (usage) {
				next.usage.input += usage.input || 0;
				next.usage.output += usage.output || 0;
				next.usage.cacheRead += usage.cacheRead || 0;
				next.usage.cacheWrite += usage.cacheWrite || 0;
				next.usage.cost += usage.cost?.total || 0;
				if (usage.totalTokens) next.usage.contextTokens = usage.totalTokens;
			}
			const m = msg as Message & { model?: string; stopReason?: string; errorMessage?: string };
			if (!next.model && m.model) next.model = m.model;
			if (m.stopReason) next.stopReason = m.stopReason;
			if (m.errorMessage) next.errorMessage = m.errorMessage;
		}
		return next;
	}

	if (e.type === "tool_result_end" && e.message) {
		next.messages.push(e.message);
		return next;
	}

	return next;
}

// ---------------------------------------------------------------------------
// Pure helper: write prompt to temp file (0600), cleaned in `finally` by caller.
// ---------------------------------------------------------------------------

export async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

/** Resolve how to invoke pi (port from example): re-exec current script under same runtime, fallback `pi` command. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

// ---------------------------------------------------------------------------
// Subprocess shell
// ---------------------------------------------------------------------------

export type SpawnFn = (
	command: string,
	args: string[],
	opts: { cwd: string; stdio: ["ignore", "pipe", "pipe"]; shell: false },
) => ChildProcess;

const defaultSpawn: SpawnFn = (command, args, opts) =>
	spawn(command, args, opts) as ChildProcess;

export interface RunSingleAgentInput {
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
	/** Injectable spawn for hermetic tests. Defaults to child_process.spawn. */
	spawn?: SpawnFn;
}

export async function runSingleAgent(input: RunSingleAgentInput): Promise<SingleResult> {
	const {
		agents,
		agentName,
		task,
		cwd,
		defaultCwd,
		step,
		signal,
		onUpdate,
		makeDetails,
		spawn: spawnFn = defaultSpawn,
	} = input;

	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: emptyUsage(),
			step,
		};
	}

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		step,
	};

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutputLocal(currentResult.messages) || "(running...)" }],
				details: makeDetails([{ ...currentResult, messages: [...currentResult.messages], usage: { ...currentResult.usage } }]),
			});
		}
	};

	try {
		const args = buildPiArgs({ task, model: agent.model, tools: agent.tools });
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.splice(args.length - 1, 0, "--append-system-prompt", tmpPromptPath);
		}

		let wasAborted = false;
		let accumulator: RunnerAccumulatorState = freshState();

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawnFn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});
			let carry = "";

			proc.stdout?.on("data", (data: Buffer) => {
				const { events, carry: nextCarry } = parseNdjson(data.toString(), carry);
				carry = nextCarry;
				for (const event of events) {
					accumulator = accumulateEvent(accumulator, event);
				}
				// Sync into currentResult
				currentResult.messages = [...accumulator.messages];
				currentResult.usage = { ...accumulator.usage };
				if (accumulator.model) currentResult.model = accumulator.model;
				if (accumulator.stopReason) currentResult.stopReason = accumulator.stopReason;
				if (accumulator.errorMessage) currentResult.errorMessage = accumulator.errorMessage;
				emitUpdate();
			});

			proc.stderr?.on("data", (data: Buffer) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (carry.trim()) {
					const { events } = parseNdjson(carry + "\n", "");
					for (const event of events) {
						accumulator = accumulateEvent(accumulator, event);
					}
					currentResult.messages = [...accumulator.messages];
					currentResult.usage = { ...accumulator.usage };
				}
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					try {
						proc.kill("SIGTERM");
					} catch {
						/* ignore */
					}
					setTimeout(() => {
						if (!proc.killed) {
							try {
								proc.kill("SIGKILL");
							} catch {
								/* ignore */
							}
						}
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
	}
}

// Local re-export to avoid circular import with render.ts.
function getFinalOutputLocal(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}