"use client";

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
    Brain, Terminal, MessageSquare, AlertCircle, Clock, Minus, X, ChevronUp,
    CheckCircle2, Loader2, Zap, FileText, Play, RotateCw, ChevronDown
} from 'lucide-react';
import { groupByRequest, type LogEntry, type WorkflowStep } from './WorkflowView';
import type { T } from './i18n';

/* ── Icon map ── */
const ICON: Record<string, React.ReactNode> = {
    thinking: <Brain className="w-3.5 h-3.5" />,
    tool_call: <Terminal className="w-3.5 h-3.5" />,
    response: <MessageSquare className="w-3.5 h-3.5" />,
    error: <AlertCircle className="w-3.5 h-3.5" />,
    info: <Clock className="w-3.5 h-3.5" />,
};

const TOOL_ICON: Record<string, React.ReactNode> = {
    bash: <Play className="w-3 h-3" />,
    read_file: <FileText className="w-3 h-3" />,
    write_file: <FileText className="w-3 h-3" />,
    edit_file: <FileText className="w-3 h-3" />,
    task_create: <CheckCircle2 className="w-3 h-3" />,
    task_update: <CheckCircle2 className="w-3 h-3" />,
    task_list: <CheckCircle2 className="w-3 h-3" />,
    background_run: <Play className="w-3 h-3" />,
    check_background: <RotateCw className="w-3 h-3" />,
};

const TOOL_GROUPS: Record<string, string> = {
    write_file: 'file', edit_file: 'file', read_file: 'file',
    task_create: 'task', task_update: 'task', task_list: 'task',
    background_run: 'bg', check_background: 'bg',
};

const STATUS: Record<string, { color: string; bg: string; ring: string }> = {
    completed: { color: '#2DD4BF', bg: 'rgba(45,212,191,0.08)', ring: 'rgba(45,212,191,0.25)' },
    running:   { color: '#38BDF8', bg: 'rgba(56,189,248,0.10)', ring: 'rgba(56,189,248,0.35)' },
    error:     { color: '#F87171', bg: 'rgba(248,113,113,0.08)', ring: 'rgba(248,113,113,0.25)' },
};

const TYPE_LABELS: Record<string, (t: T) => string> = {
    thinking: t => t.flowThinking,
    tool_call: t => t.flowExecuting,
    response: t => t.flowCompleted,
    error: t => t.flowError,
    info: t => t.flowIdle,
};

