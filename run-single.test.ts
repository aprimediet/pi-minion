import { describe, it, expect, vi } from "vitest";
import { type AgentConfig } from "./agents.ts";
import { runSingleAgent } from "./runner.ts";

function makeAgent(name: string): AgentConfig {
    return { name, description: `Agent ${name}`, source: "bundled", systemPrompt: "be helpful", filePath: `/a/${name}.md` };
}

describe("runSingleAgent — unknown agent", () => {
    it("returns exitCode 1 with stderr listing available agents when agent not found", async () => {
        const agents = [makeAgent("worker"), makeAgent("scout")];
        const fakeSpawn = vi.fn(); // should not be called

        const result = await runSingleAgent(
            "/tmp",
            agents,
            "nonexistent",
            "do something",
            "/tmp/cwd",
            undefined,
            new AbortController().signal,
            () => {},
            { spawn: fakeSpawn as any },
        );

        expect(result.exitCode).toBe(1);
        expect(result.agentSource).toBe("unknown");
        expect(result.stderr).toContain("worker");
        expect(result.stderr).toContain("scout");
        expect(result.stderr).toContain("nonexistent");
        expect(fakeSpawn).not.toHaveBeenCalled();
    });
});

describe("runSingleAgent — happy path", () => {
    function makeFakeSpawn() {
        const onData: Array<(chunk: string) => void> = [];
        const onClose: Array<(code: number) => void> = [];
        const onError: Array<(err: Error) => void> = [];

        const fakeSpawn = vi.fn().mockReturnValue({
            stdout: {
                on: vi.fn((event: string, handler: any) => {
                    if (event === "data") onData.push(handler);
                }),
            },
            stderr: {
                on: vi.fn((event: string, handler: any) => {
                    if (event === "data") onData.push(handler);
                }),
            },
            on: vi.fn((event: string, handler: any) => {
                if (event === "close") onClose.push(handler);
                if (event === "error") onError.push(handler);
            }),
            kill: vi.fn(),
        });

        function emitLine(line: string) {
            for (const cb of onData) cb(line + "\n");
        }

        function emitClose(code: number) {
            for (const cb of onClose) cb(code);
        }

        function emitError(err: Error) {
            for (const cb of onError) cb(err);
        }

        return { fakeSpawn, emitLine, emitClose, emitError };
    }

    it("emits events and returns aggregated result on clean exit", async () => {
        const agents = [
            { name: "worker", description: "Worker", source: "bundled" as const, systemPrompt: "", filePath: "/a/worker.md" },
        ];
        const { fakeSpawn, emitLine, emitClose } = makeFakeSpawn();
        const updates: any[] = [];

        const promise = runSingleAgent(
            "/tmp",
            agents,
            "worker",
            "do task",
            "/tmp/cwd",
            undefined,
            new AbortController().signal,
            (u) => updates.push(u),
            { spawn: fakeSpawn as any },
        );

        // emit two assistant messages then close
        emitLine(JSON.stringify({ event: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] }, usage: { input: 10, output: 20 } }));
        emitLine(JSON.stringify({ event: "message_end", message: { role: "assistant", content: [{ type: "text", text: "world" }] }, usage: { input: 5, output: 8 } }));
        emitClose(0);

        const result = await promise;
        expect(result.exitCode).toBe(0);
        expect(result.turns).toBe(2);
        expect(result.usage.inputTokens).toBe(15);
        expect(result.usage.outputTokens).toBe(28);
        expect(result.messages).toHaveLength(2);
        expect(result.outputText).toBe("world");
        expect(updates.length).toBeGreaterThan(0);
    });

    it("captures stderr on non-zero exit", async () => {
        const agents = [
            { name: "worker", description: "Worker", source: "bundled" as const, systemPrompt: "", filePath: "/a/worker.md" },
        ];
        const { fakeSpawn, emitLine, emitClose } = makeFakeSpawn();

        const promise = runSingleAgent(
            "/tmp",
            agents,
            "worker",
            "task",
            "/tmp/cwd",
            undefined,
            new AbortController().signal,
            () => {},
            { spawn: fakeSpawn as any },
        );

        emitLine(JSON.stringify({ event: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }] }, usage: { input: 5, output: 5 } }));
        emitClose(1);

        const result = await promise;
        expect(result.exitCode).toBe(1);
        expect(result.turns).toBe(1);
    });
});

describe("runSingleAgent — abort", () => {
    function makeFakeSpawn() {
        const onData: Array<(chunk: string) => void> = [];
        const onClose: Array<(code: number) => void> = [];
        const onError: Array<(err: Error) => void> = [];

        const fakeSpawn = vi.fn().mockReturnValue({
            stdout: {
                on: vi.fn((event: string, handler: any) => {
                    if (event === "data") onData.push(handler);
                }),
            },
            stderr: {
                on: vi.fn((event: string, handler: any) => {
                    if (event === "data") onData.push(handler);
                }),
            },
            on: vi.fn((event: string, handler: any) => {
                if (event === "close") onClose.push(handler);
                if (event === "error") onError.push(handler);
            }),
            kill: vi.fn(),
            killed: false,
        });

        function emitLine(line: string) {
            for (const cb of onData) cb(line + "\n");
        }

        function emitClose(code: number) {
            for (const cb of onClose) cb(code);
        }

        return { fakeSpawn, emitLine, emitClose, fakeProcess: fakeSpawn.mock.results[0]?.value };
    }

    it("aborts mid-run and calls kill", async () => {
        const agents = [
            { name: "worker", description: "Worker", source: "bundled" as const, systemPrompt: "", filePath: "/a/worker.md" },
        ];
        const { fakeSpawn } = makeFakeSpawn();
        const abortController = new AbortController();

        const promise = runSingleAgent(
            "/tmp",
            agents,
            "worker",
            "task",
            "/tmp/cwd",
            undefined,
            abortController.signal,
            () => {},
            { spawn: fakeSpawn as any },
        );

        // Abort before process finishes
        abortController.abort();

        await expect(promise).rejects.toThrow("aborted");
        expect(fakeSpawn).toHaveBeenCalled();
        const proc = fakeSpawn.mock.results[0]?.value;
        expect(proc.kill).toHaveBeenCalled();
    });

    it("pre-aborted signal rejects immediately", async () => {
        const agents = [
            { name: "worker", description: "Worker", source: "bundled" as const, systemPrompt: "", filePath: "/a/worker.md" },
        ];
        const { fakeSpawn } = makeFakeSpawn();
        const aborted = AbortSignal.abort();

        const promise = runSingleAgent(
            "/tmp",
            agents,
            "worker",
            "task",
            "/tmp/cwd",
            undefined,
            aborted,
            () => {},
            { spawn: fakeSpawn as any },
        );

        await expect(promise).rejects.toThrow("aborted");
    });
});
