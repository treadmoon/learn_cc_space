"use client";

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertCircle, XCircle } from 'lucide-react';
import type { WorkflowStep } from '../WorkflowView';

export function ErrorNode({ data }: NodeProps) {
    const step = data.step as WorkflowStep;
    const color = 'var(--color-danger)';

    return (
        <>
            <Handle type="target" position={Position.Top} className="!bg-[var(--bg-4)] !border-[var(--bg-4)] !w-2 !h-2" />
            <div className="relative group">
                {/* Error rectangle with dashed red border */}
                <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl border-2 border-dashed transition-all min-w-[140px]"
                    style={{
                        background: 'color-mix(in srgb, var(--color-danger) 5%, transparent)',
                        borderColor: color,
                    }}>
                    <XCircle className="w-4 h-4 shrink-0" style={{ color }} />
                    <div className="min-w-0">
                        <span className="text-[11px] font-mono font-semibold block truncate" style={{ color }}>
                            {step.label}
                        </span>
                        {step.detail && (
                            <p className="text-[9px] font-mono mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                                {step.detail.slice(0, 50)}
                            </p>
                        )}
                    </div>
                </div>
            </div>
            <Handle type="source" position={Position.Bottom} className="!bg-[var(--bg-4)] !border-[var(--bg-4)] !w-2 !h-2" />
        </>
    );
}
