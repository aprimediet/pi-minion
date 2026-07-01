import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	loadAgentsFromDir,
	findNearestProjectAgentsDir,
	discoverAgents,
	formatAgentList,
} from "./agents.ts";

// Redirect the SDK's getAgentDir() default to a per-test temp dir so discoverAgents()
// is hermetic and does not read the user's real ~/.pi/agent.
const ENV_KEY = "PI_CODING_AGENT_DIR";
let savedEnv: string | undefined;
beforeAll(() => {
	savedEnv = process.env[ENV_KEY];
});
afterAll(() => {
	if (savedEnv === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = savedEnv;
});

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minion-agents-test-"));
	// SDK's getAgentDir() expands this env var; point it at the test tmp so the
	// default `<agentDir>/agents` lookup is hermetic.
	process.env[ENV_KEY] = tmp;
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadAgentsFromDir — `type` frontmatter (v2.1)", () => {
	it("defaults type to 'subagent' when absent", () => {
		const dir = path.join(tmp, "agents");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "no-type.md"),
			`---\nname: notype\ndescription: d\n---\nbody`,
		);
		const agents = loadAgentsFromDir(dir, "user");
		expect(agents[0].type).toBe("subagent");
	});

	it("parses type: primary when present", () => {
		const dir = path.join(tmp, "agents");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "primary.md"),
			`---\nname: p\ndescription: d\ntype: primary\n---\nbody`,
		);
		const agents = loadAgentsFromDir(dir, "user");
		expect(agents[0].type).toBe("primary");
	});

	it("parses type: subagent when explicit", () => {
		const dir = path.join(tmp, "agents");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "sub.md"),
			`---\nname: s\ndescription: d\ntype: subagent\n---\nbody`,
		);
		const agents = loadAgentsFromDir(dir, "user");
		expect(agents[0].type).toBe("subagent");
	});

	it("falls back to 'subagent' for an unrecognized type value (fail-soft)", () => {
		const dir = path.join(tmp, "agents");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "weird.md"),
			`---\nname: w\ndescription: d\ntype: not-a-real-kind\n---\nbody`,
		);
		const agents = loadAgentsFromDir(dir, "user");
		expect(agents[0].type).toBe("subagent");
	});
});

describe("loadAgentsFromDir", () => {
	it("returns [] when dir does not exist", () => {
		expect(loadAgentsFromDir(path.join(tmp, "missing"), "user")).toEqual([]);
	});

	it("returns [] when dir is empty", () => {
		const dir = path.join(tmp, "agents");
		fs.mkdirSync(dir);
		expect(loadAgentsFromDir(dir, "user")).toEqual([]);
	});

	it("parses valid agent file with frontmatter", () => {
		const dir = path.join(tmp, "agents");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "scout.md"),
			`---
name: scout
description: fast recon
tools: read, grep, find, ls
model: claude-haiku-4-5
---

You are a scout.
`,
		);
		const agents = loadAgentsFromDir(dir, "user");
		expect(agents).toHaveLength(1);
		expect(agents[0]).toMatchObject({
			name: "scout",
			description: "fast recon",
			tools: ["read", "grep", "find", "ls"],
			model: "claude-haiku-4-5",
			source: "user",
		});
		expect(agents[0].systemPrompt.trim()).toBe("You are a scout.");
		expect(agents[0].filePath).toBe(path.join(dir, "scout.md"));
	});

	it("omits tools when not declared in frontmatter", () => {
		const dir = path.join(tmp, "agents");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "worker.md"),
			`---
name: worker
description: generalist
model: claude-sonnet-4-5
---

Body`,
		);
		const agents = loadAgentsFromDir(dir, "user");
		expect(agents[0].tools).toBeUndefined();
		expect(agents[0].model).toBe("claude-sonnet-4-5");
	});

	it("treats empty tools string as no tools", () => {
		const dir = path.join(tmp, "agents");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "x.md"),
			`---
name: x
description: d
tools:
---

Body`,
		);
		const agents = loadAgentsFromDir(dir, "user");
		expect(agents[0].tools).toBeUndefined();
	});

	it("skips files missing name or description", () => {
		const dir = path.join(tmp, "agents");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "no-name.md"),
			`---
description: desc only
---

body`,
		);
		fs.writeFileSync(
			path.join(dir, "no-desc.md"),
			`---
name: only-name
---

body`,
		);
		fs.writeFileSync(path.join(dir, "notmd.txt"), `---
name: x
description: y
---

body`);
		expect(loadAgentsFromDir(dir, "user")).toEqual([]);
	});

	it("ignores non-md files and directories", () => {
		const dir = path.join(tmp, "agents");
		fs.mkdirSync(dir);
		// Sub-directory whose name happens to end in .md — must be skipped.
		fs.mkdirSync(path.join(dir, "subdir.md"));
		fs.writeFileSync(path.join(dir, "ignored.txt"), "ignored");
		fs.writeFileSync(
			path.join(dir, "real.md"),
			`---
name: real
description: d
---

b`,
		);
		const agents = loadAgentsFromDir(dir, "user");
		expect(agents).toHaveLength(1);
		expect(agents[0].name).toBe("real");
	});
});

