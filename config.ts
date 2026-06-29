/**
 * Per-agent overrides from `~/.pi/agent/settings.json#agents`.
 *
 * The "agents" key is unused by pi core; we reuse it to store `model` and `tools`
 * overrides keyed by agent name. Effective value = settings override ?? frontmatter.
 *
 * Direct-read pattern (mirror of sibling `../todo/config.ts`): read + JSON.parse,
 * fail-soft to `{}` on any error. The settings file is read fresh per invocation
 * so edits apply live.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentOverride } from "./schema.ts";

/** Default path: `<agentDir>/settings.json`. */
export function defaultSettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

/** Read `settings.agents` from the given path. Returns `{}` on any failure. */
export function readAgentOverrides(settingsPath: string = defaultSettingsPath()): Record<string, AgentOverride> {
	try {
		if (!fs.existsSync(settingsPath)) return {};
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as { agents?: unknown };
		if (!parsed || typeof parsed !== "object" || !parsed.agents || typeof parsed.agents !== "object") {
			return {};
		}
		// Shallow copy + narrow each value to AgentOverride shape; drop non-object values.
		const out: Record<string, AgentOverride> = {};
		for (const [k, v] of Object.entries(parsed.agents as Record<string, unknown>)) {
			if (v && typeof v === "object") out[k] = v as AgentOverride;
		}
		return out;
	} catch {
		return {};
	}
}

/** Parse a CSV tools string. Trims, drops empties; returns undefined for empty/all-empty input. */
export function parseCsvTools(csv: string | undefined): string[] | undefined {
	if (csv === undefined || csv === null) return undefined;
	const parts = csv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return parts.length > 0 ? parts : undefined;
}

/** Minimal agent shape needed to resolve runtime overrides. */
export interface AgentRuntimeSource {
	model?: string;
	tools?: string[];
}

export interface ResolvedRuntime {
	model?: string;
	tools?: string[];
}

/**
 * Resolve the effective `model` and `tools` for a single agent:
 *   settings override[name] -> frontmatter -> undefined
 * The result omits fields that resolve to undefined so callers can detect
 * "no override at all" vs "override was empty string".
 */
export function resolveAgentRuntime(
	agent: AgentRuntimeSource,
	overrides: Record<string, AgentOverride>,
	agentName?: string,
): ResolvedRuntime {
	const name = agentName ?? (agent as { name?: string }).name;
	const ov = name ? overrides[name] : undefined;

	const out: ResolvedRuntime = {};

	const model = ov?.model ?? agent.model;
	if (model) out.model = model;

	const tools = parseCsvTools(ov?.tools) ?? agent.tools;
	if (tools && tools.length > 0) out.tools = tools;

	return out;
}