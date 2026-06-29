import { describe, it, expect } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import {
	formatTokens,
	formatUsageStats,
	truncateParallelOutput,
	getFinalOutput,
	getDisplayItems,
	isFailedResult,
} from "./render.ts";

describe("formatTokens", () => {
	it("returns raw count when < 1000", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(1)).toBe("1");
		expect(formatTokens(999)).toBe("999");
	});

	it("returns one decimal k when < 10000", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(9999)).toBe("10.0k");
	});

	it("returns rounded k when < 1_000_000", () => {
		expect(formatTokens(10_000)).toBe("10k");
		expect(formatTokens(12_000)).toBe("12k");
		expect(formatTokens(999_999)).toBe("1000k");
	});

	it("returns one decimal M when >= 1_000_000", () => {
		expect(formatTokens(1_000_000)).toBe("1.0M");
		expect(formatTokens(2_000_000)).toBe("2.0M");
	});
});

describe("formatUsageStats", () => {
	it("returns empty string when no fields set", () => {
		expect(
			formatUsageStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }),
		).toBe("");
	});

	it("includes turns with pluralization", () => {
		expect(
			formatUsageStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }),
		).toContain("1 turn");
		expect(
			formatUsageStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 3 }),
		).toContain("3 turns");
	});

	it("includes ↑/↓/R/W arrows with formatted tokens", () => {
		const out = formatUsageStats({
			input: 1500,
			output: 200,
			cacheRead: 12000,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
		});
		expect(out).toContain("↑1.5k");
		expect(out).toContain("↓200");
		expect(out).toContain("R12k");
		expect(out).not.toContain("W");
	});

	it("includes cost as $ with 4dp", () => {
		const out = formatUsageStats({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.012345,
			turns: 0,
		});
		expect(out).toContain("$0.0123");
	});

	it("includes ctx: when contextTokens > 0", () => {
		const out = formatUsageStats({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 50000,
			turns: 0,
		});
		expect(out).toContain("ctx:50k");
	});

	it("omits ctx when contextTokens is 0 or missing", () => {
		const out = formatUsageStats({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		});
		expect(out).not.toContain("ctx:");
	});

	it("appends model name when provided", () => {
		const out = formatUsageStats(
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			"claude-sonnet-4-5",
		);
		expect(out).toContain("claude-sonnet-4-5");
	});
});

describe("truncateParallelOutput", () => {
	it("returns input unchanged when at or below 50KB", () => {
		const s = "x".repeat(1024);
		expect(truncateParallelOutput(s)).toBe(s);
		const fiftyKb = "a".repeat(50 * 1024);
		expect(truncateParallelOutput(fiftyKb)).toBe(fiftyKb);
	});

	it("truncates and appends note when above 50KB", () => {
		const big = "x".repeat(100 * 1024);
		const out = truncateParallelOutput(big);
		expect(out).toContain("[Output truncated:");
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(60 * 1024);
		expect(out.startsWith("x".repeat(50 * 1024).slice(0, 100))).toBe(true);
	});

	it("handles multi-byte utf8 safely", () => {
		// each char is 4 bytes in utf8
		const big = "🚀".repeat(20_000); // ~80 KB
		const out = truncateParallelOutput(big);
		expect(out).toContain("[Output truncated:");
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(60 * 1024);
	});
});

function makeMsg(role: "user" | "assistant", parts: Array<{ type: "text"; text: string } | { type: "toolCall"; name: string; arguments: any }>): Message {
	return {
		role,
		content: parts,
	} as unknown as Message;
}

describe("getFinalOutput", () => {
	it("returns the last assistant text", () => {
		const msgs: Message[] = [
			makeMsg("assistant", [{ type: "text", text: "first" }]),
			makeMsg("assistant", [{ type: "text", text: "second" }]),
		];
		expect(getFinalOutput(msgs)).toBe("second");
	});

	it("returns empty string when no assistant messages", () => {
		const msgs: Message[] = [makeMsg("user", [{ type: "text", text: "hi" }])];
		expect(getFinalOutput(msgs)).toBe("");
	});

	it("skips assistant messages with no text parts", () => {
		const msgs: Message[] = [
			makeMsg("assistant", [{ type: "toolCall", name: "bash", arguments: {} }]),
			makeMsg("assistant", [{ type: "text", text: "answer" }]),
		];
		expect(getFinalOutput(msgs)).toBe("answer");
	});
});

describe("getDisplayItems", () => {
	it("orders text and toolCall items from assistant content", () => {
		const msgs: Message[] = [
			makeMsg("assistant", [
				{ type: "text", text: "thinking..." },
				{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
				{ type: "text", text: "done." },
			]),
		];
		const items = getDisplayItems(msgs);
		expect(items.map((i) => i.type)).toEqual(["text", "toolCall", "text"]);
		expect(items[0]).toEqual({ type: "text", text: "thinking..." });
		expect(items[1]).toMatchObject({ type: "toolCall", name: "bash" });
	});

	it("ignores user/tool messages", () => {
		const msgs: Message[] = [
			makeMsg("user", [{ type: "text", text: "do it" }]),
			makeMsg("assistant", [{ type: "text", text: "ok" }]),
		];
		const items = getDisplayItems(msgs);
		expect(items).toHaveLength(1);
	});
});

describe("isFailedResult", () => {
	const base = {
		agent: "x",
		agentSource: "user" as const,
		task: "t",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};

	it("returns true when exitCode !== 0", () => {
		expect(isFailedResult({ ...base, exitCode: 1 })).toBe(true);
	});

	it("returns true when stopReason is 'error'", () => {
		expect(isFailedResult({ ...base, stopReason: "error" })).toBe(true);
	});

	it("returns true when stopReason is 'aborted'", () => {
		expect(isFailedResult({ ...base, stopReason: "aborted" })).toBe(true);
	});

	it("returns false on exitCode 0 with end/correct stopReason", () => {
		expect(isFailedResult({ ...base })).toBe(false);
		expect(isFailedResult({ ...base, stopReason: "end" })).toBe(false);
	});
});