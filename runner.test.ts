import { describe, it, expect } from "vitest";
import { buildAgentArgs, substitutePrevious, reduceEvent, makeEmptyResult, mapWithConcurrencyLimit, capOutput, getPiInvocation } from "./runner.ts";

describe("buildAgentArgs", () => {
    it("builds base args with task", () => {
        const args = buildAgentArgs("worker", "do the thing");
        expect(args).toEqual(["--mode", "json", "-p", "--no-session", "Task: do the thing"]);
    });

    it("appends --model when model is set", () => {
        const args = buildAgentArgs("worker", "task", { model: "claude-haiku-4-5" });
        expect(args).toContain("--model");
        expect(args).toContain("claude-haiku-4-5");
    });

    it("appends --tools csv when tools present", () => {
        const args = buildAgentArgs("worker", "task", { tools: ["read", "grep"] });
        expect(args).toContain("--tools");
        expect(args).toContain("read,grep");
    });

    it("appends --append-system-prompt when promptFilePath given", () => {
        const args = buildAgentArgs("worker", "task", { promptFilePath: "/tmp/prompt.md" });
        expect(args).toContain("--append-system-prompt");
        expect(args).toContain("/tmp/prompt.md");
    });

    it("includes all optional args together", () => {
        const args = buildAgentArgs("worker", "complex task", {
            model: "claude-sonnet-4-5",
            tools: ["read", "bash", "ls"],
            promptFilePath: "/tmp/p.md",
        });
        expect(args).toEqual([
            "--mode", "json", "-p", "--no-session",
            "--model", "claude-sonnet-4-5",
            "--tools", "read,bash,ls",
            "--append-system-prompt", "/tmp/p.md",
            "Task: complex task",
        ]);
    });

    it("places task last", () => {
        const args = buildAgentArgs("scout", "final task");
        expect(args[args.length - 1]).toBe("Task: final task");
    });
});

describe("substitutePrevious", () => {
    it("replaces {previous} with given text", () => {
        const result = substitutePrevious("Now do this: {previous}", "step1 done");
        expect(result).toBe("Now do this: step1 done");
    });

    it("replaces all {previous} occurrences", () => {
        const result = substitutePrevious("{previous} then {previous}", "x");
        expect(result).toBe("x then x");
    });

    it("returns unchanged when no {previous}", () => {
        const result = substitutePrevious("just a task", "anything");
        expect(result).toBe("just a task");
    });

    it("handles empty previous text", () => {
        const result = substitutePrevious("prefix {previous} suffix", "");
        expect(result).toBe("prefix  suffix");
    });
});

describe("reduceEvent", () => {
    it("accumulates usage from message_end assistant events", () => {
        const result = makeEmptyResult("worker", "bundled");
        const line = JSON.stringify({
            event: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
            usage: { input: 10, output: 20, cache_read: 5, cache_write: 3, cost: 0.002, context_tokens: 100 },
            model: "claude-3-haiku",
            stop_reason: "end_turn",
        });
        reduceEvent(result, line);
        expect(result.turns).toBe(1);
        expect(result.usage.inputTokens).toBe(10);
        expect(result.usage.outputTokens).toBe(20);
        expect(result.usage.cacheReadTokens).toBe(5);
        expect(result.usage.cacheWriteTokens).toBe(3);
        expect(result.usage.cost).toBe(0.002);
        expect(result.usage.contextTokens).toBe(100);
        expect(result.model).toBe("claude-3-haiku");
        expect(result.stopReason).toBe("end_turn");
        expect(result.messages).toHaveLength(1);
    });

    it("handles tool_result_end events", () => {
        const result = makeEmptyResult("worker", "bundled");
        const line = JSON.stringify({
            event: "tool_result_end",
            message: { role: "toolResult", content: [{ type: "tool_result", tool_use_id: "tu_1" }] },
        });
        reduceEvent(result, line);
        expect(result.messages).toHaveLength(1);
        expect(result.turns).toBe(0); // tool results don't increment turns
    });

    it("ignores non-JSON lines without throwing", () => {
        const result = makeEmptyResult("worker", "bundled");
        expect(() => reduceEvent(result, "not json")).not.toThrow();
        expect(() => reduceEvent(result, "")).not.toThrow();
        expect(result.turns).toBe(0);
    });

    it("accumulates multiple message_end events", () => {
        const result = makeEmptyResult("worker", "bundled");
        reduceEvent(result, JSON.stringify({ event: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }] }, usage: { input: 5, output: 10 } }));
        reduceEvent(result, JSON.stringify({ event: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second" }] }, usage: { input: 3, output: 7 } }));
        expect(result.turns).toBe(2);
        expect(result.usage.inputTokens).toBe(8);
        expect(result.usage.outputTokens).toBe(17);
        expect(result.messages).toHaveLength(2);
    });

    it("captures errorMessage on error events", () => {
        const result = makeEmptyResult("worker", "bundled");
        reduceEvent(result, JSON.stringify({ event: "error", error: { message: "Something went wrong" } }));
        expect(result.errorMessage).toBe("Something went wrong");
    });
});

