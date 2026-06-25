# Product Requirements Document: @aprimediet/minion

**Version:** 1.0
**Date:** 2026-06-25
**Status:** Draft

## Overview

minion brings structured, Claude-Code-style delegation to the pi coding agent — a task tracker, a subagent dispatch system for delegating work to specialized agents in isolated subprocesses, a persistent kanban board for cross-session work management, and a bundled library of 12 specialized coding agents with per-agent model configuration.

## Problem Statement

The pi coding agent is powerful but lacks structured delegation. Complex, multi-step work — code exploration, planning, review, debugging, testing — all happens in a single agent context, which fills up the context window and limits focus. There is no way to:
- Track multi-step progress with explicit task checklists
- Dispatch well-scoped sub-tasks to specialized agents running in isolated contexts
- Persist work-in-progress across pi sessions
- Resume unfinished work automatically when starting a new session
- Keep the working tree clean while storing operational data

## Goals

- Provide a `todo_write` tool so the agent can track multi-step work with exactly one active task at a time
- Provide a `subagent` tool that delegates tasks to specialized agents running as isolated `pi` subprocesses (single / parallel / chain modes)
- Provide a `task` tool backed by a persistent kanban board (survives across sessions) with status columns: backlog → todo → in_progress → blocked → review → done → cancelled
- Ship 12 specialized agents (explore, plan, general-purpose, code-reviewer, code-simplifier, debugger, test-writer, docs-writer, silent-failure-hunter, type-design-analyzer, comment-analyzer, pr-test-analyzer) with sensible per-agent model defaults
- Keep the working tree clean — only a single `.pi/<project-id>.md` marker file is written to the repository; everything else lives under `~/.pi/projects/<id>/`
- Resume unfinished board tasks at session start by delegating them to their designated agent
- Share the project workspace with `@aprimediet/memory` (same project ID algorithm, same marker file)

## Non-Goals

- Replacing external project management tools (Jira, Linear, GitHub Projects)
- Providing a generic workflow engine for CI/CD or external process orchestration
- Running agents outside the pi ecosystem
- Providing a web UI or API server
- Supporting real-time collaboration across multiple users

## Target Users

- Pi coding agent users — developers who use pi for complex, multi-step coding tasks
- AI coding agents themselves — the LLM uses the tools and subagents to decompose and delegate work

## Key Features

### In-Session Task Tracker (todo_write)
The agent maintains a full task checklist that replaces the previous state on each call. Exactly one task is `in_progress` at a time. The list is rendered as a checkbox tree in the TUI. Snapshots are persisted to disk per session.

### Subagent Delegation (subagent)
Delegates work to any of 12 specialized agents in an isolated `pi` subprocess. Three modes:
- **Single**: one agent, one task
- **Parallel**: up to 8 agents running concurrently (max 4 at once), each with output capped at 50KB
- **Chain**: sequential steps where each agent's output feeds the next via `{previous}`

### Persistent Kanban Board (task)
A full kanban board stored as markdown card files under `~/.pi/projects/<id>/tasks/`. Cards carry a status column, designated agent (assignee), structured instruction, acceptance criteria, dependency tracking, and an activity log. Unfinished cards are surfaced at session start for automatic resumption.

### 12 Bundled Specialized Agents
No install step needed — agents are bundled inside the extension and discovered automatically:
- **Explorer** (fast, Haiku) — broad codebase exploration
- **Planner** (Sonnet) — architecture design (read-only)
- **General Purpose** (Sonnet) — implementation
- **Code Reviewer** (Opus) — code review
- **Code Simplifier** (Sonnet) — refactoring
- **Debugger** (Sonnet) — root-cause analysis
- **Test Writer** (Sonnet) — test generation
- **Docs Writer** (Haiku) — documentation
- Plus: Silent Failure Hunter, Type Design Analyzer, Comment Analyzer, PR Test Analyzer

### Per-Agent Model Configuration
Default models per agent are defined in `minion.json`. Users can override globally or per-project. Resolution: project per-name → global per-name → project wildcard → global wildcard → frontmatter → environment variable → pi default.

### Clean Working Tree
The only artifact written into the repository is a single `.pi/<project-id>.md` marker file. Tasks, todos, delegation records, and project metadata live under `~/.pi/projects/<id>/`.

## Success Metrics

- Agents can reliably decompose complex tasks and delegate sub-steps to specialized subagents
- Tasks survive across pi sessions without data loss
- The working tree remains clean (only the marker file is ever written)
- Users can view and manage their task board with a simple `/tasks` command
- Unfinished tasks are automatically surfaced and resumable at session start

## Scope & Boundaries

**In scope:**
- todo_write tool for in-session task checklists
- subagent tool for delegating work to specialized agents
- task tool for a persistent kanban board
- 12 bundled agents with per-agent model config
- Session-start resume of unfinished tasks
- Shared workspace with @aprimediet/memory

**Out of scope:**
- External API or web interface
- Multi-user collaboration
- CI/CD pipeline integration
- Database or cloud service integration
- Generic workflow engine

## Open Questions

- Should subagent delegation records be queryable/filterable from within the agent?
- Should there be an option to auto-archive completed tasks after a configurable threshold?
- Should the kanban board support swimlanes or custom statuses?
