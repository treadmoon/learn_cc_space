"use client";

import React, { useMemo, useState } from 'react';
import { Terminal, MessageSquare, Brain, AlertCircle, ChevronRight, ChevronDown, Clock } from 'lucide-react';
import type { T } from './i18n';

export interface LogEntry {
    msg: string;
    reqId: string;
    ts: number;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolOutput?: string;
}

export interface WorkflowStep {
    id: number;
    type: 'thinking' | 'tool_call' | 'response' | 'error' | 'info';
    status: 'running' | 'completed' | 'error';
    label: string;
    detail?: string;
    ts: number;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolOutput?: string;
}

export interface RequestGroup {
    reqId: string;
    steps: WorkflowStep[];
    startTs: number;
}

/** Parse log entries into workflow steps (per-request) */
export function parseLogsToSteps(entries: LogEntry[]): WorkflowStep[] {
    const steps: WorkflowStep[] = [];
    let id = 0;

    for (const entry of entries) {
        const log = entry.msg;

        if (log === '> User prompt sent') {
            const prev = steps[steps.length - 1];
            if (prev && prev.type === 'thinking' && prev.status === 'running') prev.status = 'completed';
            steps.push({ id: id++, type: 'thinking', status: 'running', label: '__thinking__', ts: entry.ts });
        } else if (log.startsWith('Tool: ')) {
            const prev = steps[steps.length - 1];
            if (prev && prev.type === 'thinking' && prev.status === 'running') prev.status = 'completed';

            const match = log.match(/^Tool: (\S+)\s*(.*)/);
            const name = match?.[1] || entry.toolName || 'unknown';
            const args = match?.[2]?.replace(/\.\.\.$/, '') || '';
            steps.push({
                id: id++, type: 'tool_call', status: 'running', label: name,
                detail: args, ts: entry.ts,
                toolName: entry.toolName || name,
                toolArgs: entry.toolArgs,
            });
        } else if (log.startsWith('Result: ')) {
            const prev = steps[steps.length - 1];
            if (prev && prev.type === 'tool_call' && prev.status === 'running') {
                prev.status = 'completed';
                prev.detail = log.slice(8, 80).replace(/\.\.\.$/, '');
                prev.toolOutput = entry.toolOutput;
            }
        } else if (log.startsWith('[ERROR]') || log.startsWith('[PARSE_ERROR]')) {
            const prev = steps[steps.length - 1];
            if (prev && prev.status === 'running') {
                prev.status = 'error';
                prev.detail = log.slice(0, 80);
            } else {
                steps.push({ id: id++, type: 'error', status: 'error', label: 'Error', detail: log.slice(0, 80), ts: entry.ts });
            }
        } else if (log === 'Received background notifications') {
            steps.push({ id: id++, type: 'response', status: 'completed', label: '__bgnotify__', ts: entry.ts });
        } else if (log.startsWith('[COMPACT]')) {
            steps.push({ id: id++, type: 'info', status: 'completed', label: '__compact__', detail: log, ts: entry.ts });
        } else if (log.startsWith('Response: ')) {
            const prev = steps[steps.length - 1];
            if (prev && prev.type === 'thinking' && prev.status === 'running') prev.status = 'completed';
            steps.push({ id: id++, type: 'response', status: 'completed', label: '__response__', detail: log.slice(10, 100), ts: entry.ts });
        } else if (log.startsWith('LLM call failed')) {
            steps.push({ id: id++, type: 'info', status: 'completed', label: '__retry__', detail: log, ts: entry.ts });
        } else if (log === '> Abort signal sent') {
            steps.push({ id: id++, type: 'error', status: 'error', label: '__abort__', detail: '__abort_detail__', ts: entry.ts });
        }
    }

    return steps;
}

/** Group log entries by requestId */
export function groupByRequest(entries: LogEntry[]): RequestGroup[] {
    const groups = new Map<string, LogEntry[]>();
    for (const entry of entries) {
        const key = entry.reqId || 'unknown';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(entry);
    }
    return Array.from(groups.entries()).map(([reqId, groupEntries]) => ({
        reqId,
        steps: parseLogsToSteps(groupEntries),
        startTs: groupEntries[0]?.ts || 0,
    }));
}

const ICON_MAP: Record<string, React.ReactNode> = {
    thinking: <Brain className="w-3 h-3" />,
    tool_call: <Terminal className="w-3 h-3" />,
    response: <MessageSquare className="w-3 h-3" />,
    error: <AlertCircle className="w-3 h-3" />,
    info: <Clock className="w-3 h-3" />,
};

const STATUS_STYLES: Record<string, { node: string; line: string; text: string }> = {
    completed: { node: 'bg-[#2DD4BF] text-[var(--bg-0)]', line: 'bg-[#2DD4BF]/30', text: 'text-[var(--text-secondary)]' },
    running:   { node: 'bg-[#38BDF8] text-[var(--bg-0)] blink', line: 'bg-[#38BDF8]/30', text: 'text-[var(--text-primary)]' },
    error:     { node: 'bg-[#F87171] text-[var(--bg-0)]', line: 'bg-[#F87171]/30', text: 'text-[#F87171]' },
};

interface WorkflowViewProps {
    logs: LogEntry[];
    agentStatus: string;
    t: T;
}

