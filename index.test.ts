import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function writeAgentMd(dir: string, name: string, extra: Record<string, unknown> = {}): string {
    const lines = Object.entries({ name, description: `${name} agent`, type: "subagent", ...extra })
        .map(([k, v]) => `${k}: ${v}`);
    const content = `---\n${lines.join("\n")}\n---\nYou are ${name}.`;
    const fp = path.join(dir, `${name}.md`);
    fs.writeFileSync(fp, content, "utf-8");
    return fp;
}

describe("minion extension", () => {
    let pi: any;
    let capturedTools: any[];
    let root: string;

    beforeEach(() => {
        capturedTools = [];
        root = fs.mkdtempSync(path.join(os.tmpdir(), "minion-ext-test-"));
        pi = {
            registerTool: vi.fn((toolDef: any) => {
                capturedTools.push(toolDef);
            }),
            registerCommand: vi.fn(),
            on: vi.fn(),
            registerFlag: vi.fn(),
            getFlag: vi.fn(),
        };
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function getTool(name: string) {
        return capturedTools.find((t: any) => t.name === name);
    }

    function initExtension() {
        // Dynamic import is cached by vitest, so we need fresh per call
        // Use `vi.importActual` or rely on the module being re-imported
        // Actually vitest caches dynamic imports — so call factory with the already-registered tools
    }

    it("registers exactly two tools: delegation and minion_list", async () => {
        const mod = await import("./index.ts");
        mod.default(pi);

        expect(pi.registerTool).toHaveBeenCalledTimes(2);
        const names = capturedTools.map((t: any) => t.name).sort();
        expect(names).toEqual(["delegation", "minion_list"]);
    });

    it("each tool has name, label, description, parameters, execute, renderCall, renderResult", async () => {
        const mod = await import("./index.ts");
        mod.default(pi);

        for (const tool of capturedTools) {
            expect(tool).toHaveProperty("name");
            expect(tool).toHaveProperty("label");
            expect(tool).toHaveProperty("description");
            expect(tool).toHaveProperty("parameters");
            expect(tool).toHaveProperty("execute");
            expect(tool).toHaveProperty("renderCall");
            expect(tool).toHaveProperty("renderResult");
        }
    });

    describe("minion_list execute", () => {
        it("lists project agents with name, source, description", async () => {
            const projAgents = path.join(root, ".pi", "agents");
            fs.mkdirSync(projAgents, { recursive: true });
            writeAgentMd(projAgents, "myagent", { tools: "read, grep" });

            const mod = await import("./index.ts");
            mod.default(pi);

            const tool = getTool("minion_list");
            const ctx = { cwd: root };
            const result = await tool.execute(
                "id",
                { agentScope: "project" },
                new AbortController().signal,
                () => {},
                ctx,
            );

            expect(result.isError).toBeFalsy();
            const text = result.content[0].text;
            expect(text).toContain("myagent");
            expect(text).toContain("project");
            expect(text).toContain("read");
            expect(text).toContain("grep");
            expect(result.details.agents).toHaveLength(1);
            expect(result.details.agents[0].name).toBe("myagent");
            expect(result.details.projectAgentsDir).toBe(projAgents);
        });
    });

    describe("delegation execute", () => {
        it("returns isError when no mode is specified", async () => {
            const mod = await import("./index.ts");
            mod.default(pi);

            const tool = getTool("delegation")!;
            const ctx = { cwd: root, hasUI: false, ui: { confirm: vi.fn() } };
            const result = await tool.execute(
                "id",
                {},
                new AbortController().signal,
                () => {},
                ctx,
            );

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("Available agents");
        });

        it("returns isError when both single and parallel are specified", async () => {
            const mod = await import("./index.ts");
            mod.default(pi);

            const tool = getTool("delegation")!;
            const ctx = { cwd: root, hasUI: false, ui: { confirm: vi.fn() } };
            const result = await tool.execute(
                "id",
                { agent: "worker", task: "do", tasks: [{ agent: "x", task: "y" }] },
                new AbortController().signal,
                () => {},
                ctx,
            );

            expect(result.isError).toBe(true);
        });

        it("prompts for confirmation when project agents are requested", async () => {
            const projAgents = path.join(root, ".pi", "agents");
            fs.mkdirSync(projAgents, { recursive: true });
            writeAgentMd(projAgents, "myagent");

            const mod = await import("./index.ts");
            mod.default(pi);

            const tool = getTool("delegation")!;
            const confirmFn = vi.fn().mockResolvedValue(false);
            const ctx = { cwd: root, hasUI: true, ui: { confirm: confirmFn } };

            const result = await tool.execute(
                "id",
                { agent: "myagent", task: "do something", agentScope: "project" },
                new AbortController().signal,
                () => {},
                ctx,
            );

            expect(confirmFn).toHaveBeenCalled();
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain("Canceled");
        });

        it("proceeds when project confirm is accepted", async () => {
            const projAgents = path.join(root, ".pi", "agents");
            fs.mkdirSync(projAgents, { recursive: true });
            writeAgentMd(projAgents, "myagent");

            const mod = await import("./index.ts");
            mod.default(pi);

            const tool = getTool("delegation")!;
            const confirmFn = vi.fn().mockResolvedValue(true);
            const ctx = { cwd: root, hasUI: true, ui: { confirm: confirmFn } };

            const result = await tool.execute(
                "id",
                { agent: "myagent", task: "do something", agentScope: "project" },
                new AbortController().signal,
                () => {},
                ctx,
            );

            expect(confirmFn).toHaveBeenCalled();
            // Will try to run the agent but since there's no real pi, it will fail
            expect(result.isError).toBe(true);
        });

        it("renders missing tool result content without throwing", async () => {
            const mod = await import("./index.ts");
            mod.default(pi);

            const tool = getTool("delegation")!;
            expect(() => tool.renderResult({ details: undefined }, { expanded: false }, { fg: (_c: string, s: string) => s } as any, {} as any)).not.toThrow();
        });

        it("minion_list renderResult does not throw when content is missing (e.g. empty/partial streaming update)", async () => {
            // Regression: pi's ToolExecutionComponent.updateDisplay calls getTextOutput() on the
            // result payload, which then calls result.content.filter(...) — crashing with
            // "Cannot read properties of undefined (reading 'filter')" if .content is absent.
            // minion_list.renderResult must guard against this.
            const mod = await import("./index.ts");
            mod.default(pi);

            const tool = getTool("minion_list")!;
            // Simulate the exact shape pi would call renderResult with when content is missing.
            // The result type from pi's side is `{ content, details }`; renderResult must not throw
            // when content is undefined.
            const fakeTheme = { fg: (_c: string, s: string) => s } as any;
            expect(() => tool.renderResult({ details: { agents: [] } }, { expanded: false }, fakeTheme, {} as any)).not.toThrow();
            expect(() => tool.renderResult({ details: undefined }, { expanded: false }, fakeTheme, {} as any)).not.toThrow();
            expect(() => tool.renderResult({}, { expanded: false }, fakeTheme, {} as any)).not.toThrow();
        });

        it("delegation wraps streaming updates into tool-result shape (pi tool-result contract)", async () => {
            // Regression: when delegating to a subagent, runSingleAgent emits raw SingleResult
            // via onUpdate. pi's ToolExecutionComponent.updateResult stores it in this.result and
            // then calls getTextOutput() → result.content.filter(...) which crashes with
            // "Cannot read properties of undefined (reading 'filter')". The streaming update
            // contract must be tool-result shape: { content: [{type,text}], details, isError }.
            //
            // Test the actual exported wrapper that delegation.execute uses to satisfy the
            // contract. This is the bug fix; if toToolResultUpdate is removed or regressed,
            // the crash returns.
            const indexMod = await import("./index.ts");
            const { toToolResultUpdate } = indexMod as any;
            expect(typeof toToolResultUpdate).toBe("function");

            const fakeSingleResult: any = {
                agentName: "worker",
                agentSource: "bundled",
                messages: [],
                turns: 1,
                model: "claude-sonnet-4-5",
                stopReason: "end_turn",
                exitCode: 0,
                stderr: "",
                outputText: "hello from worker",
                usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, contextTokens: 0 },
            };
            const wrapped = toToolResultUpdate(fakeSingleResult);
            // The contract assertions — this is what pi's UI depends on:
            expect(wrapped).toHaveProperty("content");
            expect(Array.isArray(wrapped.content)).toBe(true);
            expect(wrapped.content).toHaveLength(1);
            expect(wrapped.content[0]).toHaveProperty("type", "text");
            expect(wrapped.content[0]).toHaveProperty("text", "hello from worker");
            expect(wrapped.details).toBe(fakeSingleResult);
            expect(wrapped.isError).toBe(false);
        });

        it("toToolResultUpdate flags isError when exitCode is non-zero", async () => {
            const indexMod = await import("./index.ts");
            const { toToolResultUpdate } = indexMod as any;
            const failed: any = {
                agentName: "worker",
                agentSource: "bundled",
                messages: [],
                turns: 0,
                model: "",
                stopReason: "",
                exitCode: 1,
                stderr: "boom",
                outputText: "",
                usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, contextTokens: 0 },
            };
            const wrapped = toToolResultUpdate(failed);
            expect(wrapped.isError).toBe(true);
            expect(wrapped.content[0].text).toBe("boom");
        });
    });
});
