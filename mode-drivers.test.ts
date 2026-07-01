import { describe, it, expect, vi } from "vitest";
import { type AgentConfig } from "./agents.ts";
import { runMode, type SingleResult } from "./runner.ts";

function makeAgent(name: string): AgentConfig {
    return { name, description: `Agent ${name}`, source: "bundled" as const, systemPrompt: "", filePath: `/a/${name}.md` };
}

describe("runMode — single", () => {
    it("returns the final output text of the one agent", async () => {
        const fakeRun = vi.fn().mockResolvedValue({
            agentName: "worker",
            agentSource: "bundled",
            outputText: "Task complete!",
            exitCode: 0,
            turns: 1,
        } as SingleResult);

        const result = await runMode(
            "single",
            [makeAgent("worker")],
            { agent: "worker", task: "do it" },
            "/tmp",
            new AbortController().signal,
            () => {},
            fakeRun,
        );

        expect(result.content).toBe("Task complete!");
        expect(result.isError).toBeFalsy();
        expect(fakeRun).toHaveBeenCalledTimes(1);
        expect(fakeRun).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(Array),
            "worker",
            "do it",
            undefined,
            undefined,
            expect.any(AbortSignal),
            expect.any(Function),
        );
    });

    it("returns error result on non-zero exit", async () => {
        const fakeRun = vi.fn().mockResolvedValue({
            agentName: "worker",
            agentSource: "bundled",
            outputText: "",
            exitCode: 1,
            stderr: "Something went wrong",
        } as SingleResult);

        const result = await runMode(
            "single",
            [makeAgent("worker")],
            { agent: "worker", task: "do it" },
            "/tmp",
            new AbortController().signal,
            () => {},
            fakeRun,
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("Something went wrong");
    });
});

describe("runMode — parallel", () => {
    it("runs all tasks under concurrency limit", async () => {
        const calls: string[] = [];
        const fakeRun = vi.fn().mockImplementation(async (_dc, _ag, agent, _task) => {
            calls.push(agent);
            return { agentName: agent, outputText: `${agent} done`, exitCode: 0, turns: 1 } as SingleResult;
        });

        const result = await runMode(
            "parallel",
            [makeAgent("a"), makeAgent("b")],
            { tasks: [{ agent: "a", task: "t1" }, { agent: "b", task: "t2" }] },
            "/tmp",
            new AbortController().signal,
            () => {},
            fakeRun,
        );

        expect(result.isError).toBeFalsy();
        expect(result.content).toContain("a done");
        expect(result.content).toContain("b done");
        expect(fakeRun).toHaveBeenCalledTimes(2);
    });

    it("returns error when tasks exceed MAX_PARALLEL_TASKS", async () => {
        const fakeRun = vi.fn();
        const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: "a", task: `t${i}` }));

        const result = await runMode(
            "parallel",
            [makeAgent("a")],
            { tasks },
            "/tmp",
            new AbortController().signal,
            () => {},
            fakeRun,
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("too many parallel tasks");
        expect(fakeRun).not.toHaveBeenCalled();
    });

    it("caps model-visible output per task", async () => {
        const longOutput = "x".repeat(60 * 1024);
        const fakeRun = vi.fn().mockResolvedValue({
            agentName: "worker",
            outputText: longOutput,
            exitCode: 0,
            turns: 1,
        } as SingleResult);

        const result = await runMode(
            "parallel",
            [makeAgent("worker")],
            { tasks: [{ agent: "worker", task: "long" }] },
            "/tmp",
            new AbortController().signal,
            () => {},
            fakeRun,
        );

        // Content should be capped (50KB per task)
        expect(result.content.length).toBeLessThan(longOutput.length);
        expect(result.content).toContain("…(truncated)");
    });
});

describe("runMode — chain", () => {
    it("passes {previous} between steps", async () => {
        const receivedTasks: string[] = [];
        const fakeRun = vi.fn().mockImplementation(async (_dc, _ag, agent, task) => {
            receivedTasks.push(task);
            return { agentName: agent, outputText: `output from ${agent}`, exitCode: 0, turns: 1 } as SingleResult;
        });

        const result = await runMode(
            "chain",
            [makeAgent("scout"), makeAgent("worker")],
            { chain: [
                { agent: "scout", task: "map the code" },
                { agent: "worker", task: "implement based on {previous}" },
            ]},
            "/tmp",
            new AbortController().signal,
            () => {},
            fakeRun,
        );

        expect(result.isError).toBeFalsy();
        expect(fakeRun).toHaveBeenCalledTimes(2);
        // Second step should have {previous} replaced
        expect(receivedTasks[1]).toBe("implement based on output from scout");
    });

    it("halts on failing step and reports which step/agent", async () => {
        const fakeRun = vi.fn()
            .mockResolvedValueOnce({ agentName: "scout", outputText: "map done", exitCode: 0, turns: 1 } as SingleResult)
            .mockResolvedValueOnce({ agentName: "worker", outputText: "", exitCode: 1, stderr: "build failed", turns: 0 } as SingleResult)
            .mockResolvedValueOnce({ agentName: "reviewer", outputText: "review", exitCode: 0, turns: 1 } as SingleResult);

        const result = await runMode(
            "chain",
            [makeAgent("scout"), makeAgent("worker"), makeAgent("reviewer")],
            { chain: [
                { agent: "scout", task: "s1" },
                { agent: "worker", task: "s2" },
                { agent: "reviewer", task: "s3" },
            ]},
            "/tmp",
            new AbortController().signal,
            () => {},
            fakeRun,
        );

        expect(result.isError).toBe(true);
        expect(result.content).toContain("step 1");
        expect(result.content).toContain("worker");
        expect(fakeRun).toHaveBeenCalledTimes(2); // third step never runs
    });

    it("succeeds when all steps pass", async () => {
        const fakeRun = vi.fn().mockResolvedValue({
            agentName: "worker", outputText: "all good", exitCode: 0, turns: 1,
        } as SingleResult);

        const result = await runMode(
            "chain",
            [makeAgent("worker")],
            { chain: [{ agent: "worker", task: "step1" }, { agent: "worker", task: "step2" }] },
            "/tmp",
            new AbortController().signal,
            () => {},
            fakeRun,
        );

        expect(result.isError).toBeFalsy();
        expect(result.content).toBe("all good");
        expect(fakeRun).toHaveBeenCalledTimes(2);
    });
});