/* ── Step row ── */
function StepRow({ step, t, isActive, isLast }: { step: WorkflowStep; t: T; isActive: boolean; isLast: boolean }) {
    const s = STATUS[step.status] || STATUS.completed;
    const [expanded, setExpanded] = useState(false);
    const toolIcon = step.toolName ? (TOOL_ICON[step.toolName] || ICON[step.type]) : ICON[step.type];
    const label = step.type === 'tool_call' ? step.label : TYPE_LABELS[step.type]?.(t) || step.type;

    return (
        <div className="flex gap-0 animate-in" style={{ animation: 'cardSlideIn 0.3s cubic-bezier(0.16,1,0.3,1)' }}>
            {/* Timeline rail */}
            <div className="flex flex-col items-center w-8 shrink-0">
                {/* Node */}
                <div className="relative mt-1.5">
                    <div className="w-3 h-3 rounded-full border-2 flex items-center justify-center transition-all"
                        style={{
                            borderColor: s.color,
                            background: step.status === 'completed' ? s.color : 'var(--bg-2)',
                            boxShadow: isActive ? `0 0 8px ${s.color}40` : 'none',
                        }}>
                        {step.status === 'running' && (
                            <div className="absolute inset-[-3px] rounded-full animate-ping" style={{ background: s.color, opacity: 0.2 }} />
                        )}
                    </div>
                </div>
                {/* Connector line */}
                {!isLast && (
                    <div className="w-[1.5px] flex-1 min-h-[8px] mt-1"
                        style={{
                            background: step.status === 'completed'
                                ? 'rgba(45,212,191,0.25)'
                                : step.status === 'running'
                                    ? 'linear-gradient(to bottom, rgba(56,189,248,0.3), rgba(56,189,248,0.05))'
                                    : 'var(--bg-4)',
                        }} />
                )}
            </div>

            {/* Content */}
            <div className="flex-1 pb-2 min-w-0">
                <div className="flex items-center gap-2 group">
                    {/* Icon */}
                    <div className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                        style={{ background: `${s.color}12`, color: s.color }}>
                        {toolIcon}
                    </div>
                    {/* Label */}
                    <span className="text-[11px] font-semibold font-mono truncate" style={{ color: isActive ? s.color : 'var(--text-secondary)' }}>
                        {label}
                    </span>
                    {/* Tool name tag */}
                    {step.type === 'tool_call' && step.toolName && step.toolName !== step.label && (
                        <span className="text-[8px] font-mono px-1.5 py-0.5 rounded shrink-0"
                            style={{ background: `${s.color}10`, color: `${s.color}90` }}>
                            {step.toolName}
                        </span>
                    )}
                    {/* Status badge */}
                    {step.status === 'running' && (
                        <span className="text-[8px] font-mono px-1.5 py-0.5 rounded shrink-0 animate-pulse"
                            style={{ background: 'rgba(56,189,248,0.12)', color: '#38BDF8' }}>
                            running
                        </span>
                    )}
                    {/* Duration / detail */}
                    <span className="text-[9px] font-mono text-[var(--text-ghost)] ml-auto shrink-0">
                        {step.status === 'completed' ? '✓' : step.status === 'running' ? '●' : step.status === 'error' ? '✕' : '○'}
                    </span>
                </div>

                {/* Detail line */}
                {step.detail && !expanded && (
                    <p className="text-[10px] text-[var(--text-ghost)] font-mono mt-0.5 ml-7 truncate">{step.detail.slice(0, 80)}</p>
                )}

                {/* Expandable I/O */}
                {step.type === 'tool_call' && (step.toolArgs || step.toolOutput) && (
                    <div className="ml-7 mt-1">
                        <button onClick={() => setExpanded(!expanded)}
                            className="flex items-center gap-1 text-[9px] font-mono transition-colors"
                            style={{ color: 'var(--text-ghost)' }}>
                            {expanded ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronUp className="w-2.5 h-2.5" />}
                            {expanded ? 'collapse' : 'expand I/O'}
                        </button>
                        {expanded && (
                            <div className="mt-1.5 space-y-1.5 animate-in">
                                {step.toolArgs && Object.keys(step.toolArgs).length > 0 && (
                                    <div className="rounded-md overflow-hidden border border-[var(--bg-4)]">
                                        <div className="px-2 py-0.5 bg-[var(--bg-3)] text-[8px] font-mono text-[var(--text-ghost)] uppercase tracking-wider">input</div>
                                        <pre className="p-2 text-[9px] font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-24 overflow-y-auto" style={{ color: 'rgba(56,189,248,0.7)' }}>
                                            {JSON.stringify(step.toolArgs, null, 2)}
                                        </pre>
                                    </div>
                                )}
                                {step.toolOutput && (
                                    <div className="rounded-md overflow-hidden border border-[var(--bg-4)]">
                                        <div className="px-2 py-0.5 bg-[var(--bg-3)] text-[8px] font-mono text-[var(--text-ghost)] uppercase tracking-wider">output</div>
                                        <pre className="p-2 text-[9px] font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-24 overflow-y-auto" style={{ color: 'rgba(45,212,191,0.7)' }}>
                                            {step.toolOutput.slice(0, 500)}
                                        </pre>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

/* ── Main overlay ── */
interface FlowOverlayProps {
    logs: LogEntry[];
    agentStatus: 'idle' | 'thinking' | 'executing_tools';
    t: T;
    onDismiss: () => void;
}

export function FlowOverlay({ logs, agentStatus, t, onDismiss }: FlowOverlayProps) {
    const [minimized, setMinimized] = useState(false);
    const [visible, setVisible] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    const groups = useMemo(() => groupByRequest(logs), [logs]);
    const currentGroup = groups[groups.length - 1];
    const steps = currentGroup?.steps || [];
    const done = steps.filter(s => s.status === 'completed').length;
    const errs = steps.filter(s => s.status === 'error').length;
    const progress = steps.length > 0 ? (done / steps.length) * 100 : 0;
    const currentStep = steps.find(s => s.status === 'running') || steps[steps.length - 1];

    // Auto-show
    useEffect(() => {
        if (agentStatus !== 'idle') { setVisible(true); setMinimized(false); }
    }, [agentStatus]);

    // Auto-minimize 5s after idle
    useEffect(() => {
        if (agentStatus === 'idle' && visible && !minimized && steps.length > 0) {
            const h = setTimeout(() => setMinimized(true), 5000);
            return () => clearTimeout(h);
        }
    }, [agentStatus, visible, minimized, steps.length]);

    // Auto-scroll to bottom
    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [steps.length]);

    if (!visible || steps.length === 0) return null;

    const statusColor = agentStatus !== 'idle' ? '#38BDF8' : (errs > 0 ? '#F87171' : '#2DD4BF');
    const statusLabel = agentStatus === 'thinking' ? t.flowThinking : agentStatus === 'executing_tools' ? t.flowExecuting : t.flowCompleted;

    /* ── Minimized floating pill ── */
    if (minimized) {
        return (
            <div className="absolute bottom-20 right-4 z-40 animate-in">
                <button onClick={() => setMinimized(false)}
                    className="group flex items-center gap-2 pl-3 pr-2.5 py-2 rounded-xl border transition-all hover:scale-[1.03] active:scale-[0.97] cursor-pointer"
                    style={{
                        background: 'linear-gradient(135deg, var(--bg-2), var(--bg-3))',
                        borderColor: `${statusColor}30`,
                        boxShadow: `0 4px 16px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.03)`,
                    }}>
                    <div className="relative">
                        <div className="w-2 h-2 rounded-full" style={{ background: statusColor }} />
                        {agentStatus !== 'idle' && <div className="absolute inset-0 w-2 h-2 rounded-full animate-ping" style={{ background: statusColor, opacity: 0.3 }} />}
                    </div>
                    <span className="text-[10px] font-mono text-[var(--text-secondary)]">{done}/{steps.length}</span>
                    <div className="w-10 h-1 rounded-full bg-[var(--bg-4)] overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${progress}%`, background: statusColor }} />
                    </div>
                    <ChevronUp className="w-3 h-3 text-[var(--text-ghost)]" />
                </button>
            </div>
        );
    }

    /* ── Full overlay ── */
    return (
        <div className="absolute inset-4 z-40 flex flex-col rounded-2xl overflow-hidden animate-in pointer-events-auto"
            style={{
                background: 'var(--bg-1)',
                border: '1px solid var(--bg-4)',
                boxShadow: '0 12px 48px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.03)',
            }}>

            {/* Header */}
            <div className="flex items-center gap-2.5 px-4 py-2.5 shrink-0"
                style={{
                    background: 'linear-gradient(90deg, rgba(56,189,248,0.08) 0%, var(--bg-2) 50%)',
                    borderBottom: '1px solid rgba(56,189,248,0.10)',
                }}>
                <div className="relative">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: statusColor }} />
                    {agentStatus !== 'idle' && <div className="absolute inset-0 w-2.5 h-2.5 rounded-full animate-ping" style={{ background: statusColor, opacity: 0.3 }} />}
                </div>
                <Zap className="w-4 h-4" style={{ color: statusColor }} />
                <span className="sh text-[11px]" style={{ color: statusColor }}>{t.flowOverlay}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-md" style={{ color: statusColor, background: `${statusColor}12` }}>
                    {statusLabel}
                </span>

                <div className="ml-auto flex items-center gap-3">
                    {/* Stats */}
                    <div className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full" style={{ background: '#2DD4BF' }} />
                        <span className="text-[10px] font-mono text-[var(--text-ghost)]">{done}</span>
                        {errs > 0 && (
                            <>
                                <span className="w-2 h-2 rounded-full ml-1" style={{ background: '#F87171' }} />
                                <span className="text-[10px] font-mono text-[#F87171]/70">{errs}</span>
                            </>
                        )}
                    </div>
                    {/* Progress bar */}
                    <div className="flex items-center gap-2">
                        <div className="w-20 h-1.5 rounded-full bg-[var(--bg-4)] overflow-hidden">
                            <div className="h-full rounded-full transition-all duration-500 ease-out" style={{ width: `${progress}%`, background: `linear-gradient(90deg, ${statusColor}, ${statusColor}aa)` }} />
                        </div>
                        <span className="text-[10px] font-mono text-[var(--text-ghost)]">{done}/{steps.length}</span>
                    </div>
                    <button onClick={() => setMinimized(true)} className="p-1.5 rounded-lg hover:bg-[var(--bg-4)] text-[var(--text-ghost)] hover:text-[var(--text-muted)] transition-colors">
                        <Minus className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => { setVisible(false); onDismiss(); }} className="p-1.5 rounded-lg hover:bg-[var(--bg-4)] text-[var(--text-ghost)] hover:text-[var(--text-muted)] transition-colors">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            {/* Timeline — vertical scroll */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 scrollbar-hide">
                {steps.map((step, i) => (
                    <StepRow key={step.id} step={step} t={t} isActive={step.status === 'running'} isLast={i === steps.length - 1} />
                ))}
            </div>

            {/* Footer — current step detail */}
            {currentStep && (
                <div className="px-4 py-2.5 shrink-0" style={{ background: 'var(--bg-2)', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                            style={{ background: `${STATUS[currentStep.status]?.color || '#64748B'}15`, color: STATUS[currentStep.status]?.color || '#64748B' }}>
                            {ICON[currentStep.type]}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="text-[9px] font-mono text-[var(--text-ghost)] uppercase tracking-wider">{t.flowCurrentStep}</span>
                                <span className="text-[10px] font-mono font-semibold truncate" style={{ color: STATUS[currentStep.status]?.color || '#64748B' }}>
                                    {currentStep.type === 'tool_call' ? currentStep.label : (TYPE_LABELS[currentStep.type]?.(t) || currentStep.type)}
                                </span>
                            </div>
                            {currentStep.toolArgs && (
                                <p className="text-[9px] font-mono text-[var(--text-ghost)] truncate mt-0.5">{JSON.stringify(currentStep.toolArgs).slice(0, 100)}</p>
                            )}
                        </div>
                        <span className="text-[9px] font-mono text-[var(--text-ghost)] shrink-0">
                            {steps.indexOf(currentStep) + 1}/{steps.length}
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
