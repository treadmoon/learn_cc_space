"use client";

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { MessageSquare, CheckCircle2, Loader2, Zap, Bell } from 'lucide-react';
import type { WorkflowStep } from '../WorkflowView';

const STATUS_COLOR: Record<string, string> = {
    completed: 'var(--color-success)',
    running: 'var(--color-success)',
    error: 'var(--color-danger)',
};

export function ResponseNode({ data }: NodeProps) {
    const step = data.step as WorkflowStep;
    const color = STATUS_COLOR[step.status] || 'var(--color-success)';

    // Determine icon based on label
    const isNotification = step.label.includes('notification') || step.label.includes('bg');
    const icon = isNotification ? <Bell className="w-3.5 h-3.5" /> : <MessageSquare className="w-3.5 h-3.5" />;

    return (
        <>
            <Handle type="target" position={Position.Top} className="!bg-[var(--bg-4)] !border-[var(--bg-4)] !w-2 !h-2" />
            <div className="relative group">
                {/* Pill/capsule shape */}
                <div className="flex items-center gap-2.5 px-5 py-2.5 rounded-full border-2 transition-all"
                    style={{
                        background: `color-mix(in srgb, ${color} 7%, transparent)`,
                        borderColor: step.status === 'running' ? color : `color-mix(in srgb, ${color} 30%, transparent)`,
                    }}>
                    {step.status === 'running' ? (
                        <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color }} />
                    ) : (
                        <span className="shrink-0" style={{ color }}>{icon}</span>
                    )}
                    <span className="text-[11px] font-mono font-semibold" style={{ color }}>
                        {step.label}
                    </span>
                    <Zap className="w-3 h-3 shrink-0" style={{ color: `color-mix(in srgb, ${color} 38%, transparent)` }} />
                </div>

                {/* Pulse ring for running */}
                {step.status === 'running' && (
                    <div className="absolute inset-0 rounded-full animate-ping" style={{ background: color, opacity: 0.06 }} />
                )}
            </div>
            <Handle type="source" position={Position.Bottom} className="!bg-[var(--bg-4)] !border-[var(--bg-4)] !w-2 !h-2" />
        </>
    );
}
