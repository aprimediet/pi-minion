/**
 * Project identity + path layout for minion's persistent delegation/task board.
 *
 * The working tree stays clean: the only artifact written into <cwd>/.pi is a single identifier
 * file `<project-id>.md`. Tasks, todos and delegation records live globally under
 * ~/.pi/projects/<project-id>/.
 *
 * IMPORTANT: this is intentionally COMPATIBLE with @aprimediet/memory's project.ts — same id
 * algorithm (`<slug>-<sha1(root)[:8]>`), same marker format (`pi-project: true` + `id`), same
 * detection. So both extensions share ONE cwd marker and ONE ~/.pi/projects/<id>/ workspace.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface ProjectPaths {
	id: string;
	root: string;
	configDir: string; // <root>/.pi
	markerPath: string; // <root>/.pi/<id>.md
	globalDir: string; // ~/.pi/projects/<id>
	tasksDir: string; // <globalDir>/tasks
	todosDir: string; // <globalDir>/todos
	delegationsDir: string; // <globalDir>/delegations
	projectJson: string; // <globalDir>/project.json
}

function piHome(): string {
	return path.dirname(getAgentDir()); // getAgentDir() === ~/.pi/agent
}
export function projectsRoot(): string {
	return path.join(piHome(), "projects");
}

function slug(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return s || "project";
}
function pathHash(abs: string): string {
	return crypto.createHash("sha1").update(abs).digest("hex").slice(0, 8);
}

function findProjectRoot(cwd: string): string {
	let dir = cwd;
	for (;;) {
		if (fs.existsSync(path.join(dir, CONFIG_DIR_NAME)) || fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return cwd;
		dir = parent;
	}
}

function readMarker(configDir: string): { id: string; file: string } | null {
	if (!fs.existsSync(configDir)) return null;
	let names: string[];
	try {
		names = fs.readdirSync(configDir).filter((n) => n.endsWith(".md"));
	} catch {
		return null;
	}
	for (const name of names) {
		const file = path.join(configDir, name);
		try {
			const { frontmatter } = parseFrontmatter<Record<string, string>>(fs.readFileSync(file, "utf-8"));
			if (frontmatter && String(frontmatter["pi-project"]) === "true" && frontmatter.id) return { id: frontmatter.id, file };
		} catch {
			/* not a marker */
		}
	}
	return null;
}

function pathsForId(id: string, root: string, configDir: string, markerPath: string): ProjectPaths {
	const globalDir = path.join(projectsRoot(), id);
	return {
		id,
		root,
		configDir,
		markerPath,
		globalDir,
		tasksDir: path.join(globalDir, "tasks"),
		todosDir: path.join(globalDir, "todos"),
		delegationsDir: path.join(globalDir, "delegations"),
		projectJson: path.join(globalDir, "project.json"),
	};
}

/** Resolve project identity for a cwd (read-only — creates nothing). */
export function resolveProject(cwd: string): ProjectPaths {
	const root = findProjectRoot(cwd);
	const configDir = path.join(root, CONFIG_DIR_NAME);
	const existing = readMarker(configDir);
	const id = existing?.id ?? `${slug(path.basename(root))}-${pathHash(root)}`;
	const markerPath = existing?.file ?? path.join(configDir, `${id}.md`);
	return pathsForId(id, root, configDir, markerPath);
}

function markerBody(id: string, createdISO: string): string {
	return [
		"---",
		"pi-project: true",
		`id: ${id}`,
		`created: ${createdISO}`,
		"---",
		"# pi project",
		"",
		"This file marks this directory as a pi project. To keep your working tree clean, pi",
		"extensions store their per-project data globally — NOT here — under:",
		"",
		`    ~/.pi/projects/${id}/`,
		"",
		"minion stores here:",
		"- `tasks/`       persistent kanban task cards (delegation board)",
		"- `todos/`       in-session todo snapshots",
		"- `delegations/` full records of every subagent delegation",
		"",
		"Managed by pi extensions (@aprimediet/minion, @aprimediet/memory). Safe to commit",
		"(stable id) and safe to delete (recreated).",
		"",
	].join("\n");
}

/** Create the global directory structure + the cwd marker (idempotent). */
export async function ensureProject(cwd: string): Promise<ProjectPaths> {
	const p = resolveProject(cwd);
	const nowISO = new Date().toISOString();

	for (const dir of [p.tasksDir, p.todosDir, p.delegationsDir]) fs.mkdirSync(dir, { recursive: true });

	if (!fs.existsSync(p.markerPath)) {
		fs.mkdirSync(p.configDir, { recursive: true });
		await withFileMutationQueue(p.markerPath, async () => {
			const tmp = `${p.markerPath}.tmp`;
			await fs.promises.writeFile(tmp, markerBody(p.id, nowISO), { encoding: "utf-8", mode: 0o644 });
			await fs.promises.rename(tmp, p.markerPath);
		});
	}

	// project.json — shared with the memory extension; preserve unknown keys, just update ours.
	try {
		let meta: Record<string, unknown> = {};
		try {
			meta = JSON.parse(fs.readFileSync(p.projectJson, "utf-8")) as Record<string, unknown>;
		} catch {
			/* first run */
		}
		meta.id = p.id;
		meta.name = meta.name ?? path.basename(p.root);
		const paths = Array.isArray(meta.paths) ? (meta.paths as string[]) : [];
		if (!paths.includes(p.root)) paths.push(p.root);
		meta.paths = paths;
		meta.created = meta.created ?? nowISO;
		meta.lastSeen = nowISO;
		await withFileMutationQueue(p.projectJson, async () => {
			const tmp = `${p.projectJson}.tmp`;
			await fs.promises.writeFile(tmp, JSON.stringify(meta, null, 2), { encoding: "utf-8", mode: 0o600 });
			await fs.promises.rename(tmp, p.projectJson);
		});
	} catch {
		/* non-fatal */
	}

	return p;
}
