"use client";

import React, { useMemo } from 'react';
import { Terminal, MessageSquare, Brain, AlertCircle } from 'lucide-react';

export interface WorkflowStep {
    id: number;
    type: 'thinking' | 'tool_call' | 'response';
    status: 'running' | 'completed' | 'error';
    label: string;
    detail?: string;
    ts: number;
}

/** Parse raw log strings into workflow steps */
export function parseLogsToSteps(logs: string[], agentStatus: string): WorkflowStep[] {
    const steps: WorkflowStep[] = [];
    let id = 0;

    for (const log of logs) {
        if (log === '> User prompt sent') {
            // New round — mark previous thinking as completed
            const prev = steps[steps.length - 1];
            if (prev && prev.type === 'thinking' && prev.status === 'running') prev.status = 'completed';
            steps.push({ id: id++, type: 'thinking', status: 'running', label: '思考', ts: Date.now() });
        } else if (log.startsWith('Tool: ')) {
            // Previous thinking done
            const prev = steps[steps.length - 1];
            if (prev && prev.type === 'thinking' && prev.status === 'running') prev.status = 'completed';

            const match = log.match(/^Tool: (\S+)\s*(.*)/);
            const name = match?.[1] || 'unknown';
            const args = match?.[2]?.replace(/\.\.\.$/, '') || '';
            steps.push({ id: id++, type: 'tool_call', status: 'running', label: name, detail: args, ts: Date.now() });
        } else if (log.startsWith('Result: ')) {
            const prev = steps[steps.length - 1];
            if (prev && prev.type === 'tool_call' && prev.status === 'running') {
                prev.status = 'completed';
                prev.detail = log.slice(8, 60).replace(/\.\.\.$/, '');
            }
        } else if (log.startsWith('[ERROR]') || log.startsWith('[PARSE_ERROR]')) {
            const prev = steps[steps.length - 1];
            if (prev && prev.status === 'running') {
                prev.status = 'error';
                prev.detail = log.slice(0, 50);
            }
        } else if (log === 'Received background notifications') {
            steps.push({ id: id++, type: 'response', status: 'completed', label: '后台通知', ts: Date.now() });
        }
    }

    // If agent is idle and last step is running, mark completed
    if (agentStatus === 'idle') {
        const last = steps[steps.length - 1];
        if (last && last.status === 'running') last.status = 'completed';
    }

    return steps;
}

const ICON_MAP: Record<string, React.ReactNode> = {
    thinking: <Brain className="w-3 h-3" />,
    tool_call: <Terminal className="w-3 h-3" />,
    response: <MessageSquare className="w-3 h-3" />,
};

const STATUS_STYLES: Record<string, { node: string; line: string; text: string }> = {
    completed: { node: 'bg-[#2DD4BF] text-[var(--bg-0)]', line: 'bg-[#2DD4BF]/30', text: 'text-[var(--text-secondary)]' },
    running:   { node: 'bg-[#38BDF8] text-[var(--bg-0)] blink', line: 'bg-[#38BDF8]/30', text: 'text-[var(--text-primary)]' },
    error:     { node: 'bg-[#F87171] text-[var(--bg-0)]', line: 'bg-[#F87171]/30', text: 'text-[#F87171]' },
};

interface WorkflowViewProps {
    logs: string[];
    agentStatus: string;
}

export function WorkflowView({ logs, agentStatus }: WorkflowViewProps) {
    const steps = useMemo(() => parseLogsToSteps(logs, agentStatus), [logs, agentStatus]);

    if (steps.length === 0) {
        return <div className="p-4 text-[var(--text-ghost)] italic text-[11px]">等待 Agent 开始执行...</div>;
    }

    return (
        <div className="p-3 space-y-0">
            {steps.map((step, i) => {
                const s = STATUS_STYLES[step.status] || STATUS_STYLES.completed;
                const isLast = i === steps.length - 1;

                return (
                    <div key={step.id} className="flex gap-3 min-h-[32px]">
                        {/* Timeline column */}
                        <div className="flex flex-col items-center w-5 shrink-0">
                            <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${s.node}`}>
                                {step.status === 'error' ? <AlertCircle className="w-3 h-3" /> : ICON_MAP[step.type]}
                            </div>
                            {!isLast && <div className={`w-0.5 flex-1 min-h-[8px] ${s.line}`} />}
                        </div>

                        {/* Content */}
                        <div className="flex-1 pb-2 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className={`text-[11px] font-semibold font-mono ${s.text}`}>{step.label}</span>
                                {step.status === 'running' && (
                                    <span className="text-[9px] text-[#38BDF8] font-mono">运行中</span>
                                )}
                            </div>
                            {step.detail && (
                                <p className="text-[10px] text-[var(--text-muted)] font-mono mt-0.5 truncate">{step.detail}</p>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
