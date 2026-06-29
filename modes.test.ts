import { describe, it, expect } from "vitest";
import {
	mapWithConcurrencyLimit,
	runSingle,
	runParallel,
	runChain,
	decideMode,
	MAX_PARALLEL_TASKS,
	MAX_CONCURRENCY,
	type RunAgentFn,
} from "./modes.ts";
import { emptyUsage } from "./schema.ts";
import type { SingleResult, SubagentDetails } from "./schema.ts";
import type { AgentConfig } from "./agents.ts";
import type { AgentScopeT, TaskItemT, ChainItemT, SubagentParamsT } from "./schema.ts";

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: overrides.agent ?? "a",
		agentSource: "user",
		task: overrides.task ?? "t",
		exitCode: overrides.exitCode ?? 0,
		messages: overrides.messages ?? [
			{ role: "assistant", content: [{ type: "text", text: "ok" }] } as any,
		],
		stderr: overrides.stderr ?? "",
		usage: overrides.usage ?? emptyUsage(),
		model: overrides.model,
		stopReason: overrides.stopReason,
		errorMessage: overrides.errorMessage,
		step: overrides.step,
	};
}

function makeDetails(): (results: SingleResult[]) => SubagentDetails {
	return (results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results });
}

function detailsForMode(mode: "single" | "parallel" | "chain"): (results: SingleResult[]) => SubagentDetails {
	return (results) => ({ mode, agentScope: "user", projectAgentsDir: null, results });
}

describe("mapWithConcurrencyLimit", () => {
	it("returns [] for empty input", async () => {
		const out = await mapWithConcurrencyLimit([], 4, async (x) => x);
		expect(out).toEqual([]);
	});

	it("preserves order of results", async () => {
		const items = [1, 2, 3, 4, 5];
		const out = await mapWithConcurrencyLimit(items, 4, async (x) => {
			await new Promise((r) => setTimeout(r, 5 - x));
			return x * 10;
		});
		expect(out).toEqual([10, 20, 30, 40, 50]);
	});

	it("never exceeds limit in flight", async () => {
		const items = Array.from({ length: 20 }, (_, i) => i);
		let inFlight = 0;
		let peak = 0;
		const out = await mapWithConcurrencyLimit(items, 4, async (x) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return x;
		});
		expect(out).toHaveLength(20);
		expect(peak).toBeLessThanOrEqual(4);
		expect(peak).toBeGreaterThan(1); // actually parallel
	});

	it("clamps limit to item count", async () => {
		const items = [1, 2, 3];
		const out = await mapWithConcurrencyLimit(items, 99, async (x) => x);
		expect(out).toEqual([1, 2, 3]);
	});
});

describe("decideMode", () => {
	const baseParams = (): SubagentParamsT => ({ list: true });

	it("returns 'list' when list:true", () => {
		expect(decideMode({ list: true })).toBe("list");
	});

	it("returns 'single' when agent+task provided", () => {
		expect(decideMode({ agent: "a", task: "t" })).toBe("single");
	});

	it("returns 'parallel' when tasks.length > 0", () => {
		expect(decideMode({ tasks: [{ agent: "a", task: "t" }] })).toBe("parallel");
	});

	it("returns 'chain' when chain.length > 0", () => {
		expect(decideMode({ chain: [{ agent: "a", task: "t" }] })).toBe("chain");
	});

	it("returns null when zero modes provided", () => {
		expect(decideMode({})).toBeNull();
	});

	it("returns null when 2+ modes provided (single + parallel)", () => {
		expect(decideMode({ agent: "a", task: "t", tasks: [{ agent: "a", task: "t" }] })).toBeNull();
	});

	it("returns null when all three provided", () => {
		expect(
			decideMode({
				agent: "a",
				task: "t",
				tasks: [{ agent: "a", task: "t" }],
				chain: [{ agent: "a", task: "t" }],
			}),
		).toBeNull();
	});

	it("does NOT treat empty arrays as providing a mode", () => {
		expect(decideMode({ tasks: [], chain: [] })).toBeNull();
	});

	it("does NOT treat {agent} alone as single mode (no task)", () => {
		expect(decideMode({ agent: "a" })).toBeNull();
	});

	it("does NOT treat {task} alone as single mode (no agent)", () => {
		expect(decideMode({ task: "t" })).toBeNull();
	});
});

