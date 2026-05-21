"use client";

import React, { useMemo, useState } from 'react';
import {
    Brain, Terminal, MessageSquare, AlertCircle, Clock, CheckCircle2,
    Plus, RefreshCw, Trash2, UserCircle, ChevronRight, ChevronDown,
    FileText, Zap, Package
} from 'lucide-react';
import type { LogEntry } from './WorkflowView';
import type { T } from './i18n';

interface AuditEntry {
    ts: string;
    action: string;
    taskId: number;
    actor: string;
    details: Record<string, unknown>;
}

interface TimelineItem {
    ts: number;
    type: string;
    icon: React.ReactNode;
    color: string;
    bg: string;
    label: string;
    detail?: string;
    extra?: Record<string, unknown>;
}

function buildTimeline(logs: LogEntry[], auditLog: AuditEntry[]): TimelineItem[] {
    const items: TimelineItem[] = [];

    for (const entry of logs) {
        const msg = entry.msg;

        if (msg === '> User prompt sent') {
            items.push({ ts: entry.ts, type: 'user_prompt', icon: <UserCircle className="w-3 h-3" />, color: 'text-[var(--color-accent)]', bg: 'bg-[var(--color-accent)]/10', label: '用户发送消息' });
        } else if (msg.startsWith('Tool: ')) {
            const match = msg.match(/^Tool: (\S+)/);
            const name = match?.[1] || 'unknown';
            items.push({ ts: entry.ts, type: 'tool_call', icon: <Terminal className="w-3 h-3" />, color: 'text-[var(--color-accent2)]', bg: 'bg-[var(--color-accent2)]/10', label: `调用 ${name}`, detail: entry.toolArgs ? JSON.stringify(entry.toolArgs).slice(0, 120) : undefined, extra: { toolArgs: entry.toolArgs } });
        } else if (msg.startsWith('Result: ')) {
            items.push({ ts: entry.ts, type: 'tool_result', icon: <CheckCircle2 className="w-3 h-3" />, color: 'text-[var(--color-teal)]', bg: 'bg-[var(--color-teal)]/10', label: '工具返回', detail: entry.toolOutput?.slice(0, 120) });
        } else if (msg.startsWith('Response: ')) {
            items.push({ ts: entry.ts, type: 'response', icon: <MessageSquare className="w-3 h-3" />, color: 'text-[var(--color-teal)]', bg: 'bg-[var(--color-teal)]/10', label: '生成回复', detail: msg.slice(10, 150) });
        } else if (msg.startsWith('[COMPACT]')) {
            items.push({ ts: entry.ts, type: 'compact', icon: <Package className="w-3 h-3" />, color: 'text-[var(--color-warn)]', bg: 'bg-[var(--color-warn)]/10', label: '上下文压缩', detail: msg });
        } else if (msg.startsWith('[ERROR]') || msg.startsWith('[PARSE_ERROR]')) {
            items.push({ ts: entry.ts, type: 'error', icon: <AlertCircle className="w-3 h-3" />, color: 'text-[var(--color-danger)]', bg: 'bg-[var(--color-danger)]/10', label: '错误', detail: msg.slice(0, 120) });
        } else if (msg.startsWith('LLM call failed')) {
            items.push({ ts: entry.ts, type: 'retry', icon: <RefreshCw className="w-3 h-3" />, color: 'text-[var(--color-warn)]', bg: 'bg-[var(--color-warn)]/10', label: 'LLM 重试', detail: msg });
        } else if (msg === 'Received background notifications') {
            items.push({ ts: entry.ts, type: 'bg_notify', icon: <Zap className="w-3 h-3" />, color: 'text-[var(--color-accent)]', bg: 'bg-[var(--color-accent)]/10', label: '后台任务通知' });
        } else if (msg === '> Abort signal sent') {
            items.push({ ts: entry.ts, type: 'abort', icon: <AlertCircle className="w-3 h-3" />, color: 'text-[var(--color-danger)]', bg: 'bg-[var(--color-danger)]/10', label: '用户中止' });
        }
    }

    for (const entry of auditLog) {
        const ts = new Date(entry.ts).getTime();
        const actionIcons: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
            create: { icon: <Plus className="w-3 h-3" />, color: 'text-[var(--color-teal)]', bg: 'bg-[var(--color-teal)]/10' },
            update: { icon: <RefreshCw className="w-3 h-3" />, color: 'text-[var(--color-accent)]', bg: 'bg-[var(--color-accent)]/10' },
            delete: { icon: <Trash2 className="w-3 h-3" />, color: 'text-[var(--color-danger)]', bg: 'bg-[var(--color-danger)]/10' },
            claim: { icon: <FileText className="w-3 h-3" />, color: 'text-[var(--color-accent2)]', bg: 'bg-[var(--color-accent2)]/10' },
        };
        const a = actionIcons[entry.action] || actionIcons.update;
        const statusDetail = entry.details?.status ? `→ ${entry.details.status}` : '';
        items.push({
            ts, type: `task_${entry.action}`, icon: a.icon, color: a.color, bg: a.bg,
            label: `任务 #${entry.taskId} ${entry.action}`,
            detail: `${entry.actor}${statusDetail}`.trim(),
        });
    }

    items.sort((a, b) => a.ts - b.ts);
    return items;
}

function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

interface TimelineViewProps {
    logs: LogEntry[];
    auditLog: AuditEntry[];
    t: T;
}

export function TimelineView({ logs, auditLog, t }: TimelineViewProps) {
    const items = useMemo(() => buildTimeline(logs, auditLog), [logs, auditLog]);
    const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

    if (items.length === 0) {
        return <div className="p-4 text-[var(--text-ghost)] italic text-[11px]">{t.wfWaiting}</div>;
    }

    return (
        <div className="p-3">
            {items.map((item, i) => {
                const isExpanded = expandedIdx === i;
                const hasExpandable = item.type === 'tool_call' && !!item.extra?.toolArgs;

                return (
                    <div key={i} className="flex gap-3 min-h-[28px]">
                        {/* Timeline column */}
                        <div className="flex flex-col items-center w-5 shrink-0">
                            <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${item.bg} ${item.color}`}>
                                {item.icon}
                            </div>
                            {i < items.length - 1 && <div className="w-0.5 flex-1 min-h-[4px] bg-[var(--bg-4)]" />}
                        </div>

                        {/* Content */}
                        <div className="flex-1 pb-2 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] font-mono text-[var(--text-ghost)]">{formatTime(item.ts)}</span>
                                <span className={`text-[11px] font-semibold ${item.color}`}>{item.label}</span>
                            </div>
                            {item.detail && !hasExpandable && (
                                <p className="text-[10px] text-[var(--text-muted)] font-mono mt-0.5 truncate">{item.detail}</p>
                            )}
                            {hasExpandable && (
                                <div className="mt-0.5">
                                    <button onClick={() => setExpandedIdx(isExpanded ? null : i)}
                                        className="flex items-center gap-1 text-[9px] text-[var(--text-ghost)] hover:text-[var(--text-muted)] transition-colors font-mono">
                                        {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                        {isExpanded ? t.wfCollapseDetail : t.wfExpandDetail}
                                    </button>
                                    {isExpanded && (
                                        <pre className="mt-1 text-[10px] text-[var(--color-accent2)]/80 font-mono bg-[var(--bg-0)] rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                                            {JSON.stringify(item.extra!.toolArgs, null, 2)}
                                        </pre>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