describe("findNearestProjectAgentsDir", () => {
	it("returns null when no .pi/agents ancestor exists", () => {
		// Make a deep nested tmp with no .pi inside
		const deep = path.join(tmp, "a", "b", "c");
		fs.mkdirSync(deep, { recursive: true });
		expect(findNearestProjectAgentsDir(deep)).toBeNull();
	});

	it("returns the nearest .pi/agents walking up", () => {
		// layout: tmp/.pi/agents, tmp/a/b/c
		fs.mkdirSync(path.join(tmp, ".pi", "agents"), { recursive: true });
		const deep = path.join(tmp, "a", "b", "c");
		fs.mkdirSync(deep, { recursive: true });
		const found = findNearestProjectAgentsDir(deep);
		expect(found).toBe(path.join(tmp, ".pi", "agents"));
	});

	it("prefers the closest .pi/agents", () => {
		// layout: tmp/.pi/agents, tmp/sub/.pi/agents
		fs.mkdirSync(path.join(tmp, ".pi", "agents"), { recursive: true });
		const closer = path.join(tmp, "sub", ".pi", "agents");
		fs.mkdirSync(closer, { recursive: true });
		const cwd = path.join(tmp, "sub", "work");
		fs.mkdirSync(cwd, { recursive: true });
		expect(findNearestProjectAgentsDir(cwd)).toBe(closer);
	});
});