describe("runSingle", () => {
	it("calls runner once and wraps in SubagentDetails mode=single", async () => {
		const calls: Array<{ name: string; task: string }> = [];
		const runAgent: RunAgentFn = async (req) => {
			calls.push({ name: req.agentName, task: req.task });
			return makeResult({ agent: req.agentName, task: req.task });
		};
		const out = await runSingle({
			agents: [] as AgentConfig[],
			agentName: "a",
			task: "do",
			cwd: undefined,
			defaultCwd: "/tmp",
			step: undefined,
			signal: undefined,
			onUpdate: undefined,
			makeDetails: makeDetails(),
			runAgent,
		});
		expect(calls).toEqual([{ name: "a", task: "do" }]);
		expect(out.details.mode).toBe("single");
		expect(out.details.results).toHaveLength(1);
		expect(out.isError).toBeUndefined();
	});

	it("sets isError when runner returned a failed result", async () => {
		const runAgent: RunAgentFn = async () =>
			makeResult({ exitCode: 1, stopReason: "error", errorMessage: "boom" });
		const out = await runSingle({
			agents: [],
			agentName: "a",
			task: "t",
			cwd: undefined,
			defaultCwd: "/tmp",
			step: undefined,
			signal: undefined,
			onUpdate: undefined,
			makeDetails: makeDetails(),
			runAgent,
		});
		expect(out.isError).toBe(true);
		expect(out.details.results[0].stopReason).toBe("error");
	});
});

describe("runParallel", () => {
	it("rejects when task count exceeds MAX_PARALLEL_TASKS", async () => {
		const runAgent: RunAgentFn = async () => makeResult();
		const items: TaskItemT[] = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, i) => ({
			agent: "a",
			task: `t${i}`,
		}));
		const out = await runParallel({
			items,
			defaultCwd: "/tmp",
			signal: undefined,
			onUpdate: undefined,
			makeDetails: makeDetails(),
			runAgent,
		});
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toMatch(/Too many parallel tasks/);
	});

	it("accepts exactly MAX_PARALLEL_TASKS items", async () => {
		const runAgent: RunAgentFn = async (req) =>
			makeResult({ agent: req.agentName, task: req.task });
		const items: TaskItemT[] = Array.from({ length: MAX_PARALLEL_TASKS }, (_, i) => ({
			agent: "a",
			task: `t${i}`,
		}));
		const out = await runParallel({
			items,
			defaultCwd: "/tmp",
			signal: undefined,
			onUpdate: undefined,
			makeDetails: detailsForMode("parallel"),
			runAgent,
		});
		expect(out.details.mode).toBe("parallel");
		expect(out.details.results).toHaveLength(MAX_PARALLEL_TASKS);
		expect(out.isError).toBeUndefined();
	});

	it("summary contains 'N/M succeeded'", async () => {
		let i = 0;
		const runAgent: RunAgentFn = async () => {
			i++;
			return i === 2 ? makeResult({ exitCode: 1, stopReason: "error" }) : makeResult();
		};
		const items: TaskItemT[] = [
			{ agent: "a", task: "t0" },
			{ agent: "a", task: "t1" },
			{ agent: "a", task: "t2" },
		];
		const out = await runParallel({
			items,
			defaultCwd: "/tmp",
			signal: undefined,
			onUpdate: undefined,
			makeDetails: makeDetails(),
			runAgent,
		});
		expect(out.content[0].text).toMatch(/2\/3 succeeded/);
	});

	it("truncates each task's visible output to <= 60KB", async () => {
		const big = "x".repeat(100 * 1024);
		const runAgent: RunAgentFn = async () => makeResult();
		// Need to populate output text. Patch getResultOutput flow: runParallel composes text itself.
		// Easier: make the result have a big assistant text.
		const runAgent2: RunAgentFn = async () =>
			makeResult({
				messages: [{ role: "assistant", content: [{ type: "text", text: big }] } as any],
			});
		const out = await runParallel({
			items: [{ agent: "a", task: "t" }],
			defaultCwd: "/tmp",
			signal: undefined,
			onUpdate: undefined,
			makeDetails: makeDetails(),
			runAgent: runAgent2,
		});
		// the visible summary uses truncateParallelOutput on each task's text; 100KB > 50KB cap
		expect(out.content[0].text).toContain("[Output truncated:");
	});

	it("respects MAX_CONCURRENCY (no more in-flight than that)", async () => {
		let inFlight = 0;
		let peak = 0;
		const runAgent: RunAgentFn = async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 20));
			inFlight--;
			return makeResult();
		};
		const items: TaskItemT[] = Array.from({ length: 8 }, (_, i) => ({
			agent: "a",
			task: `t${i}`,
		}));
		await runParallel({
			items,
			defaultCwd: "/tmp",
			signal: undefined,
			onUpdate: undefined,
			makeDetails: makeDetails(),
			runAgent,
		});
		expect(peak).toBeLessThanOrEqual(MAX_CONCURRENCY);
		expect(peak).toBeGreaterThan(1);
	});
});

