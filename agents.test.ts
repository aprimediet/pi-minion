import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { loadAgentsFromDir, parseTools, findNearestProjectAgentsDir, discoverAgents, formatAgentList, type AgentConfig, type AgentScope } from "./agents.ts";

function writeMd(dir: string, name: string, frontmatter: Record<string, unknown>, body = ""): string {
    const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
    const content = `---\n${fmLines.join("\n")}\n---\n${body}`;
    const fp = path.join(dir, name);
    fs.writeFileSync(fp, content, "utf-8");
    return fp;
}

describe("loadAgentsFromDir", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minion-agents-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("includes a file with type:subagent + name + description", () => {
        writeMd(tmpDir, "worker.md", {
            name: "worker",
            description: "General purpose agent",
            type: "subagent",
        }, "You are a worker.");
        const result = loadAgentsFromDir(tmpDir, "user");
        expect(result).toHaveLength(1);
        expect(result[0]!.name).toBe("worker");
        expect(result[0]!.description).toBe("General purpose agent");
        expect(result[0]!.source).toBe("user");
        expect(result[0]!.systemPrompt).toBe("You are a worker.");
        expect(result[0]!.filePath).toBe(path.join(tmpDir, "worker.md"));
    });

    it("excludes a file missing type frontmatter", () => {
        writeMd(tmpDir, "no-type.md", {
            name: "worker",
            description: "desc",
        });
        expect(loadAgentsFromDir(tmpDir, "user")).toHaveLength(0);
    });

    it("excludes a file with type:other", () => {
        writeMd(tmpDir, "other.md", {
            name: "other",
            description: "desc",
            type: "other",
        });
        expect(loadAgentsFromDir(tmpDir, "user")).toHaveLength(0);
    });

    it("excludes a file missing name", () => {
        writeMd(tmpDir, "no-name.md", {
            description: "desc",
            type: "subagent",
        });
        expect(loadAgentsFromDir(tmpDir, "user")).toHaveLength(0);
    });

    it("excludes a file missing description", () => {
        writeMd(tmpDir, "no-desc.md", {
            name: "foo",
            type: "subagent",
        });
        expect(loadAgentsFromDir(tmpDir, "user")).toHaveLength(0);
    });

    it("skips non-.md files without throwing", () => {
        writeMd(tmpDir, "readme.txt", { name: "x", description: "d", type: "subagent" });
        fs.writeFileSync(path.join(tmpDir, "data.json"), JSON.stringify({ a: 1 }), "utf-8");
        expect(loadAgentsFromDir(tmpDir, "user")).toHaveLength(0);
    });

    it("skips malformed YAML without throwing", () => {
        const fp = path.join(tmpDir, "bad.md");
        fs.writeFileSync(fp, "---\nname: foo\n  bad-indent: true\n---\nbody", "utf-8");
        // Should not throw, should return empty
        expect(() => loadAgentsFromDir(tmpDir, "user")).not.toThrow();
        expect(loadAgentsFromDir(tmpDir, "user")).toHaveLength(0);
    });
});

describe("parseTools", () => {
    it("splits comma-separated tools, trims whitespace, drops empties", () => {
        expect(parseTools("read, grep ,  , ls")).toEqual(["read", "grep", "ls"]);
    });

    it("returns undefined for empty string", () => {
        expect(parseTools("")).toBeUndefined();
    });

    it("returns undefined for whitespace-only string", () => {
        expect(parseTools("   ")).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
        expect(parseTools(undefined)).toBeUndefined();
    });

    it("handles single tool", () => {
        expect(parseTools("bash")).toEqual(["bash"]);
    });
});

describe("findNearestProjectAgentsDir", () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "minion-find-"));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("finds nearest ancestor .pi/agents dir", () => {
        const deep = path.join(root, "a", "b", "c");
        fs.mkdirSync(deep, { recursive: true });
        // Create .pi/agents at root level
        fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
        const result = findNearestProjectAgentsDir(deep);
        expect(result).toBe(path.join(root, ".pi", "agents"));
    });

    it("prefers nearest ancestor over farther ones", () => {
        const mid = path.join(root, "mid");
        fs.mkdirSync(mid, { recursive: true });
        const deep = path.join(mid, "deep");
        fs.mkdirSync(deep, { recursive: true });
        fs.mkdirSync(path.join(mid, ".pi", "agents"), { recursive: true });
        fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
        const result = findNearestProjectAgentsDir(deep);
        expect(result).toBe(path.join(mid, ".pi", "agents"));
    });

    it("returns null when none exists up to fs root", () => {
        const lone = path.join(root, "alone");
        fs.mkdirSync(lone, { recursive: true });
        const result = findNearestProjectAgentsDir(lone);
        expect(result).toBeNull();
    });

    it("returns null when cwd itself has no .pi/agents and no ancestor has one", () => {
        const result = findNearestProjectAgentsDir(root);
        expect(result).toBeNull();
    });

    it("returns dir when cwd itself contains .pi/agents", () => {
        fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
        const result = findNearestProjectAgentsDir(root);
        expect(result).toBe(path.join(root, ".pi", "agents"));
    });
});