const LABEL_MAP: Record<string, (t: T) => string> = {
    '__thinking__': t => t.wfThinking,
    '__bgnotify__': t => t.wfBgNotify,
    '__response__': t => t.wfResponse,
    '__retry__': t => t.wfRetry,
    '__abort__': t => t.wfAbort,
    '__abort_detail__': t => t.wfAbort,
    '__compact__': t => t.wfCompact,
};

function resolveLabel(label: string, t: T): string {
    const resolver = LABEL_MAP[label];
    return resolver ? resolver(t) : label;
}

function ToolDetail({ step, t }: { step: WorkflowStep; t: T }) {
    const [open, setOpen] = useState(false);
    const hasDetail = step.toolArgs || step.toolOutput;

    if (!hasDetail) return null;

    return (
        <div className="mt-1">
            <button onClick={() => setOpen(!open)}
                className="flex items-center gap-1 text-[9px] text-[var(--text-ghost)] hover:text-[var(--text-muted)] transition-colors font-mono">
                {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                {open ? t.wfCollapseDetail : t.wfExpandDetail}
            </button>
            {open && (
                <div className="mt-1.5 space-y-2 animate-in">
                    {step.toolArgs && Object.keys(step.toolArgs).length > 0 && (
                        <div>
                            <div className="text-[9px] text-[var(--text-ghost)] font-mono uppercase tracking-wider mb-1">{t.wfInput}</div>
                            <pre className="text-[10px] text-[#38BDF8]/80 font-mono bg-[var(--bg-0)] rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                                {JSON.stringify(step.toolArgs, null, 2)}
                            </pre>
                        </div>
                    )}
                    {step.toolOutput && (
                        <div>
                            <div className="text-[9px] text-[var(--text-ghost)] font-mono uppercase tracking-wider mb-1">{t.wfOutput}</div>
                            <pre className="text-[10px] text-[#2DD4BF]/80 font-mono bg-[var(--bg-0)] rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                                {step.toolOutput}
                            </pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function StepItem({ step, isLast, agentStatus, t }: { step: WorkflowStep; isLast: boolean; agentStatus: string; t: T }) {
    const s = STATUS_STYLES[step.status] || STATUS_STYLES.completed;
    const isRunning = step.status === 'running' && agentStatus !== 'idle';

    return (
        <div className="flex gap-3 min-h-[32px]">
            <div className="flex flex-col items-center w-5 shrink-0">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${s.node}`}>
                    {step.status === 'error' ? <AlertCircle className="w-3 h-3" /> : ICON_MAP[step.type]}
                </div>
                {!isLast && <div className={`w-0.5 flex-1 min-h-[8px] ${s.line}`} />}
            </div>
            <div className="flex-1 pb-2 min-w-0">
                <div className="flex items-center gap-2">
                    <span className={`text-[11px] font-semibold font-mono ${s.text}`}>{resolveLabel(step.label, t)}</span>
                    {isRunning && <span className="text-[9px] text-[#38BDF8] font-mono">运行中</span>}
                </div>
                {step.detail && (
                    <p className="text-[10px] text-[var(--text-muted)] font-mono mt-0.5 truncate">{step.detail}</p>
                )}
                {step.type === 'tool_call' && <ToolDetail step={step} t={t} />}
            </div>
        </div>
    );
}

function RequestGroupView({ group, isLast, agentStatus, t }: { group: RequestGroup; isLast: boolean; agentStatus: string; t: T }) {
    const [collapsed, setCollapsed] = useState(false);
    const time = new Date(group.startTs);
    const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;
    const isClient = group.reqId === 'client';

    return (
        <div className="mb-2">
            <button onClick={() => setCollapsed(!collapsed)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--bg-2)] transition-colors text-left">
                {collapsed ? <ChevronRight className="w-3 h-3 text-[var(--text-ghost)]" /> : <ChevronDown className="w-3 h-3 text-[var(--text-ghost)]" />}
                <span className="text-[10px] font-mono text-[var(--text-muted)]">
                    {isClient ? t.wfClientReq : `${t.wfRequest} ${group.reqId.slice(0, 6)}`}
                </span>
                <span className="text-[9px] text-[var(--text-ghost)] font-mono">{timeStr}</span>
                <span className="text-[9px] text-[var(--text-ghost)] font-mono ml-auto">{group.steps.length} {t.wfSteps}</span>
            </button>
            {!collapsed && (
                <div className="pl-2">
                    {group.steps.map((step, i) => (
                        <StepItem key={step.id} step={step} isLast={i === group.steps.length - 1} agentStatus={agentStatus} t={t} />
                    ))}
                </div>
            )}
        </div>
    );
}

export function WorkflowView({ logs, agentStatus, t }: WorkflowViewProps) {
    const groups = useMemo(() => groupByRequest(logs), [logs]);

    if (groups.length === 0) {
        return <div className="p-4 text-[var(--text-ghost)] italic text-[11px]">{t.wfWaiting}</div>;
    }

    return (
        <div className="p-3">
            {groups.map((group, i) => (
                <RequestGroupView key={group.reqId + '-' + i} group={group} isLast={i === groups.length - 1} agentStatus={agentStatus} t={t} />
            ))}
        </div>
    );
}
