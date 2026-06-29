import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildExtension } from "./index.ts";
import { emptyUsage } from "./schema.ts";
import type { AgentConfig } from "./agents.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "scout",
		description: "fast recon",
		systemPrompt: "you are scout",
		source: "user",
		filePath: "/tmp/agents/scout.md",
		...overrides,
	};
}

function makeProjectAgent(name: string): AgentConfig {
	return makeAgent({ name, source: "project", filePath: `/tmp/.pi/agents/${name}.md` });
}

interface Captured {
	tools: Map<string, any>;
	commands: Map<string, any>;
}

function mockPi(): { pi: ExtensionAPI; captured: Captured } {
	const captured: Captured = { tools: new Map(), commands: new Map() };
	const pi = {
		registerTool: vi.fn((tool: any) => {
			captured.tools.set(tool.name, tool);
		}),
		registerCommand: vi.fn((name: string, opts: any) => {
			captured.commands.set(name, opts);
		}),
		on: vi.fn(),
		registerFlag: vi.fn(),
		registerShortcut: vi.fn(),
		getFlag: vi.fn(),
		events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
	} as unknown as ExtensionAPI;
	return { pi, captured };
}

function ctx(overrides: Partial<{ cwd: string; hasUI: boolean }> = {}) {
	const c = {
		cwd: overrides.cwd ?? "/tmp",
		hasUI: overrides.hasUI ?? false,
		ui: {
			confirm: vi.fn(async () => false),
			notify: vi.fn(),
			select: vi.fn(async () => undefined),
			input: vi.fn(async () => undefined),
		},
		mode: "tui" as const,
		sessionManager: {} as any,
		modelRegistry: {} as any,
		model: undefined,
		isIdle: () => true,
		isProjectTrusted: () => false,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};
	return c;
}

function makeCommandCtx(cwd: string): ExtensionCommandContext {
	return {
		...ctx({ cwd }),
		ui: {
			...ctx({ cwd }).ui,
			confirm: vi.fn(async () => true),
		},
		getSystemPromptOptions: () => ({}) as any,
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
	} as unknown as ExtensionCommandContext;
}

describe("buildExtension — wiring", () => {
	it("registers a tool named 'subagent' and a /minion command", () => {
		const { pi, captured } = mockPi();
		buildExtension(pi, {
			discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
			runAgentFn: vi.fn(),
			readOverrides: () => ({}),
		});
		expect(captured.tools.has("subagent")).toBe(true);
		expect(captured.commands.has("minion")).toBe(true);
	});

	it("description tells the model to call {list:true} first", () => {
		const { pi, captured } = mockPi();
		buildExtension(pi, {
			discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
			runAgentFn: vi.fn(),
			readOverrides: () => ({}),
		});
		const tool = captured.tools.get("subagent");
		expect(tool.description).toMatch(/\{?\s*list\s*:?\s*true\s*\}?/i);
	});
});

describe("subagent tool — list mode", () => {
	it("returns roster text and does NOT call runner", async () => {
		const { pi, captured } = mockPi();
		const runAgentFn = vi.fn();
		buildExtension(pi, {
			discoverAgents: () => ({
				agents: [makeAgent({ name: "scout" }), makeAgent({ name: "worker" })],
				projectAgentsDir: null,
			}),
			runAgentFn,
			readOverrides: () => ({}),
		});
		const tool = captured.tools.get("subagent");
		const out = await tool.execute("tc-1", { list: true }, undefined, undefined, ctx());
		expect(runAgentFn).not.toHaveBeenCalled();
		expect(out.content[0].text).toMatch(/scout \(user\)/);
		expect(out.content[0].text).toMatch(/worker \(user\)/);
	});

	it("returns 'none' text when discovery is empty", async () => {
		const { pi, captured } = mockPi();
		buildExtension(pi, {
			discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
			runAgentFn: vi.fn(),
			readOverrides: () => ({}),
		});
		const tool = captured.tools.get("subagent");
		const out = await tool.execute("tc-1", { list: true }, undefined, undefined, ctx());
		expect(out.content[0].text).toBe("none");
	});
});

