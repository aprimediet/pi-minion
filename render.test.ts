import { describe, it, expect } from "vitest";
import { renderCall, renderResult } from "./render.ts";

function fakeTheme() {
    return {
        fg: (_color: string, s: string) => s,
        bold: (s: string) => s,
    };
}

describe("renderCall", () => {
    it("returns a Text node for single mode without throwing", () => {
        const node = renderCall({ agent: "worker", task: "do something", agentScope: "all" }, fakeTheme(), {} as any);
        expect(node).toBeTruthy();
        // Should contain the agent name
    });

    it("returns a Text node for parallel mode", () => {
        const node = renderCall({ tasks: [{ agent: "a", task: "t1" }, { agent: "b", task: "t2" }] }, fakeTheme(), {} as any);
        expect(node).toBeTruthy();
    });

    it("returns a Text node for chain mode", () => {
        const node = renderCall({ chain: [{ agent: "a", task: "s1" }, { agent: "b", task: "s2" }] }, fakeTheme(), {} as any);
        expect(node).toBeTruthy();
    });
});

describe("renderResult", () => {
    it("renders single mode result without throwing", () => {
        const result = {
            content: [{ type: "text", text: "done" }],
            details: {
                mode: "single",
                results: [{ agentName: "worker", agentSource: "bundled", exitCode: 0, outputText: "Task complete!", usage: { inputTokens: 10, outputTokens: 20, cost: 0.002, turns: 1 } }],
            },
        };
        const node = renderResult(result, { expanded: false }, fakeTheme(), {} as any);
        expect(node).toBeTruthy();
    });

    it("renders chain mode result without throwing", () => {
        const result = {
            content: [{ type: "text", text: "chain done" }],
            details: {
                mode: "chain",
                results: [
                    { agentName: "scout", exitCode: 0, outputText: "map done" },
                    { agentName: "worker", exitCode: 0, outputText: "impl done" },
                ],
            },
        };
        const node = renderResult(result, { expanded: false }, fakeTheme(), {} as any);
        expect(node).toBeTruthy();
    });

    it("handles empty result gracefully", () => {
        const result = { content: [{ type: "text", text: "nothing" }], details: undefined };
        const node = renderResult(result, { expanded: false }, fakeTheme(), {} as any);
        expect(node).toBeTruthy();
    });

    it("renders expanded single mode without throwing", () => {
        const result = {
            content: [{ type: "text", text: "expanded" }],
            details: {
                mode: "single",
                results: [{ agentName: "worker", exitCode: 0, outputText: "# Output\n\nSome markdown content", usage: { inputTokens: 5, outputTokens: 10, cost: 0.001, turns: 1 } }],
            },
        };
        const node = renderResult(result, { expanded: true }, fakeTheme(), {} as any);
        expect(node).toBeTruthy();
    });
});