describe("runChain", () => {
	it("substitutes {previous} with prior step's final output", async () => {
		const seen: string[] = [];
		const runAgent: RunAgentFn = async (req) => {
			seen.push(req.task);
			return makeResult({
				messages: [
					{ role: "assistant", content: [{ type: "text", text: `out-${seen.length}` }] } as any,
				],
			});
		};
		const items: ChainItemT[] = [
			{ agent: "a", task: "first" },
			{ agent: "b", task: "second: {previous}" },
		];
		const out = await runChain({
			items,
			defaultCwd: "/tmp",
			signal: undefined,
			onUpdate: undefined,
			makeDetails: detailsForMode("chain"),
			runAgent,
		});
		expect(seen).toEqual(["first", "second: out-1"]);
		expect(out.details.mode).toBe("chain");
		expect(out.details.results).toHaveLength(2);
		expect(out.isError).toBeUndefined();
	});

	it("stops at first failure and returns 'Chain stopped at step K (agent): ...'", async () => {
		let i = 0;
		const runAgent: RunAgentFn = async (req) => {
			i++;
			if (i === 2) return makeResult({ agent: req.agentName, exitCode: 1, stopReason: "error", errorMessage: "boom" });
			return makeResult({ agent: req.agentName, task: req.task });
		};
		const items: ChainItemT[] = [
			{ agent: "first-agent", task: "first" },
			{ agent: "failing-agent", task: "second" },
			{ agent: "third", task: "third" },
		];
		const out = await runChain({
			items,
			defaultCwd: "/tmp",
			signal: undefined,
			onUpdate: undefined,
			makeDetails: detailsForMode("chain"),
			runAgent,
		});
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toContain("Chain stopped at step 2 (failing-agent):");
		expect(out.content[0].text).toContain("boom");
		expect(out.details.results).toHaveLength(2); // third step never ran
	});

	it("success returns last step's final output as content text", async () => {
		const runAgent: RunAgentFn = async (req) => {
			return makeResult({
				agent: req.agentName,
				messages: [
					{ role: "assistant", content: [{ type: "text", text: `done-${req.agentName}` }] } as any,
				],
			});
		};
		const items: ChainItemT[] = [
			{ agent: "x", task: "t1" },
			{ agent: "y", task: "t2" },
		];
		const out = await runChain({
			items,
			defaultCwd: "/tmp",
			signal: undefined,
			onUpdate: undefined,
			makeDetails: detailsForMode("chain"),
			runAgent,
		});
		expect(out.content[0].text).toBe("done-y");
		expect(out.isError).toBeUndefined();
	});

	it("sets step index per result", async () => {
		const runAgent: RunAgentFn = async (req) => makeResult({ agent: req.agentName, task: req.task });
		const items: ChainItemT[] = [
			{ agent: "x", task: "t1" },
			{ agent: "y", task: "t2" },
			{ agent: "z", task: "t3" },
		];
		const out = await runChain({
			items,
			defaultCwd: "/tmp",
			signal: undefined,
			onUpdate: undefined,
			makeDetails: detailsForMode("chain"),
			runAgent,
		});
		expect(out.details.results.map((r) => r.step)).toEqual([1, 2, 3]);
	});
});

// Silences unused warning for the AgentScopeT import (used indirectly via SubagentDetails).
type _SilenceScope = AgentScopeT;