describe("subagent tool — invalid mode", () => {
	it("returns invalid-args result when zero modes provided", async () => {
		const { pi, captured } = mockPi();
		const runAgentFn = vi.fn();
		buildExtension(pi, {
			discoverAgents: () => ({ agents: [makeAgent()], projectAgentsDir: null }),
			runAgentFn,
			readOverrides: () => ({}),
		});
		const tool = captured.tools.get("subagent");
		const out = await tool.execute("tc-1", {}, undefined, undefined, ctx());
		expect(runAgentFn).not.toHaveBeenCalled();
		expect(out.content[0].text).toMatch(/Invalid parameters/);
	});

	it("returns invalid-args result when 2+ modes provided", async () => {
		const { pi, captured } = mockPi();
		const runAgentFn = vi.fn();
		buildExtension(pi, {
			discoverAgents: () => ({ agents: [makeAgent()], projectAgentsDir: null }),
			runAgentFn,
			readOverrides: () => ({}),
		});
		const tool = captured.tools.get("subagent");
		const out = await tool.execute(
			"tc-1",
			{ agent: "scout", task: "x", tasks: [{ agent: "scout", task: "x" }] },
			undefined,
			undefined,
			ctx(),
		);
		expect(runAgentFn).not.toHaveBeenCalled();
		expect(out.content[0].text).toMatch(/Invalid parameters/);
	});
});

describe("subagent tool — project agent gate", () => {
	it("calls ctx.ui.confirm when scope=both and requested agent is project", async () => {
		const { pi, captured } = mockPi();
		const runAgentFn = vi.fn(async () => ({
			agent: "scout",
			agentSource: "project" as const,
			task: "t",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] } as any],
			stderr: "",
			usage: emptyUsage(),
		}));
		buildExtension(pi, {
			discoverAgents: () => ({
				agents: [makeProjectAgent("scout")],
				projectAgentsDir: "/tmp/.pi/agents",
			}),
			runAgentFn,
			readOverrides: () => ({}),
		});
		const tool = captured.tools.get("subagent");
		const c = ctx({ hasUI: true });
		(c.ui.confirm as any).mockResolvedValueOnce(true);
		await tool.execute("tc-1", { agent: "scout", task: "t", agentScope: "both" }, undefined, undefined, c);
		expect(c.ui.confirm).toHaveBeenCalledOnce();
		expect(runAgentFn).toHaveBeenCalledOnce();
	});

	it("returns canceled result when confirm is rejected; runner not called", async () => {
		const { pi, captured } = mockPi();
		const runAgentFn = vi.fn();
		buildExtension(pi, {
			discoverAgents: () => ({
				agents: [makeProjectAgent("scout")],
				projectAgentsDir: "/tmp/.pi/agents",
			}),
			runAgentFn,
			readOverrides: () => ({}),
		});
		const tool = captured.tools.get("subagent");
		const c = ctx({ hasUI: true });
		(c.ui.confirm as any).mockResolvedValueOnce(false);
		const out = await tool.execute(
			"tc-1",
			{ agent: "scout", task: "t", agentScope: "both" },
			undefined,
			undefined,
			c,
		);
		expect(runAgentFn).not.toHaveBeenCalled();
		expect(out.content[0].text).toMatch(/Canceled/);
	});

	it("skips confirm when confirmProjectAgents === false", async () => {
		const { pi, captured } = mockPi();
		const runAgentFn = vi.fn(async () => ({
			agent: "scout",
			agentSource: "project" as const,
			task: "t",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] } as any],
			stderr: "",
			usage: emptyUsage(),
		}));
		buildExtension(pi, {
			discoverAgents: () => ({
				agents: [makeProjectAgent("scout")],
				projectAgentsDir: "/tmp/.pi/agents",
			}),
			runAgentFn,
			readOverrides: () => ({}),
		});
		const tool = captured.tools.get("subagent");
		const c = ctx({ hasUI: true });
		await tool.execute(
			"tc-1",
			{ agent: "scout", task: "t", agentScope: "both", confirmProjectAgents: false },
			undefined,
			undefined,
			c,
		);
		expect(c.ui.confirm).not.toHaveBeenCalled();
		expect(runAgentFn).toHaveBeenCalledOnce();
	});

	it("does NOT call confirm when hasUI is false", async () => {
		const { pi, captured } = mockPi();
		const runAgentFn = vi.fn(async () => ({
			agent: "scout",
			agentSource: "project" as const,
			task: "t",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] } as any],
			stderr: "",
			usage: emptyUsage(),
		}));
		buildExtension(pi, {
			discoverAgents: () => ({
				agents: [makeProjectAgent("scout")],
				projectAgentsDir: "/tmp/.pi/agents",
			}),
			runAgentFn,
			readOverrides: () => ({}),
		});
		const tool = captured.tools.get("subagent");
		const c = ctx({ hasUI: false });
		await tool.execute(
			"tc-1",
			{ agent: "scout", task: "t", agentScope: "both" },
			undefined,
			undefined,
			c,
		);
		expect(c.ui.confirm).not.toHaveBeenCalled();
		expect(runAgentFn).toHaveBeenCalledOnce();
	});

	it("does NOT call confirm when scope=user (even with project agents requested)", async () => {
		const { pi, captured } = mockPi();
		const runAgentFn = vi.fn(async () => ({
			agent: "scout",
			agentSource: "project" as const,
			task: "t",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] } as any],
			stderr: "",
			usage: emptyUsage(),
		}));
		buildExtension(pi, {
			discoverAgents: () => ({
				// scope=user — discovery hides project agents, so none match requested name
				agents: [makeAgent({ name: "scout", source: "user" })],
				projectAgentsDir: "/tmp/.pi/agents",
			}),
			runAgentFn,
			readOverrides: () => ({}),
		});
		const tool = captured.tools.get("subagent");
		const c = ctx({ hasUI: true });
		await tool.execute("tc-1", { agent: "scout", task: "t" }, undefined, undefined, c);
		expect(c.ui.confirm).not.toHaveBeenCalled();
		expect(runAgentFn).toHaveBeenCalledOnce();
	});
});