describe("discoverAgents", () => {
	let userDir: string;
	let projectDir: string;
	let projectRoot: string;
	beforeEach(() => {
		userDir = path.join(tmp, "user-agents");
		projectRoot = path.join(tmp, "proj");
		projectDir = path.join(projectRoot, ".pi", "agents");
		fs.mkdirSync(userDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
	});

	it("scope 'user' only reads userDir", () => {
		fs.writeFileSync(
			path.join(userDir, "u.md"),
			`---\nname: u\ndescription: d\n---\nbody`,
		);
		fs.writeFileSync(
			path.join(projectDir, "p.md"),
			`---\nname: p\ndescription: d\n---\nbody`,
		);
		// cwd = tmp (outside projectRoot) so no .pi/agents ancestor.
		const out = discoverAgents(tmp, "user", { userAgentsDir: userDir });
		expect(out.agents.map((a) => a.name)).toEqual(["u"]);
		expect(out.agents[0].source).toBe("user");
		expect(out.projectAgentsDir).toBeNull();
	});

	it("scope 'project' only reads project dir when present", () => {
		fs.writeFileSync(
			path.join(userDir, "u.md"),
			`---\nname: u\ndescription: d\n---\nbody`,
		);
		fs.writeFileSync(
			path.join(projectDir, "p.md"),
			`---\nname: p\ndescription: d\n---\nbody`,
		);
		const out = discoverAgents(projectRoot, "project", { userAgentsDir: userDir });
		expect(out.agents.map((a) => a.name)).toEqual(["p"]);
		expect(out.agents[0].source).toBe("project");
		expect(out.projectAgentsDir).toBe(projectDir);
	});

	it("scope 'project' returns [] when no project dir exists", () => {
		fs.writeFileSync(
			path.join(userDir, "u.md"),
			`---\nname: u\ndescription: d\n---\nbody`,
		);
		const emptyDir = path.join(tmp, "nopj");
		fs.mkdirSync(emptyDir);
		const out = discoverAgents(emptyDir, "project", { userAgentsDir: userDir });
		expect(out.agents).toEqual([]);
		expect(out.projectAgentsDir).toBeNull();
	});

	it("scope 'both' merges both, project overrides user by name", () => {
		fs.writeFileSync(
			path.join(userDir, "scout.md"),
			`---\nname: scout\ndescription: user scout\n---\nuser body`,
		);
		fs.writeFileSync(
			path.join(projectDir, "scout.md"),
			`---\nname: scout\ndescription: project scout\n---\nproject body`,
		);
		fs.writeFileSync(
			path.join(userDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: r\n---\nbody`,
		);
		const out = discoverAgents(projectRoot, "both", { userAgentsDir: userDir });
		const names = out.agents.map((a) => a.name).sort();
		expect(names).toEqual(["reviewer", "scout"]);
		const scout = out.agents.find((a) => a.name === "scout");
		expect(scout?.source).toBe("project");
		expect(scout?.description).toBe("project scout");
	});

	it("uses injected userAgentsDir when provided", () => {
		const customUserDir = path.join(tmp, "custom-user");
		fs.mkdirSync(customUserDir, { recursive: true });
		fs.writeFileSync(
			path.join(customUserDir, "x.md"),
			`---\nname: x\ndescription: d\n---\nbody`,
		);
		const out = discoverAgents(tmp, "user", { userAgentsDir: customUserDir });
		expect(out.agents.map((a) => a.name)).toEqual(["x"]);
	});

	it("default userAgentsDir follows getAgentDir()/agents (env override)", () => {
		// PI_CODING_AGENT_DIR is set to tmp by beforeEach, so <tmp>/agents is the default.
		const defaultUser = path.join(tmp, "agents");
		fs.mkdirSync(defaultUser, { recursive: true });
		fs.writeFileSync(
			path.join(defaultUser, "z.md"),
			`---\nname: z\ndescription: d\n---\nbody`,
		);
		const out = discoverAgents(tmp, "user");
		expect(out.agents.map((a) => a.name)).toEqual(["z"]);
	});
});

// =============================================================================
// Bundled agent discovery
// =============================================================================
//
// Bundled agents (extension's `agents/` dir) are the base layer. User agents
// override bundled by name, project agents override user by name. Scope controls
// which override layers are included; bundled is always included when its dir
// is passed via options.

describe("loadAgentsFromDir — 'bundled' source", () => {
	it("accepts 'bundled' as a source value", () => {
		const dir = path.join(tmp, "bundled");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "scout.md"),
			`---\nname: scout\ndescription: d\n---\nbody`,
		);
		const agents = loadAgentsFromDir(dir, "bundled");
		expect(agents).toHaveLength(1);
		expect(agents[0].source).toBe("bundled");
	});
});

describe("discoverAgents — bundled (extension's agents/ dir)", () => {
	let userDir: string;
	let bundledDir: string;
	let projectDir: string;
	let projectRoot: string;
	beforeEach(() => {
		bundledDir = path.join(tmp, "bundled-agents");
		userDir = path.join(tmp, "user-agents");
		projectRoot = path.join(tmp, "proj");
		projectDir = path.join(projectRoot, ".pi", "agents");
		fs.mkdirSync(bundledDir, { recursive: true });
		fs.mkdirSync(userDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
	});

	it("loads bundled agents as base when bundledAgentsDir is provided", () => {
		fs.writeFileSync(
			path.join(bundledDir, "scout.md"),
			`---\nname: scout\ndescription: bundled scout\n---\nbundled body`,
		);
		const out = discoverAgents(tmp, "user", {
			bundledAgentsDir: bundledDir,
			userAgentsDir: userDir,
		});
		expect(out.agents.map((a) => a.name)).toEqual(["scout"]);
		expect(out.agents[0].source).toBe("bundled");
		expect(out.agents[0].description).toBe("bundled scout");
	});

	it("user agent overrides bundled by name (same name → user wins)", () => {
		fs.writeFileSync(
			path.join(bundledDir, "scout.md"),
			`---\nname: scout\ndescription: bundled scout\n---\nbundled body`,
		);
		fs.writeFileSync(
			path.join(userDir, "scout.md"),
			`---\nname: scout\ndescription: user scout\n---\nuser body`,
		);
		const out = discoverAgents(tmp, "user", {
			bundledAgentsDir: bundledDir,
			userAgentsDir: userDir,
		});
		expect(out.agents).toHaveLength(1);
		expect(out.agents[0].source).toBe("user");
		expect(out.agents[0].description).toBe("user scout");
		expect(out.agents[0].systemPrompt.trim()).toBe("user body");
	});

	it("project agent overrides bundled by name (scope=project)", () => {
		fs.writeFileSync(
			path.join(bundledDir, "scout.md"),
			`---\nname: scout\ndescription: bundled scout\n---\nbundled body`,
		);
		fs.writeFileSync(
			path.join(projectDir, "scout.md"),
			`---\nname: scout\ndescription: project scout\n---\nproject body`,
		);
		const out = discoverAgents(projectRoot, "project", {
			bundledAgentsDir: bundledDir,
			userAgentsDir: userDir,
		});
		expect(out.agents).toHaveLength(1);
		expect(out.agents[0].source).toBe("project");
		expect(out.agents[0].description).toBe("project scout");
	});

	it("scope=both: project > user > bundled precedence", () => {
		fs.writeFileSync(
			path.join(bundledDir, "scout.md"),
			`---\nname: scout\ndescription: bundled scout\n---\nbundled body`,
		);
		fs.writeFileSync(
			path.join(userDir, "scout.md"),
			`---\nname: scout\ndescription: user scout\n---\nuser body`,
		);
		fs.writeFileSync(
			path.join(projectDir, "scout.md"),
			`---\nname: scout\ndescription: project scout\n---\nproject body`,
		);
		// reviewer only in user; worker only in bundled; planner only in project.
		fs.writeFileSync(
			path.join(userDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: r\n---\nbody`,
		);
		fs.writeFileSync(
			path.join(bundledDir, "worker.md"),
			`---\nname: worker\ndescription: w\n---\nbody`,
		);
		fs.writeFileSync(
			path.join(projectDir, "planner.md"),
			`---\nname: planner\ndescription: p\n---\nbody`,
		);
		const out = discoverAgents(projectRoot, "both", {
			bundledAgentsDir: bundledDir,
			userAgentsDir: userDir,
		});
		const names = out.agents.map((a) => a.name).sort();
		expect(names).toEqual(["planner", "reviewer", "scout", "worker"]);

		// Precedence: project > user > bundled
		const scout = out.agents.find((a) => a.name === "scout");
		expect(scout?.source).toBe("project");
		expect(scout?.description).toBe("project scout");

		// reviewer only in user
		const reviewer = out.agents.find((a) => a.name === "reviewer");
		expect(reviewer?.source).toBe("user");

		// worker only in bundled
		const worker = out.agents.find((a) => a.name === "worker");
		expect(worker?.source).toBe("bundled");

		// planner only in project
		const planner = out.agents.find((a) => a.name === "planner");
		expect(planner?.source).toBe("project");
	});

	it("scope=user: bundled + user (no project), user overrides bundled", () => {
		fs.writeFileSync(
			path.join(bundledDir, "scout.md"),
			`---\nname: scout\ndescription: bundled scout\n---\nbody`,
		);
		fs.writeFileSync(
			path.join(projectDir, "scout.md"),
			`---\nname: scout\ndescription: project scout\n---\nbody`,
		);
		const out = discoverAgents(projectRoot, "user", {
			bundledAgentsDir: bundledDir,
			userAgentsDir: userDir,
		});
		// scope=user → project agents hidden, but bundled still visible.
		// project scout is hidden, bundled scout is the base (no user override).
		expect(out.agents).toHaveLength(1);
		expect(out.agents[0].source).toBe("bundled");
		expect(out.agents[0].description).toBe("bundled scout");
	});

	it("scope=project: bundled + project (no user), project overrides bundled", () => {
		fs.writeFileSync(
			path.join(bundledDir, "scout.md"),
			`---\nname: scout\ndescription: bundled scout\n---\nbody`,
		);
		fs.writeFileSync(
			path.join(userDir, "scout.md"),
			`---\nname: scout\ndescription: user scout\n---\nbody`,
		);
		fs.writeFileSync(
			path.join(projectDir, "scout.md"),
			`---\nname: scout\ndescription: project scout\n---\nbody`,
		);
		const out = discoverAgents(projectRoot, "project", {
			bundledAgentsDir: bundledDir,
			userAgentsDir: userDir,
		});
		// scope=project → user agents hidden, project wins over bundled.
		expect(out.agents).toHaveLength(1);
		expect(out.agents[0].source).toBe("project");
		expect(out.agents[0].description).toBe("project scout");
	});

	it("scope=project with no project dir: bundled agents still available", () => {
		const emptyProjRoot = path.join(tmp, "empty-proj");
		fs.mkdirSync(emptyProjRoot);
		fs.writeFileSync(
			path.join(bundledDir, "scout.md"),
			`---\nname: scout\ndescription: bundled\n---\nbody`,
		);
		const out = discoverAgents(emptyProjRoot, "project", {
			bundledAgentsDir: bundledDir,
			userAgentsDir: userDir,
		});
		expect(out.agents.map((a) => a.name)).toEqual(["scout"]);
		expect(out.agents[0].source).toBe("bundled");
	});

	it("bundledAgentsDir undefined → no bundled agents loaded (backward compat)", () => {
		fs.writeFileSync(
			path.join(bundledDir, "scout.md"),
			`---\nname: scout\ndescription: d\n---\nbody`,
		);
		// bundledDir exists but is not passed via options → should not be read.
		const out = discoverAgents(tmp, "user", { userAgentsDir: userDir });
		expect(out.agents).toEqual([]);
	});

	it("bundledAgentsDir pointing at missing dir → no bundled agents (no throw)", () => {
		const out = discoverAgents(tmp, "user", {
			bundledAgentsDir: path.join(tmp, "does-not-exist"),
			userAgentsDir: userDir,
		});
		expect(out.agents).toEqual([]);
	});
});

describe("formatAgentList", () => {
	const baseAgents = [
		{ name: "a", source: "user" as const, description: "alpha" },
		{ name: "b", source: "project" as const, description: "beta" },
		{ name: "c", source: "user" as const, description: "gamma" },
		{ name: "d", source: "user" as const, description: "delta" },
	];

	it("returns {text:'none',remaining:0} when empty", () => {
		expect(formatAgentList([], 3)).toEqual({ text: "none", remaining: 0 });
	});

	it("returns name (source): desc; …", () => {
		const out = formatAgentList(baseAgents.slice(0, 2) as any, 5);
		expect(out.text).toBe("a (user): alpha; b (project): beta");
		expect(out.remaining).toBe(0);
	});

	it("respects maxItems and reports remaining", () => {
		const out = formatAgentList(baseAgents as any, 2);
		expect(out.text).toBe("a (user): alpha; b (project): beta");
		expect(out.remaining).toBe(2);
	});
});