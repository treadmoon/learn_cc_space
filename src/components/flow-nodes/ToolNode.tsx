"use client";

import React, { useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
    Terminal, FileText, Play, CheckCircle2, RotateCw,
    ChevronDown, ChevronUp, Loader2, AlertCircle
} from 'lucide-react';
import type { WorkflowStep } from '../WorkflowView';

const TOOL_GROUPS: Record<string, string> = {
    write_file: 'file', edit_file: 'file', read_file: 'file',
    task_create: 'task', task_update: 'task', task_list: 'task',
    background_run: 'bg', check_background: 'bg',
    bash: 'bash',
};

const GROUP_STYLES: Record<string, { color: string; shape: string; label: string }> = {
    file:  { color: '#38BDF8', shape: 'rect',       label: 'File' },
    task:  { color: '#FBBF24', shape: 'diamond',    label: 'Task' },
    bg:    { color: '#818CF8', shape: 'hexagon',    label: 'BG' },
    bash:  { color: '#2DD4BF', shape: 'parallelogram', label: 'Shell' },
};

const TOOL_ICONS: Record<string, React.ReactNode> = {
    bash: <Terminal className="w-3.5 h-3.5" />,
    read_file: <FileText className="w-3.5 h-3.5" />,
    write_file: <FileText className="w-3.5 h-3.5" />,
    edit_file: <FileText className="w-3.5 h-3.5" />,
    task_create: <CheckCircle2 className="w-3.5 h-3.5" />,
    task_update: <CheckCircle2 className="w-3.5 h-3.5" />,
    task_list: <CheckCircle2 className="w-3.5 h-3.5" />,
    background_run: <Play className="w-3.5 h-3.5" />,
    check_background: <RotateCw className="w-3.5 h-3.5" />,
};

function getShapeClipPath(shape: string): string | undefined {
    switch (shape) {
        case 'hexagon':
            return 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)';
        default:
            return undefined;
    }
}

function getShapeTransform(shape: string): string | undefined {
    switch (shape) {
        case 'diamond':
            return 'rotate(0deg)'; // We'll use clip-path for diamond too
        case 'parallelogram':
            return undefined; // Use clip-path
        default:
            return undefined;
    }
}

function getShapeStyles(shape: string, color: string): React.CSSProperties {
    switch (shape) {
        case 'diamond':
            return {
                clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
                minWidth: '120px',
                minHeight: '120px',
            };
        case 'hexagon':
            return {
                clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
                minWidth: '140px',
            };
        case 'parallelogram':
            return {
                clipPath: 'polygon(12% 0%, 100% 0%, 88% 100%, 0% 100%)',
            };
        default:
            return {};
    }
}

export function ToolNode({ data }: NodeProps) {
    const step = data.step as WorkflowStep;
    const [expanded, setExpanded] = useState(false);
    const group = step.toolName ? (TOOL_GROUPS[step.toolName] || 'file') : 'file';
    const gs = GROUP_STYLES[group] || GROUP_STYLES.file;
    const statusColor = step.status === 'completed' ? gs.color : step.status === 'error' ? '#F87171' : gs.color;
    const icon = step.toolName ? (TOOL_ICONS[step.toolName] || <Terminal className="w-3.5 h-3.5" />) : <Terminal className="w-3.5 h-3.5" />;

    const isSpecialShape = group === 'task' || group === 'bg' || group === 'bash';

    return (
        <>
            <Handle type="target" position={Position.Top} className="!bg-[var(--bg-4)] !border-[var(--bg-4)] !w-2 !h-2" />
            <div className="relative group" style={{ filter: step.status === 'running' ? `drop-shadow(0 0 8px ${statusColor}40)` : 'none' }}>
                <div className={`flex flex-col border-2 transition-all ${isSpecialShape ? '' : 'rounded-xl px-4 py-2.5'}`}
                    style={{
                        background: `${statusColor}10`,
                        borderColor: step.status === 'running' ? statusColor : `${statusColor}50`,
                        ...(isSpecialShape ? getShapeStyles(group, statusColor) : {}),
                    }}>
                    {isSpecialShape ? (
                        /* Special shapes — centered content */
                        <div className="flex flex-col items-center justify-center gap-1 px-6 py-4 min-w-[130px]">
                            <div className="flex items-center gap-1.5">
                                {step.status === 'running' ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: statusColor }} />
                                ) : step.status === 'error' ? (
                                    <AlertCircle className="w-3.5 h-3.5" style={{ color: '#F87171' }} />
                                ) : (
                                    <span style={{ color: statusColor }}>{icon}</span>
                                )}
                                <span className="text-[10px] font-mono font-semibold" style={{ color: statusColor }}>
                                    {step.label}
                                </span>
                            </div>
                            <span className="text-[8px] font-mono uppercase tracking-wider" style={{ color: `${statusColor}80` }}>
                                {gs.label}
                            </span>
                        </div>
                    ) : (
                        /* Rectangle — normal layout */
                        <>
                            <div className="flex items-center gap-2">
                                {/* Icon */}
                                <div className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                                    style={{ background: `${statusColor}15`, color: statusColor }}>
                                    {step.status === 'running' ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : step.status === 'error' ? (
                                        <AlertCircle className="w-3 h-3" />
                                    ) : icon}
                                </div>
                                {/* Label */}
                                <span className="text-[11px] font-mono font-semibold truncate" style={{ color: statusColor }}>
                                    {step.label}
                                </span>
                                {/* Group tag */}
                                <span className="text-[8px] font-mono px-1.5 py-0.5 rounded shrink-0"
                                    style={{ background: `${statusColor}12`, color: `${statusColor}90` }}>
                                    {gs.label}
                                </span>
                            </div>

                            {/* Detail */}
                            {step.detail && (
                                <p className="text-[9px] font-mono mt-1 truncate" style={{ color: 'var(--text-ghost)' }}>
                                    {step.detail.slice(0, 60)}
                                </p>
                            )}

                            {/* Expandable I/O */}
                            {(step.toolArgs || step.toolOutput) && (
                                <button onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                                    className="flex items-center gap-1 text-[8px] font-mono mt-1.5 transition-colors hover:opacity-80"
                                    style={{ color: `${statusColor}80` }}>
                                    {expanded ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
                                    {expanded ? 'collapse' : 'I/O'}
                                </button>
                            )}

                            {expanded && (step.toolArgs || step.toolOutput) && (
                                <div className="mt-1.5 space-y-1 max-h-32 overflow-y-auto">
                                    {step.toolArgs && Object.keys(step.toolArgs).length > 0 && (
                                        <pre className="text-[8px] font-mono p-1.5 rounded bg-[var(--bg-0)] overflow-x-auto whitespace-pre-wrap break-all"
                                            style={{ color: `${statusColor}90` }}>
                                            {JSON.stringify(step.toolArgs, null, 2).slice(0, 200)}
                                        </pre>
                                    )}
                                    {step.toolOutput && (
                                        <pre className="text-[8px] font-mono p-1.5 rounded bg-[var(--bg-0)] overflow-x-auto whitespace-pre-wrap break-all"
                                            style={{ color: 'rgba(45,212,191,0.7)' }}>
                                            {step.toolOutput.slice(0, 200)}
                                        </pre>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Pulse ring for running */}
                {step.status === 'running' && (
                    <div className="absolute inset-0 rounded-xl animate-ping" style={{ background: statusColor, opacity: 0.06 }} />
                )}
            </div>
            <Handle type="source" position={Position.Bottom} className="!bg-[var(--bg-4)] !border-[var(--bg-4)] !w-2 !h-2" />
        </>
    );
}
