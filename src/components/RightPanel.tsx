"use client";

import React, { useRef, useEffect, useState } from 'react';
import { Activity, Clock, Terminal, Zap, GitGraph, History, BookOpen } from 'lucide-react';
import { Section } from './Section';
import { WorkflowView, type LogEntry } from './WorkflowView';
import { TimelineView } from './TimelineView';
import type { T } from './i18n';

interface Props {
    t: T;
    telemetry: { totalSession: number; lastRequest: number; totalRequests: number; lastPrompt: number; lastCompletion: number };
    teammates: Array<{ name: string; role: string; status: string }>;
    bgTasks: Array<{ id: string; command: string; status: string }>;
    cronTasks: Array<{ id: string; command: string; intervalMs: number; lastRun: string | null; count: number }>;
    logs: LogEntry[];
    agentStatus: string;
    auditLog?: Array<{ ts: string; action: string; taskId: number; actor: string; details: Record<string, unknown> }>;
    knowledge?: { docCount: number; chunkCount: number; sources: Array<{ source: string; chunkCount: number; ingestedAt: string }> };
}

function fmt(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}

export function RightPanel({ t, telemetry, teammates, bgTasks, cronTasks, logs, agentStatus, auditLog, knowledge }: Props) {
    const logRef = useRef<HTMLDivElement>(null);
    const [tab, setTab] = useState<'flow' | 'logs' | 'timeline'>('flow');
    useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

    return (
        <div className="flex flex-col h-full">
            <div className="h-12 topbar-purple flex items-center px-4 gap-2.5 shrink-0">
                <span className="w-2 h-2 rounded-full bg-[#818CF8]" />
                <h2 className="sh sh-indigo">{t.sysHub}</h2>
            </div>

            {/* Telemetry */}
            <div className="px-4 py-3 bg-[var(--bg-0)] flex items-center justify-around shrink-0">
                <Metric label={t.sessionRounds} value={String(telemetry.totalRequests)} color="text-[var(--text-primary)]" />
                <div className="w-px h-8 bg-[var(--bg-3)]" />
                <Metric label={t.lastReqTokens} value={fmt(telemetry.lastRequest)} color="text-[#38BDF8]"
                    icon={<Zap className="w-3 h-3 inline -mt-0.5 mr-0.5 opacity-60" />}
                    sub={telemetry.lastRequest > 0 ? `↑${fmt(telemetry.lastPrompt)} ↓${fmt(telemetry.lastCompletion)}` : undefined} />
                <div className="w-px h-8 bg-[var(--bg-3)]" />
                <Metric label={t.totalSessionTokens} value={fmt(telemetry.totalSession)} color="text-[#818CF8]" />
            </div>

            <div className="flex flex-col flex-1 overflow-hidden">
                <div className="overflow-y-auto scrollbar-hide flex-1">
                    <Section title={t.teammates} titleClass="sh sh-indigo"
                        count={teammates.length > 0 ? <span className="tag tag-gray">{teammates.length}</span> : undefined}>
                        {teammates.length === 0 ? (
                            <p className="text-[12px] text-[var(--text-ghost)] italic">{t.noTeammates}</p>
                        ) : (
                            <div className="flex flex-wrap gap-1.5">
                                {teammates.map((m, idx) => (
                                    <div key={idx} className="group/tip relative flex items-center gap-1.5 bg-[var(--bg-3)] rounded-md px-2 py-1 cursor-default">
                                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.status === 'working' ? 'bg-[#2DD4BF] blink' : 'bg-[var(--text-ghost)]'}`} />
                                        <span className="text-[11px] text-[var(--text-secondary)] font-medium">{m.name}</span>
                                        {/* Tooltip — opens downward to avoid overflow clipping */}
                                        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 invisible group-hover/tip:visible opacity-0 group-hover/tip:opacity-100 transition-all duration-150 z-50 pointer-events-none">
                                            <div className="flex justify-center">
                                                <div className="border-4 border-transparent border-b-[var(--bg-4)]" />
                                            </div>
                                            <div className="px-2.5 py-1.5 rounded-md bg-[var(--bg-4)] text-[10px] whitespace-nowrap shadow-xl ring-1 ring-white/5">
                                                <div className="text-[var(--text-primary)] font-medium">{m.role}</div>
                                                <div className={`text-[9px] mt-0.5 ${m.status === 'working' ? 'text-[#2DD4BF]' : 'text-[var(--text-muted)]'}`}>{m.status}</div>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Section>

                    <div className="divider" />

                    <Section title={t.activeProcess} titleClass="sh sh-sky"
                        icon={<Activity className="w-3.5 h-3.5 text-[#38BDF8]" />}
                        count={bgTasks.length > 0 ? <span className="tag tag-sky">{bgTasks.length}</span> : undefined}
                        defaultOpen={bgTasks.length > 0}>
                        {bgTasks.length === 0 ? (
                            <p className="text-[12px] text-[var(--text-ghost)] italic">{t.noProcess}</p>
                        ) : (
                            <ul className="space-y-2">
                                {bgTasks.map((task, idx) => (
                                    <li key={idx} className="card p-3">
                                        <div className="flex justify-between items-center">
                                            <span className="font-mono text-[11px] text-[var(--text-secondary)]">{task.id}</span>
                                            <span className="tag tag-sky blink">{task.status}</span>
                                        </div>
                                        <span className="text-[11px] text-[var(--text-muted)] truncate block mt-1 font-mono">{task.command}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Section>

                    <div className="divider" />

                    <Section title={t.daemons} titleClass="sh sh-amber"
                        icon={<Clock className="w-3.5 h-3.5 text-[#FBBF24]" />}
                        count={cronTasks.length > 0 ? <span className="tag tag-amber">{cronTasks.length}</span> : undefined}
                        defaultOpen={cronTasks.length > 0}>
                        {cronTasks.length === 0 ? (
                            <p className="text-[12px] text-[var(--text-ghost)] italic">{t.noDaemons}</p>
                        ) : (
                            <ul className="space-y-2">
                                {cronTasks.map((c, idx) => (
                                    <li key={idx} className="card p-3">
                                        <div className="flex justify-between items-center">
                                            <span className="text-[11px] text-[var(--text-primary)] font-medium">{c.id}</span>
                                            <span className="font-mono text-[10px] text-[var(--text-muted)]">{c.intervalMs}ms · {c.count}×</span>
                                        </div>
                                        <span className="text-[11px] text-[var(--text-muted)] truncate block mt-1 font-mono">{c.command}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Section>

                    <div className="divider" />

                    <Section title={t.auditLog} titleClass="sh sh-teal"
                        icon={<Clock className="w-3.5 h-3.5 text-[#2DD4BF]" />}
                        count={auditLog && auditLog.length > 0 ? <span className="tag tag-teal">{auditLog.length}</span> : undefined}
                        defaultOpen={false}>
                        {!auditLog || auditLog.length === 0 ? (
                            <p className="text-[12px] text-[var(--text-ghost)] italic">{t.noAudit}</p>
                        ) : (
                            <ul className="space-y-1.5">
                                {auditLog.map((entry, idx) => {
                                    const actionMap: Record<string, { icon: string; tagCls: string }> = {
                                        create: { icon: '+', tagCls: 'tag tag-teal' },
                                        update: { icon: '↻', tagCls: 'tag tag-sky' },
                                        delete: { icon: '✕', tagCls: 'tag tag-red' },
                                        claim: { icon: '◎', tagCls: 'tag tag-indigo' },
                                    };
                                    const a = actionMap[entry.action] || actionMap.update;
                                    const time = new Date(entry.ts);
                                    const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
                                    return (
                                        <li key={idx} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--bg-3)] transition-colors">
                                            <span className={`${a.tagCls} shrink-0`}>{a.icon}</span>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-1.5">
                                                    <span className="font-mono text-[10px] text-[var(--text-muted)]">#{entry.taskId}</span>
                                                    <span className="text-[11px] text-[var(--text-secondary)]">{entry.action}</span>
                                                </div>
                                                <div className="text-[10px] text-[var(--text-ghost)]">
                                                    {entry.actor} · {timeStr}
                                                    {entry.details?.reqId != null && <span className="ml-1 text-[var(--text-ghost)]/50">#{String(entry.details.reqId).slice(0, 4)}</span>}
                                                </div>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </Section>

                    <div className="divider" />

                    <Section title={t.knowledgeStats} titleClass="sh sh-amber"
                        icon={<BookOpen className="w-3.5 h-3.5 text-[#FBBF24]" />}
                        count={knowledge && knowledge.docCount > 0 ? <span className="tag tag-amber">{knowledge.docCount}</span> : undefined}
                        defaultOpen={false}>
                        {!knowledge || knowledge.docCount === 0 ? (
                            <p className="text-[12px] text-[var(--text-ghost)] italic">{t.knowledgeEmpty}</p>
                        ) : (
                            <div className="space-y-2">
                                <div className="flex items-center gap-3 text-[11px]">
                                    <span className="text-[var(--text-ghost)]">{t.knowledgeDocCount}: <span className="text-[var(--text-primary)] font-mono font-semibold">{knowledge.docCount}</span></span>
                                    <span className="text-[var(--text-ghost)]">{t.knowledgeChunkCount}: <span className="text-[var(--text-primary)] font-mono font-semibold">{knowledge.chunkCount}</span></span>
                                </div>
                                <ul className="space-y-1">
                                    {knowledge.sources.map((s, idx) => (
                                        <li key={idx} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--bg-3)] transition-colors">
                                            <BookOpen className="w-3 h-3 text-[#FBBF24]/60 shrink-0" />
                                            <span className="text-[10px] font-mono text-[var(--text-secondary)] truncate flex-1">{s.source}</span>
                                            <span className="text-[9px] font-mono text-[var(--text-ghost)]">{s.chunkCount}c</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </Section>
                </div>

                <div className="divider" />

                {/* Workflow / Logs — tabbed */}
                <div className="flex-1 flex flex-col overflow-hidden bg-[var(--bg-0)] min-h-[120px]">
                    <div className="px-2 py-1.5 flex items-center gap-1 shrink-0 bg-[var(--bg-1)]">
                        <button onClick={() => setTab('flow')}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-semibold font-mono uppercase tracking-wider transition-colors ${
                                tab === 'flow' ? 'bg-[var(--bg-3)] text-[#38BDF8]' : 'text-[var(--text-ghost)] hover:text-[var(--text-muted)]'
                            }`}>
                            <GitGraph className="w-3 h-3" />{t.tabWorkflow}
                        </button>
                        <button onClick={() => setTab('logs')}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-semibold font-mono uppercase tracking-wider transition-colors ${
                                tab === 'logs' ? 'bg-[var(--bg-3)] text-[#38BDF8]' : 'text-[var(--text-ghost)] hover:text-[var(--text-muted)]'
                            }`}>
                            <Terminal className="w-3 h-3" />{t.tabLogs}
                        </button>
                        <button onClick={() => setTab('timeline')}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-semibold font-mono uppercase tracking-wider transition-colors ${
                                tab === 'timeline' ? 'bg-[var(--bg-3)] text-[#38BDF8]' : 'text-[var(--text-ghost)] hover:text-[var(--text-muted)]'
                            }`}>
                            <History className="w-3 h-3" />{t.tabTimeline}
                        </button>
                        {logs.length > 0 && <span className="ml-auto font-mono text-[10px] text-[var(--text-ghost)]">{logs.length}</span>}
                    </div>

                    {tab === 'flow' ? (
                        <div className="flex-1 overflow-y-auto scrollbar-hide">
                            <WorkflowView logs={logs} agentStatus={agentStatus} t={t} />
                        </div>
                    ) : tab === 'timeline' ? (
                        <div className="flex-1 overflow-y-auto scrollbar-hide">
                            <TimelineView logs={logs} auditLog={auditLog || []} t={t} />
                        </div>
                    ) : (
                        <div ref={logRef} className="flex-1 overflow-y-auto p-3 space-y-px font-mono text-[10px] scrollbar-hide">
                            {logs.length === 0 ? (
                                <div className="text-[var(--text-ghost)] italic text-[11px]">{t.waiting}</div>
                            ) : logs.map((log, i) => (
                                <div key={i} className="py-0.5 px-2 rounded text-[#38BDF8]/60 hover:text-[#38BDF8] hover:bg-[var(--bg-1)] transition-colors leading-relaxed">
                                    <span className="text-[var(--text-ghost)] mr-2 select-none">{String(i + 1).padStart(3, '0')}</span>
                                    {log.msg}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function Metric({ label, value, color, icon, sub }: { label: string; value: string; color: string; icon?: React.ReactNode; sub?: string }) {
    return (
        <div className="flex flex-col items-center gap-0.5">
            <span className="font-mono text-[9px] text-[var(--text-muted)] uppercase tracking-widest">{label}</span>
            <span className={`font-mono text-lg font-bold ${color}`}>{icon}{value}</span>
            {sub && <span className="font-mono text-[9px] text-[var(--text-ghost)]">{sub}</span>}
        </div>
    );
}
