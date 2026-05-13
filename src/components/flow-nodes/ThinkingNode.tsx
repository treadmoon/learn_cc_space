"use client";

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Brain, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import type { WorkflowStep } from '../WorkflowView';

const STATUS_COLOR: Record<string, string> = {
    completed: '#818CF8',
    running: '#A78BFA',
    error: '#F87171',
};

export function ThinkingNode({ data }: NodeProps) {
    const step = data.step as WorkflowStep;
    const color = STATUS_COLOR[step.status] || '#818CF8';

    return (
        <>
            <Handle type="target" position={Position.Top} className="!bg-[var(--bg-4)] !border-[var(--bg-4)] !w-2 !h-2" />
            <div className="relative group" style={{ filter: step.status === 'running' ? `drop-shadow(0 0 8px ${color}40)` : 'none' }}>
                {/* Stadium shape — very rounded rectangle */}
                <div className="flex items-center gap-2.5 px-5 py-3 rounded-[20px] border-2 transition-all min-w-[140px]"
                    style={{
                        background: `${color}12`,
                        borderColor: step.status === 'running' ? color : `${color}50`,
                    }}>
                    {/* Status dot */}
                    <div className="relative shrink-0">
                        {step.status === 'running' ? (
                            <Loader2 className="w-4 h-4 animate-spin" style={{ color }} />
                        ) : step.status === 'error' ? (
                            <AlertCircle className="w-4 h-4" style={{ color }} />
                        ) : (
                            <CheckCircle2 className="w-4 h-4" style={{ color }} />
                        )}
                    </div>

                    <div className="flex items-center gap-2 min-w-0">
                        <Brain className="w-4 h-4 shrink-0" style={{ color }} />
                        <span className="text-[11px] font-semibold font-mono truncate" style={{ color }}>
                            {step.label}
                        </span>
                    </div>
                </div>

                {/* Pulse ring for running */}
                {step.status === 'running' && (
                    <div className="absolute inset-0 rounded-[20px] animate-ping" style={{ background: color, opacity: 0.08 }} />
                )}
            </div>
            <Handle type="source" position={Position.Bottom} className="!bg-[var(--bg-4)] !border-[var(--bg-4)] !w-2 !h-2" />
        </>
    );
}
