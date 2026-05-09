"use client";

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { Brain, Terminal, MessageSquare, AlertCircle, Clock, Minus, X, ChevronUp, CheckCircle2, Loader2 } from 'lucide-react';
import { parseLogsToSteps, groupByRequest, type LogEntry, type WorkflowStep } from './WorkflowView';
import type { T } from './i18n';

const ICON_MAP: Record<string, React.ReactNode> = {
    thinking: <Brain className="w-3.5 h-3.5" />,
    tool_call: <Terminal className="w-3.5 h-3.5" />,
    response: <MessageSquare className="w-3.5 h-3.5" />,
    error: <AlertCircle className="w-3.5 h-3.5" />,
    info: <Clock className="w-3.5 h-3.5" />,
};

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
    completed: { bg: 'bg-[#2DD4BF]/10', border: 'border-[#2DD4BF]/30', text: 'text-[#2DD4BF]', dot: 'bg-[#2DD4BF]' },
    running:   { bg: 'bg-[#38BDF8]/10', border: 'border-[#38BDF8]/40', text: 'text-[#38BDF8]', dot: 'bg-[#38BDF8]' },
    error:     { bg: 'bg-[#F87171]/10', border: 'border-[#F87171]/30', text: 'text-[#F87171]', dot: 'bg-[#F87171]' },
};

const TYPE_LABELS: Record<string, (t: T) => string> = {
    thinking: t => t.flowThinking,
    tool_call: t => t.flowExecuting,
    response: t => t.flowCompleted,
    error: t => t.flowError,
    info: t => t.flowIdle,
};

function StepCard({ step, t, isCurrent }: { step: WorkflowStep; t: T; isCurrent: boolean }) {
    const c = STATUS_COLORS[step.status] || STATUS_COLORS.completed;
    const label = TYPE_LABELS[step.type]?.(t) || step.type;
    const [expanded, setExpanded] = useState(false);

    return (
        <div className={`flex flex-col items-center shrink-0 animate-in`}
            style={{ animation: 'cardSlideIn 0.3s ease-out' }}>
            <div className={`relative w-[120px] rounded-xl border ${c.border} ${c.bg} p-2.5 transition-all ${isCurrent ? 'ring-1 ring-[#38BDF8]/30' : ''}`}>
                {/* Status indicator */}
                <div className="flex items-center justify-between mb-1.5">
                    <div className={`w-2 h-2 rounded-full ${c.dot} ${step.status === 'running' ? 'animate-pulse' : ''}`} />
                    {step.status === 'completed' && <CheckCircle2 className="w-3 h-3 text-[#2DD4BF]" />}
                    {step.status === 'running' && <Loader2 className="w-3 h-3 text-[#38BDF8] animate-spin" />}
                    {step.status === 'error' && <AlertCircle className="w-3 h-3 text-[#F87171]" />}
                </div>
                {/* Icon + Label */}
                <div className="flex items-center gap-1.5 mb-1">
                    <span className={c.text}>{ICON_MAP[step.type]}</span>
                    <span className={`text-[11px] font-semibold font-mono ${c.text} truncate`}>
                        {step.type === 'tool_call' ? step.label : label}
                    </span>
                </div>
                {/* Detail snippet */}
                {step.detail && (
                    <p className="text-[9px] text-[var(--text-ghost)] font-mono truncate">{step.detail.slice(0, 40)}</p>
                )}
                {/* Expand for tool args */}
                {step.type === 'tool_call' && step.toolArgs && (
                    <button onClick={() => setExpanded(!expanded)}
                        className="mt-1 text-[8px] text-[var(--text-ghost)] hover:text-[var(--text-muted)] font-mono transition-colors">
                        {expanded ? '▲ hide' : '▼ detail'}
                    </button>
                )}
            </div>
            {/* Expanded tool detail */}
            {expanded && step.toolArgs && (
                <div className="mt-1 w-[200px] animate-in">
                    <pre className="text-[9px] text-[#38BDF8]/80 font-mono bg-[var(--bg-0)] rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-32 overflow-y-auto border border-[var(--bg-4)]">
                        {JSON.stringify(step.toolArgs, null, 2)}
                    </pre>
                </div>
            )}
        </div>
    );
}