describe("subagent tool — dispatch", () => {
	let calls: Array<{ mode: string; agent?: string; task?: string }>;

	beforeEach(() => {
		calls = [];
	});

	function setup(agents: AgentConfig[]) {
		const { pi, captured } = mockPi();
		const runAgentFn = vi.fn(async (req: any) => {
			calls.push({ mode: "single", agent: req.agentName, task: req.task });
			return {
				agent: req.agentName,
				agentSource: "user" as const,
				task: req.task,
				exitCode: 0,
				messages: [
					{ role: "assistant", content: [{ type: "text", text: `out-${req.agentName}` }] } as any,
				],
				stderr: "",
				usage: emptyUsage(),
			};
		});
		buildExtension(pi, {
			discoverAgents: () => ({ agents, projectAgentsDir: null }),
			runAgentFn,
			readOverrides: () => ({}),
		});
		return { pi, captured, runAgentFn };
	}

	it("dispatches single mode to runner", async () => {
		const { captured } = setup([makeAgent({ name: "scout" })]);
		const out = await captured.tools.get("subagent").execute(
			"tc-1",
			{ agent: "scout", task: "find X" },
			undefined,
			undefined,
			ctx(),
		);
		expect(out.details.mode).toBe("single");
		expect(calls).toEqual([{ mode: "single", agent: "scout", task: "find X" }]);
	});

	it("dispatches parallel mode to runner for each task", async () => {
		const { captured } = setup([
			makeAgent({ name: "scout" }),
			makeAgent({ name: "planner" }),
		]);
		const out = await captured.tools.get("subagent").execute(
			"tc-1",
			{ tasks: [{ agent: "scout", task: "a" }, { agent: "planner", task: "b" }] },
			undefined,
			undefined,
			ctx(),
		);
		expect(out.details.mode).toBe("parallel");
		expect(calls.map((c) => `${c.agent}:${c.task}`)).toEqual(["scout:a", "planner:b"]);
	});

	it("dispatches chain mode to runner per step in order", async () => {
		const { captured } = setup([
			makeAgent({ name: "scout" }),
			makeAgent({ name: "planner" }),
		]);
		const out = await captured.tools.get("subagent").execute(
			"tc-1",
			{ chain: [{ agent: "scout", task: "first" }, { agent: "planner", task: "plan: {previous}" }] },
			undefined,
			undefined,
			ctx(),
		);
		expect(out.details.mode).toBe("chain");
		expect(calls.map((c) => c.task)).toEqual(["first", "plan: out-scout"]);
	});
});

describe("/minion command", () => {
	it("'list' subcommand prints roster to UI notify", async () => {
		const { pi, captured } = mockPi();
		buildExtension(pi, {
			discoverAgents: () => ({
				agents: [makeAgent({ name: "scout" }), makeAgent({ name: "worker" })],
				projectAgentsDir: null,
			}),
			runAgentFn: vi.fn(),
			readOverrides: () => ({}),
		});
		const cmd = captured.commands.get("minion");
		const c = makeCommandCtx("/tmp");
		await cmd.handler("list", c);
		expect((c.ui as any).notify).toHaveBeenCalled();
		const msg = (c.ui as any).notify.mock.calls[0][0];
		expect(msg).toMatch(/scout \(user\)/);
		expect(msg).toMatch(/worker \(user\)/);
	});
});