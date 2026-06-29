import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { buildExtension, defaultExtension } from "./index.ts";
import { createPrimaryController, type PrimaryAgent } from "./primaries.ts";
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
		type: "subagent",
		...overrides,
	};
}

function makeProjectAgent(name: string): AgentConfig {
	return makeAgent({ name, source: "project", filePath: `/tmp/.pi/agents/${name}.md` });
}

interface Captured {
	tools: Map<string, any>;
	commands: Map<string, any>;
	flags: Map<string, any>;
	shortcuts: Map<string, { description?: string; handler: any }>;
	handlers: Map<string, Array<(event: any, ctx: any) => any>>;
	flagValues: Map<string, any>;
}

function mockPi(flagDefaults: Record<string, string | boolean> = {}): { pi: ExtensionAPI; captured: Captured } {
	const captured: Captured = {
		tools: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		handlers: new Map(),
		flagValues: new Map(Object.entries(flagDefaults)),
	};
	const pi = {
		registerTool: vi.fn((tool: any) => {
			captured.tools.set(tool.name, tool);
		}),
		registerCommand: vi.fn((name: string, opts: any) => {
			captured.commands.set(name, opts);
		}),
		registerFlag: vi.fn((name: string, opts: any) => {
			captured.flags.set(name, opts);
		}),
		registerShortcut: vi.fn((shortcut: string, opts: any) => {
			captured.shortcuts.set(shortcut, opts);
		}),
		getFlag: vi.fn((name: string) => captured.flagValues.get(name)),
		on: vi.fn((event: string, handler: any) => {
			const list = captured.handlers.get(event) ?? [];
			list.push(handler);
			captured.handlers.set(event, list);
		}),
		setActiveTools: vi.fn(),
		setModel: vi.fn(async () => true),
		getActiveTools: vi.fn(() => ["read", "bash", "edit", "write"]),
		getAllTools: vi.fn(() => [
			{ name: "read" },
			{ name: "grep" },
			{ name: "find" },
			{ name: "ls" },
			{ name: "bash" },
			{ name: "edit" },
			{ name: "write" },
		]),
		getThinkingLevel: vi.fn(() => "off" as const),
		setThinkingLevel: vi.fn(),
		setStatus: vi.fn(),
		appendEntry: vi.fn(),
		ui: { notify: vi.fn(), setStatus: vi.fn() },
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
			setStatus: vi.fn(),
		},
		mode: "tui" as const,
		sessionManager: { getEntries: vi.fn(() => []) } as any,
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
	const base = ctx({ cwd });
	return {
		...base,
		ui: {
			...base.ui,
			confirm: vi.fn(async () => true),
			setStatus: vi.fn(),
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

// =============================================================================
// v2.1 — Primary agents wiring tests
// =============================================================================
//
// These tests cover the extension's new flag/commands/shortcuts/event handlers
// for primary-agent switching. The controller itself is unit-tested in
// primaries.test.ts; here we only assert that `buildExtension` wires the
// ExtensionAPI surface correctly and that the subagent tool excludes primaries.

describe("/minion command (v2.1)", () => {
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

// ---------------------------------------------------------------------------
// v2.1 — Primary-agent wiring
// ---------------------------------------------------------------------------

function buildWithPrimaries(extra: Parameters<typeof buildExtension>[1] = {}) {
	const emptyPrimaries: PrimaryAgent[] = [];
	return {
		pi: undefined as unknown as ExtensionAPI,
		captured: undefined as unknown as Captured,
		...buildExtensionWithPrimaries(emptyPrimaries, extra),
	};
}

function buildExtensionWithPrimaries(
	bundledPrimaries: PrimaryAgent[],
	extra: Partial<Parameters<typeof buildExtension>[1]> = {},
) {
	const { pi, captured } = mockPi();
	const loadPrimaries = vi.fn(() => bundledPrimaries);
	buildExtension(pi, {
		discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
		runAgentFn: vi.fn(),
		readOverrides: () => ({}),
		loadPrimaries: loadPrimaries as never,
		...extra,
	});
	return { pi, captured, loadPrimaries };
}

describe("v2.1 — CLI flag + shortcuts", () => {
	it("registers an 'agent' flag of type string", () => {
		const { pi, captured } = mockPi();
		buildExtension(pi, {
			discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
			runAgentFn: vi.fn(),
			readOverrides: () => ({}),
		});
		const f = captured.flags.get("agent");
		expect(f).toBeDefined();
		expect(f.type).toBe("string");
		expect(f.description).toMatch(/plan|build|primary/i);
	});

	it("registers a primary-cycle shortcut on shift+tab (requires user keybindings.json override of app.thinking.cycle)", () => {
		const { captured } = buildExtensionWithPrimaries([]);
		// controller.cycle handler is closed-over; assert shortcut binding exists.
		const scKeys = Array.from(captured.shortcuts.keys());
		// The Key helper produces a literal string token (see keys.d.ts in pi-tui).
		// We bind shift+tab per O2 in docs/v2.1/design.md. At runtime, the
		// extension binding is silently dropped unless the user has freed the
		// key by remapping app.thinking.cycle in keybindings.json — see the
		// comment at the top of primaries.ts.
		expect(scKeys).toContain("shift+tab");
		// Sanity: we no longer register ctrl+shift+p (that key collides with
		// pi's app.model.cycleBackward, also in RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS).
		expect(scKeys).not.toContain("ctrl+shift+p");
	});

	it("registers a thinking-cycle shortcut on alt+t", () => {
		const { captured } = buildExtensionWithPrimaries([]);
		const scKeys = Array.from(captured.shortcuts.keys());
		expect(scKeys).toContain("alt+t");
	});
});

describe("v2.1 — /plan and /build commands", () => {
	it("both commands are registered with descriptions", () => {
		const { captured } = buildExtensionWithPrimaries([]);
		expect(captured.commands.has("plan")).toBe(true);
		expect(captured.commands.has("build")).toBe(true);
	});
});

describe("v2.1 — /minion subcommands", () => {
	it("'primaries' lists switchable primaries to UI notify", async () => {
		const bundled: PrimaryAgent[] = [
			{
				name: "build",
				description: "full capability",
				systemPrompt: "be build",
				source: "bundled",
				filePath: "/bundled/build.md",
			},
			{
				name: "plan",
				description: "read-only",
				tools: ["read", "grep", "find", "ls"],
				systemPrompt: "be plan",
				source: "bundled",
				filePath: "/bundled/plan.md",
			},
		];
		const { captured } = buildExtensionWithPrimaries(bundled);
		const cmd = captured.commands.get("minion");
		const c = makeCommandCtx("/tmp");
		await cmd.handler("primaries", c);
		expect((c.ui as any).notify).toHaveBeenCalled();
		const msg = (c.ui as any).notify.mock.calls[0][0];
		expect(msg).toMatch(/build/);
		expect(msg).toMatch(/plan/);
	});

	it("dispatches bare name to controller.apply via /minion <name>", async () => {
		const bundled: PrimaryAgent[] = [
			{
				name: "build",
				description: "full capability",
				systemPrompt: "be build",
				source: "bundled",
				filePath: "/bundled/build.md",
			},
		];
		const { pi, captured } = buildExtensionWithPrimaries(bundled);
		const cmd = captured.commands.get("minion");
		const c = makeCommandCtx("/tmp");
		await cmd.handler("build", c);
		// Status update should reflect the active primary via ctx.ui.setStatus().
		const setStatusMock = (c.ui as any).setStatus as ReturnType<typeof vi.fn>;
		const last = setStatusMock.mock.calls.at(-1);
		expect(last?.[0]).toBe("minion");
		expect(last?.[1]).toMatch(/primary:build/);
	});
});

describe("v2.1 — before_agent_start handler", () => {
	it("registers a handler for before_agent_start", async () => {
		const { captured } = buildExtensionWithPrimaries([]);
		expect(captured.handlers.has("before_agent_start")).toBe(true);
	});

	it("returns injected systemPrompt when a primary is active", async () => {
		const bundled: PrimaryAgent[] = [
			{
				name: "build",
				description: "d",
				systemPrompt: "be build",
				source: "bundled",
				filePath: "/bundled/build.md",
			},
		];
		const { captured } = buildExtensionWithPrimaries(bundled);
		// First make `build` active via session_start (no flag, no entry → default)
		const ss = captured.handlers.get("session_start")?.[0];
		await ss?.({ type: "session_start", reason: "startup" }, makeCommandCtx("/tmp"));

		const ba = captured.handlers.get("before_agent_start")?.[0];
		const out = await ba?.(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "BASE" } as never,
			ctx(),
		);
		expect(out).toBeDefined();
		expect(out.systemPrompt).toMatch(/^BASE\n\nbe build$/);
	});

	it("returns undefined when no primary is active (no session_start yet)", async () => {
		const { captured } = buildExtensionWithPrimaries([]);
		const ba = captured.handlers.get("before_agent_start")?.[0];
		const out = await ba?.(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "BASE" } as never,
			ctx(),
		);
		expect(out).toBeUndefined();
	});
});

describe("v2.1 — session_start handler", () => {
	it("applies --agent flag when valid", async () => {
		const bundled: PrimaryAgent[] = [
			{ name: "build", description: "b", systemPrompt: "b", source: "bundled", filePath: "/b.md" },
			{ name: "plan", description: "p", systemPrompt: "p", source: "bundled", filePath: "/p.md" },
		];
		// Use a fresh mockPi with the --agent flag pre-set.
		const { pi, captured } = mockPi({ agent: "plan" });
		buildExtension(pi, {
			discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
			runAgentFn: vi.fn(),
			readOverrides: () => ({}),
			loadPrimaries: vi.fn(() => bundled) as never,
		});
		const ss = captured.handlers.get("session_start")?.[0];
		const c = makeCommandCtx("/tmp");
		await ss?.({ type: "session_start", reason: "startup" }, c);
		const setStatusMock = (c.ui as any).setStatus as ReturnType<typeof vi.fn>;
		const last = setStatusMock.mock.calls.at(-1);
		expect(last?.[0]).toBe("minion");
		expect(last?.[1]).toMatch(/primary:plan/);
	});

	it("restores last active primary from session entries when no --agent flag", async () => {
		const bundled: PrimaryAgent[] = [
			{ name: "build", description: "b", systemPrompt: "b", source: "bundled", filePath: "/b.md" },
			{ name: "plan", description: "p", systemPrompt: "p", source: "bundled", filePath: "/p.md" },
		];
		const { pi, captured } = mockPi();
		buildExtension(pi, {
			discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
			runAgentFn: vi.fn(),
			readOverrides: () => ({}),
			loadPrimaries: vi.fn(() => bundled) as never,
		});
		const c = makeCommandCtx("/tmp");
		// Fake a minion-primary restored entry
		(c.sessionManager as any).getEntries = () => [
			{ type: "custom", customType: "minion-primary", data: { name: "plan" } },
		];
		const ss = captured.handlers.get("session_start")?.[0];
		await ss?.({ type: "session_start", reason: "resume" }, c);
		const setStatusMock = (c.ui as any).setStatus as ReturnType<typeof vi.fn>;
		const last = setStatusMock.mock.calls.at(-1);
		expect(last?.[1]).toMatch(/primary:plan/);
	});

	it("falls back to default 'build' when neither flag nor restored entry", async () => {
		const bundled: PrimaryAgent[] = [
			{ name: "build", description: "b", systemPrompt: "b", source: "bundled", filePath: "/b.md" },
			{ name: "plan", description: "p", systemPrompt: "p", source: "bundled", filePath: "/p.md" },
		];
		const { pi, captured } = mockPi();
		buildExtension(pi, {
			discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
			runAgentFn: vi.fn(),
			readOverrides: () => ({}),
			loadPrimaries: vi.fn(() => bundled) as never,
		});
		const c = makeCommandCtx("/tmp");
		(c.sessionManager as any).getEntries = () => [];
		const ss = captured.handlers.get("session_start")?.[0];
		await ss?.({ type: "session_start", reason: "startup" }, c);
		const setStatusMock = (c.ui as any).setStatus as ReturnType<typeof vi.fn>;
		const last = setStatusMock.mock.calls.at(-1);
		expect(last?.[1]).toMatch(/primary:build/);
	});
});

describe("v2.1 — model_select handler", () => {
	it("calls controller.onModelChanged with the selected model", async () => {
		const bundled: PrimaryAgent[] = [
			{ name: "build", description: "b", systemPrompt: "b", source: "bundled", filePath: "/b.md" },
		];
		// Spy on onModelChanged via a wrapper _createPrimaryController.
		let observed: unknown[] = [];
		const { pi, captured } = mockPi();
		buildExtension(pi, {
			discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
			runAgentFn: vi.fn(),
			readOverrides: () => ({}),
			loadPrimaries: vi.fn(() => bundled) as never,
			_createPrimaryController: (realPi, primaries, opts) => {
				const c = createPrimaryController(realPi as never, primaries, opts);
				return {
					...c,
					onModelChanged(model, ctx2) {
						observed.push(model);
						return c.onModelChanged(model, ctx2);
					},
				} as never;
			},
		});
		// Activate a primary first
		const ss = captured.handlers.get("session_start")?.[0];
		await ss?.({ type: "session_start", reason: "startup" }, makeCommandCtx("/tmp"));
		observed = [];

		const ms = captured.handlers.get("model_select")?.[0];
		const fakeModel = { id: "claude-opus-4-5" };
		await ms?.({ type: "model_select", model: fakeModel, previousModel: undefined, source: "set" }, makeCommandCtx("/tmp"));
		expect(observed).toHaveLength(1);
		expect((observed[0] as { id: string }).id).toBe("claude-opus-4-5");
	});
});

describe("v2.1 — turn_start handler", () => {
	it("appends a minion-primary entry when a primary is active", async () => {
		const bundled: PrimaryAgent[] = [
			{ name: "build", description: "b", systemPrompt: "b", source: "bundled", filePath: "/b.md" },
		];
		const { pi, captured } = mockPi();
		buildExtension(pi, {
			discoverAgents: () => ({ agents: [], projectAgentsDir: null }),
			runAgentFn: vi.fn(),
			readOverrides: () => ({}),
			loadPrimaries: vi.fn(() => bundled) as never,
		});
		const c = makeCommandCtx("/tmp");
		const ss = captured.handlers.get("session_start")?.[0];
		await ss?.({ type: "session_start", reason: "startup" }, c);
		(pi as any).appendEntry.mockClear();

		const ts = captured.handlers.get("turn_start")?.[0];
		await ts?.({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, c);
		expect((pi as any).appendEntry).toHaveBeenCalledWith("minion-primary", { name: "build" });
	});
});

describe("v2.1 — subagent tool exclusion of primaries", () => {
	it("excludes type:'primary' agents from the discovered roster", async () => {
		const { pi, captured } = mockPi();
		const mixed = [
			makeAgent({ name: "scout", type: "subagent" }),
			makeAgent({ name: "build", type: "primary" }), // must not be visible to subagent tool
			makeAgent({ name: "plan", type: "primary" }),
		];
		buildExtension(pi, {
			discoverAgents: () => ({ agents: mixed, projectAgentsDir: null }),
			runAgentFn: vi.fn(),
			readOverrides: () => ({}),
		});
		const tool = captured.tools.get("subagent");
		const out = await tool.execute("tc-1", { list: true }, undefined, undefined, ctx());
		expect(out.content[0].text).toMatch(/scout/);
		expect(out.content[0].text).not.toMatch(/build/);
		expect(out.content[0].text).not.toMatch(/plan/);
	});
});

// =============================================================================
// Regression: ESM-only — no `require()` in production source paths
// =============================================================================
//
// Background: a previous iteration used `require("./config.ts")` to dodge a
// (non-existent) circular dep. ESM has no `require`, so production loads of
// `pi -e ./index.ts` would crash with `ReferenceError: require is not defined`.
// Tests injected all deps and never hit the default wiring, so the bug slipped
// through. These tests pin the fix:
//   1. Static check: source of `index.ts` and `primaries.ts` contains no `require(`.
//   2. Default export is callable without throwing.
//   3. Calling `defaultExtension(pi)` does not throw (it wires through to the
//      real `config.ts`/`agents.ts`/`runner.ts` modules via static imports).

describe("v2.1 — ESM production path (regression)", () => {
	it("index.ts source contains no `require(` calls", () => {
		const src = readFileSync(new URL("./index.ts", import.meta.url), "utf-8");
		const matches = src.match(/^\s*[^/]*\brequire\s*\(/gm) ?? [];
		expect(matches).toEqual([]);
	});

	it("primaries.ts source contains no `require(` calls", () => {
		const src = readFileSync(new URL("./primaries.ts", import.meta.url), "utf-8");
		const matches = src.match(/^\s*[^/]*\brequire\s*\(/gm) ?? [];
		expect(matches).toEqual([]);
	});

	it("default export is the real defaultExtension and is callable", () => {
		expect(typeof defaultExtension).toBe("function");
		// It should accept an ExtensionAPI and not throw on a fresh pi mock.
		// Discovery / runner are mocked out via real paths that resolve to
		// discovery on an empty cwd; the only way this throws is if a
		// `require()` slipped back in or a circular import re-surfaced.
		const { pi } = mockPi();
		expect(() => defaultExtension(pi)).not.toThrow();
	});
});