describe("discoverAgents", () => {
    let bundledDir: string;
    let userDir: string;
    let projectDir: string;
    let cwd: string;

    beforeEach(() => {
        bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "minion-bundled-"));
        userDir = fs.mkdtempSync(path.join(os.tmpdir(), "minion-user-"));
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "minion-project-"));
        const projAgents = path.join(projectDir, ".pi", "agents");
        fs.mkdirSync(projAgents, { recursive: true });
        cwd = path.join(projectDir, "workdir");
        fs.mkdirSync(cwd, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(bundledDir, { recursive: true, force: true });
        fs.rmSync(userDir, { recursive: true, force: true });
        fs.rmSync(projectDir, { recursive: true, force: true });
    });

    function agent(name: string, desc: string): Record<string, unknown> {
        return { name, description: desc, type: "subagent" };
    }

    it("returns bundled agents for scope:bundled", () => {
        writeMd(bundledDir, "worker.md", agent("worker", "bundled worker"));
        const result = discoverAgents(cwd, "bundled", bundledDir, userDir);
        expect(result.agents).toHaveLength(1);
        expect(result.agents[0]!.name).toBe("worker");
        expect(result.agents[0]!.source).toBe("bundled");
    });

    it("returns user agents for scope:user", () => {
        writeMd(userDir, "worker.md", agent("worker", "user worker"));
        const result = discoverAgents(cwd, "user", bundledDir, userDir);
        expect(result.agents).toHaveLength(1);
        expect(result.agents[0]!.source).toBe("user");
    });

    it("returns project agents for scope:project", () => {
        const projAgents = path.join(projectDir, ".pi", "agents");
        writeMd(projAgents, "worker.md", agent("worker", "project worker"));
        const result = discoverAgents(cwd, "project", bundledDir, userDir);
        expect(result.agents).toHaveLength(1);
        expect(result.agents[0]!.source).toBe("project");
    });

    it("scope:all merges bundled+user+project with project precedence", () => {
        writeMd(bundledDir, "worker.md", agent("worker", "bundled worker"));
        writeMd(userDir, "worker.md", agent("worker", "user worker"));
        const projAgents = path.join(projectDir, ".pi", "agents");
        writeMd(projAgents, "worker.md", agent("worker", "project worker"));
        writeMd(bundledDir, "explorer.md", agent("explorer", "bundled explorer"));

        const result = discoverAgents(cwd, "all", bundledDir, userDir);
        // worker from project overrides user and bundled
        const worker = result.agents.find(a => a.name === "worker")!;
        expect(worker).toBeDefined();
        expect(worker.description).toBe("project worker");
        expect(worker.source).toBe("project");
        // explorer comes from bundled
        const explorer = result.agents.find(a => a.name === "explorer")!;
        expect(explorer).toBeDefined();
        expect(explorer.source).toBe("bundled");
    });

    it("includes projectAgentsDir in result", () => {
        const result = discoverAgents(cwd, "all", bundledDir, userDir);
        expect(result.projectAgentsDir).toBe(path.join(projectDir, ".pi", "agents"));
    });

    it("returns empty agents when no files in any scope", () => {
        const result = discoverAgents(cwd, "all", bundledDir, userDir);
        expect(result.agents).toHaveLength(0);
    });
});

describe("formatAgentList", () => {
    it("returns formatted list with source annotation", () => {
        const agents: AgentConfig[] = [
            { name: "worker", description: "General worker", source: "bundled", systemPrompt: "", filePath: "/a.md" },
            { name: "scout", description: "Code scout", source: "user", systemPrompt: "", filePath: "/b.md" },
        ];
        const result = formatAgentList(agents, 10);
        expect(result.text).toBe("worker (bundled): General worker; scout (user): Code scout");
        expect(result.remaining).toBe(0);
    });

    it("truncates to maxItems with correct remaining count", () => {
        const agents: AgentConfig[] = [
            { name: "a", description: "d1", source: "bundled", systemPrompt: "", filePath: "/a.md" },
            { name: "b", description: "d2", source: "user", systemPrompt: "", filePath: "/b.md" },
            { name: "c", description: "d3", source: "project", systemPrompt: "", filePath: "/c.md" },
        ];
        const result = formatAgentList(agents, 2);
        expect(result.text).toBe("a (bundled): d1; b (user): d2");
        expect(result.remaining).toBe(1);
    });

    it("returns none for empty list", () => {
        const result = formatAgentList([], 10);
        expect(result.text).toBe("none");
        expect(result.remaining).toBe(0);
    });

    it("returns none when agents is empty", () => {
        const result = formatAgentList([], 5);
        expect(result.text).toBe("none");
        expect(result.remaining).toBe(0);
    });
});

describe("bundled agents", () => {
    it("loads explorer, scout, worker, reviewer from the agents directory", () => {
        const agentsDir = path.resolve(__dirname, "agents");
        const agents = loadAgentsFromDir(agentsDir, "bundled");
        const names = agents.map(a => a.name).sort();
        expect(names).toEqual(["explorer", "reviewer", "scout", "worker"]);
        for (const a of agents) {
            expect(a.description).toBeTruthy();
            expect(a.systemPrompt).toBeTruthy();
        }
    });
});