function Connector({ status }: { status: 'completed' | 'running' | 'pending' }) {
    if (status === 'pending') {
        return <div className="w-6 h-0.5 bg-[var(--bg-4)] shrink-0 self-center" />;
    }
    if (status === 'running') {
        return (
            <div className="w-6 h-0.5 shrink-0 self-center relative overflow-hidden">
                <div className="absolute inset-0 bg-[#38BDF8]/30" />
                <div className="absolute inset-0 bg-[#38BDF8] animate-[flowPulse_1.5s_ease-in-out_infinite]" />
            </div>
        );
    }
    return <div className="w-6 h-0.5 bg-[#2DD4BF]/40 shrink-0 self-center" />;
}

interface FlowOverlayProps {
    logs: LogEntry[];
    agentStatus: 'idle' | 'thinking' | 'executing_tools';
    t: T;
    onDismiss: () => void;
}

export function FlowOverlay({ logs, agentStatus, t, onDismiss }: FlowOverlayProps) {
    const [minimized, setMinimized] = useState(false);
    const [visible, setVisible] = useState(false);
    const [autoHiding, setAutoHiding] = useState(false);
    const dragRef = useRef<{ startX: number; startY: number; offsetX: number; offsetY: number } | null>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const scrollRef = useRef<HTMLDivElement>(null);

    // Compute current request's steps
    const groups = useMemo(() => groupByRequest(logs), [logs]);
    const currentGroup = groups[groups.length - 1];
    const steps = currentGroup?.steps || [];
    const completedCount = steps.filter(s => s.status === 'completed').length;
    const currentStep = steps.find(s => s.status === 'running') || steps[steps.length - 1];

    // Auto-show when agent starts working
    useEffect(() => {
        if (agentStatus !== 'idle') {
            setVisible(true);
            setMinimized(false);
            setAutoHiding(false);
        }
    }, [agentStatus]);

    // Auto-hide 3s after agent goes idle
    useEffect(() => {
        if (agentStatus === 'idle' && visible && !minimized) {
            setAutoHiding(true);
            const timer = setTimeout(() => setMinimized(true), 3000);
            return () => clearTimeout(timer);
        }
    }, [agentStatus, visible, minimized]);

    // Auto-scroll step list to end
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
        }
    }, [steps.length]);

    // Drag handlers
    const handleDragStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = { startX: e.clientX, startY: e.clientY, offsetX: offset.x, offsetY: offset.y };
        const handleMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            const dx = ev.clientX - dragRef.current.startX;
            const dy = ev.clientY - dragRef.current.startY;
            setOffset({ x: dragRef.current.offsetX + dx, y: dragRef.current.offsetY + dy });
        };
        const handleUp = () => { dragRef.current = null; document.removeEventListener('mousemove', handleMove); document.removeEventListener('mouseup', handleUp); };
        document.addEventListener('mousemove', handleMove);
        document.addEventListener('mouseup', handleUp);
    }, [offset]);

    if (!visible || steps.length === 0) return null;

    // Minimized state
    if (minimized) {
        return (
            <div className="flex justify-center py-1 animate-in">
                <button onClick={() => { setMinimized(false); setAutoHiding(false); }}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--bg-2)] border border-[var(--bg-4)] hover:bg-[var(--bg-3)] transition-all shadow-lg cursor-pointer">
                    <div className={`w-2 h-2 rounded-full ${agentStatus !== 'idle' ? 'bg-[#38BDF8] animate-pulse' : 'bg-[#2DD4BF]'}`} />
                    <span className="text-[10px] font-mono text-[var(--text-secondary)]">
                        {agentStatus !== 'idle' ? t.flowExecuting : t.flowCompleted}
                    </span>
                    <span className="text-[10px] font-mono text-[var(--text-ghost)]">{completedCount}/{steps.length}</span>
                    <ChevronUp className="w-3 h-3 text-[var(--text-ghost)]" />
                </button>
            </div>
        );
    }

    const statusLabel = agentStatus === 'thinking' ? t.flowThinking
        : agentStatus === 'executing_tools' ? t.flowExecuting
        : t.flowCompleted;

    return (
        <div ref={overlayRef}
            className="mx-2 mb-1 rounded-xl bg-[var(--bg-1)] border border-[var(--bg-4)] shadow-2xl overflow-hidden animate-in"
            style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
            {/* Header — draggable */}
            <div className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-2)] cursor-move select-none border-b border-[var(--bg-4)]"
                onMouseDown={handleDragStart}>
                <div className={`w-2 h-2 rounded-full ${agentStatus !== 'idle' ? 'bg-[#38BDF8] animate-pulse' : 'bg-[#2DD4BF]'}`} />
                <span className="text-[11px] font-semibold text-[var(--text-primary)]">{t.flowOverlay}</span>
                <span className="text-[10px] font-mono text-[var(--text-ghost)]">{statusLabel}</span>
                <span className="text-[10px] font-mono text-[var(--text-ghost)] ml-auto">{completedCount}/{steps.length} {t.flowProgress}</span>
                <button onClick={() => setMinimized(true)} className="p-1 rounded hover:bg-[var(--bg-4)] text-[var(--text-ghost)] hover:text-[var(--text-muted)] transition-colors" title={t.flowMinimize}>
                    <Minus className="w-3 h-3" />
                </button>
                <button onClick={() => { setVisible(false); onDismiss(); }} className="p-1 rounded hover:bg-[var(--bg-4)] text-[var(--text-ghost)] hover:text-[var(--text-muted)] transition-colors" title={t.flowClose}>
                    <X className="w-3 h-3" />
                </button>
            </div>

            {/* Step cards — horizontal scroll */}
            <div ref={scrollRef} className="flex items-center gap-0 px-3 py-3 overflow-x-auto scrollbar-hide">
                {steps.map((step, i) => (
                    <React.Fragment key={step.id}>
                        {i > 0 && (
                            <Connector status={
                                step.status === 'running' ? 'running'
                                : step.status === 'completed' ? 'completed'
                                : steps[i - 1].status === 'completed' ? 'completed' : 'pending'
                            } />
                        )}
                        <StepCard step={step} t={t} isCurrent={step.status === 'running'} />
                    </React.Fragment>
                ))}
            </div>

            {/* Current step detail */}
            {currentStep && (
                <div className="px-3 py-2 border-t border-[var(--bg-4)] bg-[var(--bg-0)]/50">
                    <div className="flex items-center gap-2 mb-1">
                        <span className="text-[9px] text-[var(--text-ghost)] font-mono uppercase tracking-wider">{t.flowCurrentStep}</span>
                        <span className={`text-[10px] font-mono font-semibold ${STATUS_COLORS[currentStep.status]?.text || 'text-[var(--text-muted)]'}`}>
                            {currentStep.type === 'tool_call' ? currentStep.label : (TYPE_LABELS[currentStep.type]?.(t) || currentStep.type)}
                        </span>
                    </div>
                    {currentStep.type === 'thinking' && (
                        <p className="text-[10px] text-[var(--text-muted)] font-mono">{t.flowAnalyzing}</p>
                    )}
                    {currentStep.type === 'tool_call' && currentStep.toolArgs && (
                        <pre className="text-[10px] text-[#38BDF8]/70 font-mono bg-[var(--bg-0)] rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
                            {JSON.stringify(currentStep.toolArgs, null, 2)}
                        </pre>
                    )}
                    {currentStep.type === 'response' && currentStep.detail && (
                        <p className="text-[10px] text-[var(--text-muted)] font-mono truncate">{currentStep.detail}</p>
                    )}
                    {currentStep.type === 'error' && currentStep.detail && (
                        <p className="text-[10px] text-[#F87171]/80 font-mono">{currentStep.detail}</p>
                    )}
                </div>
            )}
        </div>
    );
}
