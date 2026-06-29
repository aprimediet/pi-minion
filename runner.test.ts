import { describe, it, expect } from "vitest";
import {
	buildPiArgs,
	accumulateEvent,
	parseNdjson,
	type RunnerAccumulatorState,
} from "./runner.ts";

describe("buildPiArgs", () => {
	it("always starts with --mode json -p --no-session", () => {
		expect(buildPiArgs({ task: "do thing" })).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"Task: do thing",
		]);
	});

	it("appends --model when model is set", () => {
		expect(buildPiArgs({ task: "x", model: "claude-haiku-4-5" })).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"claude-haiku-4-5",
			"Task: x",
		]);
	});

	it("appends --tools when tools is a non-empty array", () => {
		expect(buildPiArgs({ task: "x", tools: ["read", "write", "bash"] })).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--tools",
			"read,write,bash",
			"Task: x",
		]);
	});

	it("appends --append-system-prompt when promptPath is set", () => {
		expect(buildPiArgs({ task: "x", promptPath: "/tmp/prompt.md" })).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--append-system-prompt",
			"/tmp/prompt.md",
			"Task: x",
		]);
	});

	it("combines all flags in correct order", () => {
		const args = buildPiArgs({
			task: "t",
			model: "m",
			tools: ["read"],
			promptPath: "/p",
		});
		expect(args).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"m",
			"--tools",
			"read",
			"--append-system-prompt",
			"/p",
			"Task: t",
		]);
	});

	it("skips --tools when tools is an empty array", () => {
		const args = buildPiArgs({ task: "x", tools: [] });
		expect(args).not.toContain("--tools");
	});

	it("Task positional is always last", () => {
		const args = buildPiArgs({ task: "do X", model: "m", tools: ["read"], promptPath: "/p" });
		expect(args[args.length - 1]).toBe("Task: do X");
	});
});

function makeAssistantMsg(overrides: Partial<{
	role: string;
	model: string;
	stopReason: string;
	errorMessage: string;
	usage: any;
	content: any[];
}> = {}) {
	return {
		role: "assistant",
		model: overrides.model,
		stopReason: overrides.stopReason,
		errorMessage: overrides.errorMessage,
		usage: overrides.usage,
		content: overrides.content ?? [],
	};
}

describe("accumulateEvent", () => {
	function fresh(): RunnerAccumulatorState {
		return {
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: undefined,
			stopReason: undefined,
			errorMessage: undefined,
		};
	}

	it("on message_end + assistant: pushes message, increments turns, sums usage", () => {
		const state = fresh();
		const event = {
			type: "message_end",
			message: makeAssistantMsg({
				model: "m",
				stopReason: "end",
				usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 3, totalTokens: 100 },
			}),
		};
		const next = accumulateEvent(state, event);
		expect(next.messages).toHaveLength(1);
		expect(next.usage.turns).toBe(1);
		expect(next.usage.input).toBe(10);
		expect(next.usage.output).toBe(20);
		expect(next.usage.cacheRead).toBe(5);
		expect(next.usage.cacheWrite).toBe(3);
		expect(next.usage.contextTokens).toBe(100);
		expect(next.model).toBe("m");
		expect(next.stopReason).toBe("end");
	});

	it("sums cost.total across turns", () => {
		const state = fresh();
		const next1 = accumulateEvent(state, {
			type: "message_end",
			message: makeAssistantMsg({ usage: { cost: { total: 0.01 }, totalTokens: 1 } }),
		});
		const next2 = accumulateEvent(next1, {
			type: "message_end",
			message: makeAssistantMsg({ usage: { cost: { total: 0.005 }, totalTokens: 1 } }),
		});
		expect(next2.usage.cost).toBeCloseTo(0.015, 6);
		expect(next2.usage.turns).toBe(2);
	});

	it("captures stopReason + errorMessage from assistant messages", () => {
		const state = fresh();
		const next = accumulateEvent(state, {
			type: "message_end",
			message: makeAssistantMsg({ stopReason: "error", errorMessage: "boom" }),
		});
		expect(next.stopReason).toBe("error");
		expect(next.errorMessage).toBe("boom");
	});

	it("does NOT overwrite model once set", () => {
		const state = fresh();
		const a = accumulateEvent(state, {
			type: "message_end",
			message: makeAssistantMsg({ model: "first", usage: {} }),
		});
		const b = accumulateEvent(a, {
			type: "message_end",
			message: makeAssistantMsg({ model: "second", usage: {} }),
		});
		expect(b.model).toBe("first");
	});

	it("on message_end + non-assistant: still pushes message but doesn't change usage", () => {
		const state = fresh();
		const next = accumulateEvent(state, {
			type: "message_end",
			message: { role: "user", content: [] },
		});
		expect(next.messages).toHaveLength(1);
		expect(next.usage.turns).toBe(0);
	});

	it("on tool_result_end: pushes message", () => {
		const state = fresh();
		const next = accumulateEvent(state, {
			type: "tool_result_end",
			message: { role: "toolResult", content: [] },
		});
		expect(next.messages).toHaveLength(1);
	});

	it("on unknown event type: returns state unchanged (new object)", () => {
		const state = fresh();
		const next = accumulateEvent(state, { type: "message_start" });
		expect(next.messages).toHaveLength(0);
		expect(next).not.toBe(state); // reducer must be pure
	});

	it("on garbage / non-object event: returns state unchanged", () => {
		const state = fresh();
		const next1 = accumulateEvent(state, null as any);
		const next2 = accumulateEvent(state, "garbage" as any);
		const next3 = accumulateEvent(state, undefined as any);
		expect(next1.messages).toHaveLength(0);
		expect(next2.messages).toHaveLength(0);
		expect(next3.messages).toHaveLength(0);
	});
});

describe("parseNdjson", () => {
	it("returns empty events + carries trailing partial line", () => {
		const r = parseNdjson('{"a":1}\n{"b":2}\n', "");
		expect(r.events).toEqual([{ a: 1 }, { b: 2 }]);
		expect(r.carry).toBe("");
	});

	it("carries a partial trailing line across calls", () => {
		const r1 = parseNdjson('{"a":1}\n{"b":2', "");
		expect(r1.events).toEqual([{ a: 1 }]);
		expect(r1.carry).toBe('{"b":2');

		const r2 = parseNdjson('}\n{"c":3}\n', r1.carry);
		expect(r2.events).toEqual([{ b: 2 }, { c: 3 }]);
		expect(r2.carry).toBe("");
	});

	it("ignores empty lines and lines that fail to JSON.parse", () => {
		const r = parseNdjson('{"a":1}\n\nnot-json\n{"b":2}\n', "");
		expect(r.events).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("returns empty events when input is empty", () => {
		const r = parseNdjson("", "");
		expect(r.events).toEqual([]);
		expect(r.carry).toBe("");
	});
});