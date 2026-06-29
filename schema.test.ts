import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import {
	SubagentParams,
	TaskItem,
	ChainItem,
	AgentScopeSchema,
} from "./schema.ts";

describe("SubagentParams — single mode", () => {
	it("accepts { agent, task }", () => {
		const value = { agent: "scout", task: "find X" };
		expect(() => Value.Clean(SubagentParams, value)).not.toThrow();
		expect(Value.Check(SubagentParams, value)).toBe(true);
	});

	it("accepts optional cwd on single mode", () => {
		const value = { agent: "scout", task: "find X", cwd: "/tmp" };
		expect(Value.Check(SubagentParams, value)).toBe(true);
	});
});

describe("SubagentParams — parallel mode", () => {
	it("accepts { tasks: [{agent, task}] }", () => {
		const value = { tasks: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }] };
		expect(Value.Check(SubagentParams, value)).toBe(true);
	});

	it("accepts optional cwd inside task item", () => {
		const value = { tasks: [{ agent: "a", task: "x", cwd: "/tmp" }] };
		expect(Value.Check(SubagentParams, value)).toBe(true);
	});
});

describe("SubagentParams — chain mode", () => {
	it("accepts { chain: [{agent, task}] }", () => {
		const value = { chain: [{ agent: "a", task: "x" }, { agent: "b", task: "y {previous}" }] };
		expect(Value.Check(SubagentParams, value)).toBe(true);
	});

	it("accepts optional cwd inside chain item", () => {
		const value = { chain: [{ agent: "a", task: "x", cwd: "/tmp" }] };
		expect(Value.Check(SubagentParams, value)).toBe(true);
	});
});

describe("SubagentParams — list mode", () => {
	it("accepts { list: true }", () => {
		expect(Value.Check(SubagentParams, { list: true })).toBe(true);
	});

	it("accepts { list: false }", () => {
		expect(Value.Check(SubagentParams, { list: false })).toBe(true);
	});
});

describe("SubagentParams — agentScope", () => {
	it("accepts 'user' / 'project' / 'both'", () => {
		expect(Value.Check(SubagentParams, { list: true, agentScope: "user" })).toBe(true);
		expect(Value.Check(SubagentParams, { list: true, agentScope: "project" })).toBe(true);
		expect(Value.Check(SubagentParams, { list: true, agentScope: "both" })).toBe(true);
	});

	it("rejects values outside the enum", () => {
		expect(Value.Check(SubagentParams, { list: true, agentScope: "global" })).toBe(false);
		expect(Value.Check(SubagentParams, { list: true, agentScope: "" })).toBe(false);
		expect(Value.Check(SubagentParams, { list: true, agentScope: 123 })).toBe(false);
	});

	it("accepts the schema being absent (default applies at use site)", () => {
		// schema-level default not strictly required; we just check absent is fine
		expect(Value.Check(SubagentParams, { list: true })).toBe(true);
	});
});

describe("SubagentParams — confirmProjectAgents + cwd", () => {
	it("accepts confirmProjectAgents boolean", () => {
		expect(Value.Check(SubagentParams, { list: true, confirmProjectAgents: false })).toBe(true);
		expect(Value.Check(SubagentParams, { list: true, confirmProjectAgents: true })).toBe(true);
	});

	it("accepts top-level cwd", () => {
		expect(Value.Check(SubagentParams, { agent: "scout", task: "x", cwd: "/tmp" })).toBe(true);
	});
});

describe("TaskItem + ChainItem", () => {
	it("TaskItem requires agent + task, allows optional cwd", () => {
		expect(Value.Check(TaskItem, { agent: "a", task: "x" })).toBe(true);
		expect(Value.Check(TaskItem, { agent: "a", task: "x", cwd: "/tmp" })).toBe(true);
		expect(Value.Check(TaskItem, { agent: "a" })).toBe(false);
		expect(Value.Check(TaskItem, { task: "x" })).toBe(false);
		expect(Value.Check(TaskItem, { agent: "a", task: "x", cwd: 1 })).toBe(false);
	});

	it("ChainItem requires agent + task, allows optional cwd", () => {
		expect(Value.Check(ChainItem, { agent: "a", task: "x" })).toBe(true);
		expect(Value.Check(ChainItem, { agent: "a", task: "x", cwd: "/tmp" })).toBe(true);
		expect(Value.Check(ChainItem, { agent: "a" })).toBe(false);
		expect(Value.Check(ChainItem, { task: "x" })).toBe(false);
	});
});

describe("AgentScopeSchema", () => {
	it("accepts valid values", () => {
		expect(Value.Check(AgentScopeSchema, "user")).toBe(true);
		expect(Value.Check(AgentScopeSchema, "project")).toBe(true);
		expect(Value.Check(AgentScopeSchema, "both")).toBe(true);
	});

	it("rejects invalid values", () => {
		expect(Value.Check(AgentScopeSchema, "global")).toBe(false);
		expect(Value.Check(AgentScopeSchema, "")).toBe(false);
		expect(Value.Check(AgentScopeSchema, null)).toBe(false);
		expect(Value.Check(AgentScopeSchema, 42)).toBe(false);
	});
});