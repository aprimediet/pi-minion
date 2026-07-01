import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { discoverAgents, formatAgentList, type AgentScope } from "./agents.ts";
import type { SingleResult } from "./runner.ts";

const AgentScopeSchema = StringEnum(["bundled", "user", "project", "all"] as const, {
    description: "Which agent directories to scan. Default: all.",
    default: "all",
});

/**
 * Convert a streaming update from runSingleAgent (raw SingleResult) into the tool-result
 * shape that pi's ToolExecutionComponent expects (`{ content, details, isError }`).
 *
 * pi's renderer calls getTextOutput() on the payload which derefs `result.content.filter(...)`.
 * The raw SingleResult has no `.content` field, so we must wrap it.
 *
 * Exported for unit testing — the contract is the bug fix and must be regression-tested.
 */
export function toToolResultUpdate(update: SingleResult): { content: Array<{ type: "text"; text: string }>; details: SingleResult; isError: boolean } {
    const text = update.outputText || update.stderr || `(${update.agentName} ${update.exitCode === 0 ? "running" : "error"})`;
    return {
        content: [{ type: "text", text }],
        details: update,
        isError: update.exitCode !== 0,
    };
}

const TaskItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task to delegate to the agent" }),
    cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
    cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export default function minionExtension(pi: ExtensionAPI): void {
    // Delegation tool
    pi.registerTool({
        name: "delegation",
        label: "Delegation",
        description: [
            "Delegate tasks to sub-agents in single, parallel, or chain mode.",
            "Use `agent`+`task` for single mode, `tasks[]` for parallel, `chain[]` for sequential with {previous}.",
        ].join(" "),
        parameters: Type.Object({
            agent: Type.Optional(Type.String({ description: "Agent name for single mode" })),
            task: Type.Optional(Type.String({ description: "Task description for single mode" })),
            tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks array" })),
            chain: Type.Optional(Type.Array(ChainItem, { description: "Chain steps — use {previous} in task" })),
            agentScope: Type.Optional(AgentScopeSchema),
            confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Prompt before running project agents. Default: true.", default: true })),
            cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
        }),
        execute: async (_toolCallId, params, _signal, onUpdate, ctx: ExtensionContext) => {
            const scope = (params.agentScope ?? "all") as AgentScope;
            const discovery = discoverAgents(ctx.cwd, scope);
            const agents = discovery.agents;

            // Validate exactly one mode
            const hasSingle = Boolean(params.agent && params.task);
            const hasTasks = Boolean(params.tasks?.length);
            const hasChain = Boolean(params.chain?.length);
            const modeCount = Number(hasSingle) + Number(hasTasks) + Number(hasChain);

            if (modeCount !== 1) {
                const available = agents.map(a => `${a.name} (${a.source})`).join(", ") || "none";
                return {
                    content: [{ type: "text", text: `Invalid: provide exactly one mode (single, parallel, or chain).\nAvailable agents: ${available}` }],
                    details: { mode: "single", agentScope: scope, projectAgentsDir: discovery.projectAgentsDir, results: [] },
                    isError: true,
                };
            }

            // Project agent confirmation
            const confirmProject = params.confirmProjectAgents ?? true;
            if (confirmProject && ctx.hasUI) {
                const requestedNames = new Set<string>();
                if (hasChain && params.chain) for (const s of params.chain) requestedNames.add(s.agent);
                if (hasTasks && params.tasks) for (const t of params.tasks) requestedNames.add(t.agent);
                if (hasSingle && params.agent) requestedNames.add(params.agent);

                const projectRequested = agents.filter(a => requestedNames.has(a.name) && a.source === "project");
                if (projectRequested.length > 0) {
                    const names = projectRequested.map(a => a.name).join(", ");
                    const dir = discovery.projectAgentsDir ?? "(unknown)";
                    const ok = await ctx.ui.confirm(
                        "Run project-local agents?",
                        `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
                    );
                    if (!ok) {
                        return {
                            content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
                            details: { mode: hasChain ? "chain" : hasTasks ? "parallel" : "single", agentScope: scope, projectAgentsDir: discovery.projectAgentsDir, results: [] },
                            isError: true,
                        };
                    }
                }
            }

            // Import and dispatch via runMode with real runSingleAgent
            const { runMode, runSingleAgent } = await import("./runner.ts");

            const mode = hasChain ? "chain" as const : hasTasks ? "parallel" as const : "single" as const;
            const modeParams = hasChain
                ? { chain: params.chain! }
                : hasTasks
                    ? { tasks: params.tasks! }
                    : { agent: params.agent!, task: params.task!, cwd: params.cwd };

            // Wrap pi's onUpdate so streaming updates from runSingleAgent arrive in tool-result
            // shape (`{ content: [{type, text}], details, isError }`). pi's ToolExecutionComponent
            // calls getTextOutput() on the payload which derefs `.content.filter(...)` — sending
            // the raw SingleResult (no `.content`) triggers
            // "Cannot read properties of undefined (reading 'filter')" on every streaming tick.
            const wrappedOnUpdate = (update: any) => {
                if (typeof onUpdate === "function") {
                    onUpdate(toToolResultUpdate(update));
                }
            };

            const modeResult = await runMode(
                mode,
                agents,
                modeParams as any,
                ctx.cwd,
                _signal ?? new AbortController().signal,
                wrappedOnUpdate,
                (defaultCwd, agts, agentName, task, cwd, step, sig, upd) =>
                    runSingleAgent(defaultCwd, agts, agentName, task, cwd, step, sig, upd),
            );

            return {
                content: [{ type: "text", text: modeResult.content }],
                details: { mode, agentScope: scope, projectAgentsDir: discovery.projectAgentsDir, results: modeResult.details ?? [] },
                isError: modeResult.isError,
            };
        },
        renderCall: (args, theme, _context) => {
            if (args.chain?.length) {
                const text = `${theme.fg("toolTitle", "delegation")} ${theme.fg("accent", `chain (${args.chain.length} steps)`)}`;
                return new Text(text, 0, 0);
            }
            if (args.tasks?.length) {
                const text = `${theme.fg("toolTitle", "delegation")} ${theme.fg("accent", `parallel (${args.tasks.length} tasks)`)}`;
                return new Text(text, 0, 0);
            }
            const agentName = args.agent || "...";
            const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
            const text = `${theme.fg("toolTitle", "delegation")} ${theme.fg("accent", agentName)}\n${theme.fg("dim", preview)}`;
            return new Text(text, 0, 0);
        },
        renderResult: (result, _options, theme, _context) => {
            const text = result.content?.[0];
            return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
        },
    });

    // Minion list tool
    pi.registerTool({
        name: "minion_list",
        label: "Minion List",
        description: "List all discoverable sub-agents across bundled, user, and project scopes.",
        parameters: Type.Object({
            agentScope: Type.Optional(AgentScopeSchema),
        }),
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) => {
            const scope = (params.agentScope ?? "all") as AgentScope;
            const discovery = discoverAgents(ctx.cwd, scope);
            const list = formatAgentList(discovery.agents, 20);

            // Build per-agent detail lines
            const detailLines = discovery.agents.map(a => {
                const parts = [`${a.name} — ${a.description}  [${a.source}`];
                if (a.model) parts.push(`, ${a.model}`);
                if (a.tools) parts.push(`, ${a.tools.join(", ")}`);
                parts.push("]");
                return parts.join("");
            });

            let text = list.text === "none"
                ? "No sub-agents found."
                : `Discovered ${discovery.agents.length} sub-agent(s):\n\n${detailLines.join("\n")}`;

            if (discovery.projectAgentsDir) {
                text += `\n\nProject agents directory: ${discovery.projectAgentsDir}`;
            }

            if (list.remaining > 0) {
                text += `\n(and ${list.remaining} more)`;
            }

            return {
                content: [{ type: "text", text }],
                details: { agents: discovery.agents, projectAgentsDir: discovery.projectAgentsDir },
            };
        },
        renderCall: (_args, theme, _context) => {
            return new Text(theme.fg("toolTitle", "minion_list"), 0, 0);
        },
        renderResult: (result, _options, _theme, _context) => {
            const text = result.content?.[0];
            return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
        },
    });
}
