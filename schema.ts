/**
 * TypeBox parameter schemas and TypeScript types for the `subagent` tool.
 *
 * Single source of truth for all shapes used by `modes.ts`, `render.ts`, `runner.ts`,
 * and `index.ts`. Internal dependency graph: `schema` depends on nothing else.
 */

import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";

/** Agent scope selector — controls which agent directories are loaded. */
export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

/** One parallel task — single agent, single task, optional cwd. */
export const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

/** One chain step — sequential, supports `{previous}` placeholder in task. */
export const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder for prior output",
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

/** The full `subagent` tool parameter shape. Exactly one mode applies per call. */
export const SubagentParams = Type.Object({
	// single mode
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	// parallel mode
	tasks: Type.Optional(
		Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" }),
	),
	// chain mode
	chain: Type.Optional(
		Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" }),
	),
	// lazy roster discovery
	list: Type.Optional(
		Type.Boolean({ description: "If true, return the roster of available agents and do not spawn." }),
	),
	// scope/confirm
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	// working dir (single mode)
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export type SubagentParamsT = Static<typeof SubagentParams>;
export type TaskItemT = Static<typeof TaskItem>;
export type ChainItemT = Static<typeof ChainItem>;
export type AgentScopeT = Static<typeof AgentScopeSchema>;

/** Per-run token + cost accumulator. */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Single agent run result — what `runner.runSingleAgent` returns. */
export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

/** Top-level detail shape returned in `AgentToolResult.details`. */
export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScopeT;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/** Per-agent override pulled from `settings.json#agents`. */
export interface AgentOverride {
	model?: string;
	tools?: string;
}

/** Empty `UsageStats` — used to seed accumulator and unknown-agent results. */
export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}