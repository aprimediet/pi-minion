import * as fs from "node:fs";
import * as path from "node:path";
import { spawn as defaultSpawn } from "node:child_process";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;
export const COLLAPSED_ITEM_COUNT = 10;

export interface BuildArgsOptions {
    model?: string;
    tools?: string[];
    promptFilePath?: string;
}

export interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
    contextTokens: number;
}

export interface SingleResult {
    agentName: string;
    agentSource: string;
    messages: any[];
    turns: number;
    model: string;
    stopReason: string;
    exitCode: number;
    errorMessage?: string;
    stderr: string;
    outputText: string;
    projectAgentsDir?: string | null;
    usage: UsageStats;
}

export function makeEmptyResult(agentName: string, agentSource: string): SingleResult {
    return {
        agentName,
        agentSource,
        messages: [],
        turns: 0,
        model: "",
        stopReason: "",
        exitCode: 0,
        stderr: "",
        outputText: "",
        usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0,
            contextTokens: 0,
        },
    };
}

export async function mapWithConcurrencyLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;

    async function worker(): Promise<void> {
        while (cursor < items.length) {
            const idx = cursor++;
            results[idx] = await fn(items[idx]!, idx);
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

export function reduceEvent(result: SingleResult, line: string): void {
    if (!line.trim()) return;
    let parsed: any;
    try {
        parsed = JSON.parse(line);
    } catch {
        return;
    }

    switch (parsed.event) {
        case "message_end": {
            const msg = parsed.message;
            if (msg) result.messages.push(msg);
            result.turns++;
            if (parsed.usage) {
                result.usage.inputTokens += parsed.usage.input ?? 0;
                result.usage.outputTokens += parsed.usage.output ?? 0;
                result.usage.cacheReadTokens += parsed.usage.cache_read ?? 0;
                result.usage.cacheWriteTokens += parsed.usage.cache_write ?? 0;
                result.usage.cost += parsed.usage.cost ?? 0;
                result.usage.contextTokens += parsed.usage.context_tokens ?? 0;
            }
            if (parsed.model) result.model = parsed.model;
            if (parsed.stop_reason) result.stopReason = parsed.stop_reason;
            break;
        }
        case "tool_result_end": {
            const msg = parsed.message;
            if (msg) result.messages.push(msg);
            break;
        }
        case "error": {
            if (parsed.error?.message) result.errorMessage = parsed.error.message;
            break;
        }
    }
}

export interface PiInvocationDeps {
    execPath: string;
    argv1: string;
    existsSync: (p: string) => boolean;
}

export function getPiInvocation(args: string[], deps?: PiInvocationDeps): { command: string; args: string[] } {
    const execPath = deps?.execPath ?? process.execPath;
    const argv1 = deps?.argv1 ?? process.argv[1] ?? "";
    const existsSync = deps?.existsSync ?? ((p: string) => {
        try { return fs.existsSync(p); } catch { return false; }
    });

    // If argv1 is a real on-disk script (not bunfs), use it
    if (argv1 && !argv1.includes("/$bunfs/") && existsSync(argv1)) {
        return { command: execPath, args: [argv1, ...args] };
    }

    // If runtime is a generic node/bun, fall back to `pi` command
    const basename = execPath.split("/").pop() ?? "";
    if (basename === "node" || basename === "bun") {
        return { command: "pi", args };
    }

    // Otherwise use execPath + argv1 as-is
    return { command: execPath, args: [argv1, ...args] };
}

export function capOutput(text: string, cap: number): string {
    if (text.length <= cap) return text;
    return text.slice(0, cap) + "…(truncated)";
}

export function substitutePrevious(task: string, previous: string): string {
    return task.replace(/\{previous\}/g, previous);
}

export type RunModeType = "single" | "parallel" | "chain";

export interface SingleModeParams {
    agent: string;
    task: string;
    cwd?: string;
}

export interface ParallelModeParams {
    tasks: Array<{ agent: string; task: string; cwd?: string }>;
}

export interface ChainModeParams {
    chain: Array<{ agent: string; task: string; cwd?: string }>;
}

export type ModeParams = SingleModeParams | ParallelModeParams | ChainModeParams;

export interface ModeResult {
    content: string;
    details?: any;
    isError?: boolean;
}

export interface RunSingleAgentDeps {
    spawn?: typeof import("node:child_process").spawn;
}

export async function runMode(
    mode: RunModeType,
    agents: import("./agents.ts").AgentConfig[],
    params: ModeParams,
    defaultCwd: string,
    signal: AbortSignal,
    onUpdate: (update: any) => void,
    runSingle: (defaultCwd: string, agents: import("./agents.ts").AgentConfig[], agentName: string, task: string, cwd: string | undefined, step: number | undefined, signal: AbortSignal, onUpdate: (result: SingleResult) => void) => Promise<SingleResult>,
): Promise<ModeResult> {
    switch (mode) {
        case "single": {
            const p = params as SingleModeParams;
            const result = await runSingle(defaultCwd, agents, p.agent, p.task, p.cwd, undefined, signal, onUpdate);
            const content = result.outputText || result.stderr || "";
            return {
                content,
                details: result,
                isError: result.exitCode !== 0,
            };
        }
        case "parallel": {
            const p = params as ParallelModeParams;
            if (p.tasks.length > MAX_PARALLEL_TASKS) {
                return {
                    content: `Error: too many parallel tasks (${p.tasks.length}), max is ${MAX_PARALLEL_TASKS}`,
                    isError: true,
                };
            }
            const results = await mapWithConcurrencyLimit(p.tasks, MAX_CONCURRENCY, async (task, idx) => {
                const r = await runSingle(defaultCwd, agents, task.agent, task.task, task.cwd, idx, signal, onUpdate);
                return r;
            });
            // Cap model-visible output
            const fullText = results.map((r, i) => `[${i}] ${r.agentName}: ${r.outputText}`).join("\n");
            const content = capOutput(fullText, PER_TASK_OUTPUT_CAP);
            return {
                content,
                details: results,
                isError: results.some(r => r.exitCode !== 0),
            };
        }
        case "chain": {
            const p = params as ChainModeParams;
            let previous = "";
            for (let i = 0; i < p.chain.length; i++) {
                const step = p.chain[i]!;
                const task = substitutePrevious(step.task, previous);
                const result = await runSingle(defaultCwd, agents, step.agent, task, step.cwd, i, signal, onUpdate);
                if (result.exitCode !== 0) {
                    return {
                        content: `Chain failed at step ${i} (agent "${step.agent}"): ${result.stderr || result.outputText}`,
                        details: { failedStep: i, failedAgent: step.agent, results: undefined },
                        isError: true,
                    };
                }
                previous = result.outputText || "";
            }
            return {
                content: previous,
                isError: false,
            };
        }
    }
}

export async function runSingleAgent(
    defaultCwd: string,
    agents: import("./agents.ts").AgentConfig[],
    agentName: string,
    task: string,
    cwd: string | undefined,
    step: number | undefined,
    signal: AbortSignal,
    onUpdate: (result: SingleResult) => void,
    deps: RunSingleAgentDeps = {},
): Promise<SingleResult> {
    // Look up agent
    const config = agents.find(a => a.name === agentName);
    if (!config) {
        const names = agents.map(a => a.name).join(", ");
        const result = makeEmptyResult(agentName, "unknown");
        result.exitCode = 1;
        result.stderr = `Unknown agent "${agentName}". Available: ${names}`;
        return result;
    }

    const resolvedCwd = cwd ?? defaultCwd;
    const result = makeEmptyResult(agentName, config.source);
    let tempFiles: string[] = [];

    // Check pre-aborted signal early
    if (signal.aborted) {
        throw new Error("aborted");
    }

    // Build args
    const options: BuildArgsOptions = {};
    if (config.model) options.model = config.model;
    if (config.tools) options.tools = config.tools;

    let promptFilePath: string | undefined;
    if (config.systemPrompt) {
        const tmpDir = fs.mkdtempSync("minion-prompt-");
        const tmpFile = path.join(tmpDir, "prompt.md");
        fs.writeFileSync(tmpFile, config.systemPrompt, "utf-8");
        promptFilePath = tmpFile;
        tempFiles.push(tmpDir);
    }
    if (promptFilePath) options.promptFilePath = promptFilePath;

    const agentArgs = buildAgentArgs(agentName, task, options);
    const invocation = getPiInvocation(agentArgs);

    let proc: any;
    let closeResolve: () => void = () => {};
    try {
        const spawn = deps.spawn ?? defaultSpawn;

        proc = spawn(invocation.command, invocation.args, {
            cwd: resolvedCwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
        });

        // Stdout: line-buffered JSON events
        let buffer = "";
        proc.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                reduceEvent(result, line);
            }
            // Get latest output text
            const lastMsg = result.messages[result.messages.length - 1];
            if (lastMsg?.content?.[0]?.text) {
                result.outputText = lastMsg.content[0].text;
            }
            onUpdate(result);
        });

        // Stderr: collect
        proc.stderr.on("data", (chunk: Buffer) => {
            result.stderr += chunk.toString();
        });

        // Abort handling
        const abortHandler = () => {
            if (proc && !proc.killed) {
                proc.kill("SIGTERM");
                setTimeout(() => {
                    if (proc && !proc.killed) proc.kill("SIGKILL");
                }, 5000).unref();
            }
            closeResolve();
        };
        signal.addEventListener("abort", abortHandler, { once: true });

        // Wait for close
        await new Promise<void>((resolve) => {
            closeResolve = resolve;
            proc.on("close", (code: number) => {
                result.exitCode = code ?? 1;
                resolve();
            });
            proc.on("error", (err: Error) => {
                result.exitCode = 1;
                result.errorMessage = err.message;
                resolve();
            });
        });

        signal.removeEventListener("abort", abortHandler);

        if (signal.aborted) {
            throw new Error("aborted");
        }
    } finally {
        // Cleanup temp files
        for (const t of tempFiles) {
            try {
                fs.rmSync(t, { recursive: true, force: true });
            } catch {
                // non-fatal
            }
        }
    }

    return result;
}

export function buildAgentArgs(agent: string, task: string, options: BuildArgsOptions = {}): string[] {
    const args: string[] = ["--mode", "json", "-p", "--no-session"];

    if (options.model) {
        args.push("--model", options.model);
    }

    if (options.tools && options.tools.length > 0) {
        args.push("--tools", options.tools.join(","));
    }

    if (options.promptFilePath) {
        args.push("--append-system-prompt", options.promptFilePath);
    }

    args.push(`Task: ${task}`);
    return args;
}
