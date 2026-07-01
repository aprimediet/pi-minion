import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, getAgentDir, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type AgentScope = "bundled" | "user" | "project" | "all";

export interface AgentConfig {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    systemPrompt: string;
    source: AgentScope;
    filePath: string;
}

export interface AgentListResult {
    text: string;
    remaining: number;
}

export interface AgentDiscoveryResult {
    agents: AgentConfig[];
    projectAgentsDir: string | null;
}

export function parseTools(raw: string | undefined | null): string[] | undefined {
    if (!raw || !raw.trim()) return undefined;
    const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : undefined;
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): AgentListResult {
    if (agents.length === 0) return { text: "none", remaining: 0 };
    const shown = agents.slice(0, maxItems);
    const parts = shown.map(a => `${a.name} (${a.source}): ${a.description}`);
    return {
        text: parts.join("; "),
        remaining: Math.max(0, agents.length - maxItems),
    };
}

export function findNearestProjectAgentsDir(cwd: string): string | null {
    let dir = path.resolve(cwd);
    const { root } = path.parse(dir);
    while (true) {
        const candidate = path.join(dir, CONFIG_DIR_NAME, "agents");
        try {
            if (fs.statSync(candidate).isDirectory()) return candidate;
        } catch {
            // not accessible, continue
        }
        if (dir === root) return null;
        dir = path.dirname(dir);
    }
}

function resolveBundledDir(): string | null {
    try {
        const url = import.meta.url;
        const selfPath = fileURLToPath(url);
        const extDir = path.dirname(selfPath);
        const bundled = path.join(extDir, "agents");
        if (fs.existsSync(bundled)) return bundled;
        return null;
    } catch {
        return null;
    }
}

export function discoverAgents(
    cwd: string,
    scope: AgentScope,
    bundledDir?: string,
    userDir?: string,
): AgentDiscoveryResult {
    const scopesToLoad: AgentScope[] = scope === "all"
        ? ["bundled", "user", "project"]
        : [scope];

    const map = new Map<string, AgentConfig>();
    let projectAgentsDir: string | null = null;

    for (const s of scopesToLoad) {
        let dir: string | null = null;
        switch (s) {
            case "bundled":
                dir = bundledDir ?? resolveBundledDir();
                break;
            case "user": {
                const userDirPath = path.join(getAgentDir(), "agents");
                dir = userDir ?? (fs.existsSync(userDirPath) ? userDirPath : null);
                break;
            }
            case "project": {
                const found = findNearestProjectAgentsDir(cwd);
                projectAgentsDir = found;
                dir = found;
                break;
            }
        }
        if (!dir) continue;
        const agents = loadAgentsFromDir(dir, s);
        for (const agent of agents) {
            map.set(agent.name, agent);
        }
    }

    return { agents: [...map.values()], projectAgentsDir };
}

export function loadAgentsFromDir(dir: string, source: AgentScope): AgentConfig[] {
    const results: AgentConfig[] = [];
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!entry.name.endsWith(".md")) continue;

        const fp = path.join(dir, entry.name);
        let content: string;
        try {
            content = fs.readFileSync(fp, "utf-8");
        } catch {
            continue;
        }

        let frontmatter: Record<string, unknown>;
        let body: string;
        try {
            const parsed = parseFrontmatter(content);
            frontmatter = parsed.frontmatter as Record<string, unknown>;
            body = parsed.body ?? "";
        } catch {
            continue;
        }

        if (frontmatter.type !== "subagent") continue;
        const name = frontmatter.name;
        const description = frontmatter.description;
        if (typeof name !== "string" || !name) continue;
        if (typeof description !== "string" || !description) continue;

        const tools = typeof frontmatter.tools === "string" ? parseTools(frontmatter.tools) : undefined;
        const model = typeof frontmatter.model === "string" && frontmatter.model ? frontmatter.model : undefined;

        results.push({
            name,
            description,
            tools,
            model,
            systemPrompt: body,
            source,
            filePath: fp,
        });
    }

    return results;
}
