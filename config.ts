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
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
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

/** Patch shape accepted by `writeAgentOverride`. */
export interface AgentOverridePatch {
	model?: string;
	tools?: string;
}

/**
 * Atomically merge `patch` into `settings.json` under the `agents[name]` key.
 *
 * Behavior:
 * - Creates the file + `agents` key when missing (without clobbering an
 *   existing top-level shape — when the file is present but malformed, the
 *   write is **aborted** and `false` is returned; we never silently destroy
 *   user data).
 * - Preserves other agents and unrelated top-level keys.
 * - Atomic: writes to `path.tmp` first, then renames (serialized via
 *   `withFileMutationQueue` to avoid races with concurrent readers).
 *
 * Returns `Promise<true>` on success, `Promise<false>` on any I/O / parse
 * failure (does not throw — fail-soft per the v2.0 convention). Async because
 * `withFileMutationQueue` always returns a Promise; callers may await or treat
 * the returned Promise as a thenable.
 */
export function writeAgentOverride(
	name: string,
	patch: AgentOverridePatch,
	settingsPath?: string,
): Promise<boolean> {
	const target = settingsPath ?? defaultSettingsPath();
	return withFileMutationQueue(target, () => {
		let raw: Record<string, unknown> = {};
		try {
			if (fs.existsSync(target)) {
				const text = fs.readFileSync(target, "utf-8");
				const parsed = JSON.parse(text);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					return false;
				}
				raw = parsed as Record<string, unknown>;
			}
		} catch {
			// Malformed JSON or read error — abort the write, do not destroy.
			return false;
		}

		const agentsRaw = raw.agents;
		const agents: Record<string, Record<string, unknown>> =
			agentsRaw && typeof agentsRaw === "object" && !Array.isArray(agentsRaw)
				? (agentsRaw as Record<string, Record<string, unknown>>)
				: {};

		const existing = agents[name];
		const base: Record<string, unknown> =
			existing && typeof existing === "object" && !Array.isArray(existing)
				? { ...existing }
				: {};

		if (patch.model !== undefined) base.model = patch.model;
		if (patch.tools !== undefined) base.tools = patch.tools;

		const next = { ...raw, agents: { ...agents, [name]: base } };

		const tmp = `${target}.tmp`;
		try {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
			try {
				fs.renameSync(tmp, target);
			} catch (renameErr) {
				// Orphan `.tmp` cleanup: if rename fails (e.g. EISDIR/EACCES on
				// the target), remove the temp file so we don't leak cruft on
				// disk. Swallow the cleanup error so we don't shadow the
				// original rename failure.
				try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
				throw renameErr;
			}
			return true;
		} catch {
			return false;
		}
	});
}