describe("mapWithConcurrencyLimit", () => {
    it("preserves input order", async () => {
        const items = [1, 2, 3, 4, 5];
        const result = await mapWithConcurrencyLimit(items, 2, async (n) => n * 2);
        expect(result).toEqual([2, 4, 6, 8, 10]);
    });

    it("never exceeds concurrency limit", async () => {
        let inFlight = 0;
        let peak = 0;
        const items = [1, 2, 3, 4, 5, 6, 7, 8];
        const result = await mapWithConcurrencyLimit(items, 3, async (n) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, 10));
            inFlight--;
            return n;
        });
        expect(result).toHaveLength(8);
        expect(peak).toBeLessThanOrEqual(3);
    });

    it("all items complete", async () => {
        const items = ["a", "b", "c"];
        const result = await mapWithConcurrencyLimit(items, 2, async (s) => s.toUpperCase());
        expect(result).toEqual(["A", "B", "C"]);
    });

    it("handles empty array", async () => {
        const result = await mapWithConcurrencyLimit([], 4, async () => "x");
        expect(result).toEqual([]);
    });
});

describe("capOutput", () => {
    it("returns text unchanged when under cap", () => {
        expect(capOutput("hello", 100)).toBe("hello");
    });

    it("truncates with marker when over cap", () => {
        const text = "a".repeat(100);
        const result = capOutput(text, 10);
        expect(result).toBe("aaaaaaaaaa…(truncated)");
        expect(result.length).toBeLessThan(text.length);
    });

    it("returns text unchanged when exactly at cap", () => {
        expect(capOutput("exact", 5)).toBe("exact");
    });

    it("handles empty string", () => {
        expect(capOutput("", 10)).toBe("");
    });
});

describe("getPiInvocation", () => {
    it("when argv1 is a real script, returns {command: execPath, args: [argv1, ...args]}", () => {
        const result = getPiInvocation(["-p", "--mode", "json"], {
            execPath: "/usr/local/bin/node",
            argv1: "/home/user/.pi/agent/extensions/minion/index.ts",
            existsSync: () => true,
        });
        expect(result).toEqual({
            command: "/usr/local/bin/node",
            args: ["/home/user/.pi/agent/extensions/minion/index.ts", "-p", "--mode", "json"],
        });
    });

    it("when argv1 is bunfs path, returns {command: 'pi', args}", () => {
        const result = getPiInvocation(["--mode", "json"], {
            execPath: "/usr/local/bin/bun",
            argv1: "/$bunfs/root/pi/index.ts",
            existsSync: () => false,
        });
        expect(result).toEqual({
            command: "pi",
            args: ["--mode", "json"],
        });
    });

    it("when runtime is generic node/bun, falls back to pi command", () => {
        const result = getPiInvocation(["task"], {
            execPath: "/usr/local/bin/node",
            argv1: "node",
            existsSync: () => false,
        });
        expect(result).toEqual({
            command: "pi",
            args: ["task"],
        });
    });

    it("passes args through unchanged", () => {
        const result = getPiInvocation(["-p", "--model", "haiku"], {
            execPath: "/usr/bin/node",
            argv1: "/app/index.ts",
            existsSync: () => true,
        });
        expect(result.args).toEqual(["/app/index.ts", "-p", "--model", "haiku"]);
    });
});
