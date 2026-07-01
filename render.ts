import { Text, Container, Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { COLLAPSED_ITEM_COUNT } from "./runner.ts";

export interface RenderCallArgs {
    agent?: string;
    task?: string;
    tasks?: Array<{ agent: string; task: string }>;
    chain?: Array<{ agent: string; task: string }>;
    agentScope?: string;
}

export interface RenderResultDetails {
    mode?: string;
    results?: Array<{
        agentName?: string;
        agentSource?: string;
        exitCode?: number;
        messages?: any[];
        usage?: { inputTokens: number; outputTokens: number; cost: number; turns: number };
        stderr?: string;
        outputText?: string;
    }>;
    projectAgentsDir?: string | null;
}

export function renderCall(args: RenderCallArgs, theme: any, _context: any): any {
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
}

export function renderResult(result: any, options: { expanded?: boolean }, theme: any, _context: any): any {
    const details = result.details as RenderResultDetails | undefined;
    if (!details || !details.results?.length) {
        const text = result.content?.[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
    }

    const mode = details.mode || "single";

    if (mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        const isError = (r.exitCode ?? 0) !== 0;
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const agentName = r.agentName || "agent";

        if (options.expanded) {
            const container = new Container();
            let header = `${icon} ${theme.fg("toolTitle", theme.bold(agentName))}${theme.fg("muted", ` (${r.agentSource || "?"})`)}`;
            container.addChild(new Text(header, 0, 0));
            if (r.outputText) {
                container.addChild(new Markdown(r.outputText, 0, 0, getMarkdownTheme()));
            }
            if (r.usage) {
                const usageStr = `↑${r.usage.inputTokens} ↓${r.usage.outputTokens} $${r.usage.cost?.toFixed(4) || 0}`;
                container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
            }
            return container;
        }

        let text = `${icon} ${theme.fg("toolTitle", agentName)}`;
        if (r.outputText) {
            const lines = r.outputText.split("\n").filter(Boolean);
            const shown = lines.slice(-COLLAPSED_ITEM_COUNT);
            text += `\n${theme.fg("toolOutput", shown.join("\n"))}`;
        }
        if (r.usage) {
            text += `\n${theme.fg("dim", `${r.usage.turns || 0} turns ↑${r.usage.inputTokens} ↓${r.usage.outputTokens}`)}`;
        }
        return new Text(text, 0, 0);
    }

    // Multi-result (chain/parallel) — collapsed
    const icon = theme.fg("success", "✓");
    let text = `${icon} ${theme.fg("toolTitle", mode)} ${theme.fg("accent", `${details.results.length} steps`)}`;
    for (const r of details.results) {
        const rIcon = (r.exitCode ?? 0) === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
        text += `\n${rIcon} ${theme.fg("accent", r.agentName || "?")}: ${(r.outputText || "(no output)").slice(0, 80)}`;
    }
    return new Text(text, 0, 0);
}
