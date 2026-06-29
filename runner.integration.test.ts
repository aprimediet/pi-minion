import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runSingleAgent } from "./runner.ts";
import { discoverAgents } from "./agents.ts";
import type { AgentConfig } from "./agents.ts";

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minion-runner-int-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("runSingleAgent integration (stub spawn)", () => {
	it("runs the stub, accumulates usage, returns exitCode 0 + final text", async () => {
		const stub = `#!/usr/bin/env node
// Stub pi subprocess: emit two NDJSON lines, one assistant message_end with usage, then exit 0.
process.stdout.write(JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		model: "stub-model",
		stopReason: "end",
		usage: { input: 7, output: 11, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 }, totalTokens: 42 },
		content: [{ type: "text", text: "stub output" }],
	},
}) + "\\n");
process.exit(0);
`;
		const stubPath = path.join(tmp, "stub.js");
		fs.writeFileSync(stubPath, stub);
		fs.chmodSync(stubPath, 0o755);

		const agents: AgentConfig[] = [
			{
				name: "stub",
				description: "stub agent",
				systemPrompt: "",
				source: "user",
				filePath: stubPath,
			},
		];

		const result = await runSingleAgent({
			agents,
			agentName: "stub",
			task: "hello",
			cwd: undefined,
			defaultCwd: tmp,
			step: 1,
			signal: undefined,
			onUpdate: undefined,
			spawn: (cmd, args, opts) => {
				// Force the stub to run via node, ignoring the args.
				return require("node:child_process").spawn(process.execPath, [stubPath], {
					cwd: opts?.cwd ?? tmp,
					stdio: ["ignore", "pipe", "pipe"],
				});
			},
			makeDetails: () => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [] }),
		});

		expect(result.exitCode).toBe(0);
		expect(result.usage.input).toBe(7);
		expect(result.usage.output).toBe(11);
		expect(result.usage.cost).toBeCloseTo(0.001, 6);
		expect(result.usage.contextTokens).toBe(42);
		expect(result.usage.turns).toBe(1);
		expect(result.model).toBe("stub-model");
		expect(result.stopReason).toBe("end");
		expect(result.messages).toHaveLength(1);
		// getFinalOutput from render.ts
		const { getFinalOutput } = await import("./render.ts");
		expect(getFinalOutput(result.messages)).toBe("stub output");
	});

	it("returns synthetic failed result for unknown agent", async () => {
		const result = await runSingleAgent({
			agents: [],
			agentName: "ghost",
			task: "anything",
			cwd: undefined,
			defaultCwd: tmp,
			step: undefined,
			signal: undefined,
			onUpdate: undefined,
			spawn: () => {
				throw new Error("spawn must NOT be called for unknown agents");
			},
			makeDetails: () => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [] }),
		});

		expect(result.exitCode).toBe(1);
		expect(result.agentSource).toBe("unknown");
		expect(result.stderr).toContain('Unknown agent: "ghost"');
		expect(result.usage.turns).toBe(0);
	});
});

// Touch discoverAgents to verify the dep graph stays acyclic + the import compiles.
describe("runner imports neighbors", () => {
	it("discoverAgents is reachable", () => {
		expect(typeof discoverAgents).toBe("function");
	});
});