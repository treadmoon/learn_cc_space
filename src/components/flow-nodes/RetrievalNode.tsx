"use client";

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Search, Loader2, CheckCircle2, AlertCircle, FileText } from 'lucide-react';
import type { WorkflowStep } from '../WorkflowView';

export function RetrievalNode({ data }: NodeProps) {
    const step = data.step as WorkflowStep;
    const color = 'var(--color-warn)';

    // Extract query from toolArgs
    const query = (step.toolArgs as Record<string, unknown>)?.query as string || '';

    // Parse result count from toolOutput
    const resultMatch = step.toolOutput?.match(/Found (\d+) relevant/);
    const resultCount = resultMatch ? parseInt(resultMatch[1]) : 0;

    // Parse scores from output
    const scoreMatches = step.toolOutput?.match(/score: (\d+\.\d+)/g);
    const scores = scoreMatches?.map(s => parseFloat(s.split(': ')[1])) || [];

    return (
        <>
            <Handle type="target" position={Position.Top} className="!bg-[var(--bg-4)] !border-[var(--bg-4)] !w-2 !h-2" />
            <div className="relative group">
                {/* Dashed border rectangle — semantic "query" look */}
                <div className="flex flex-col gap-2 px-4 py-3 rounded-xl border-2 border-dashed transition-all min-w-[180px] max-w-[240px]"
                    style={{
                        background: 'color-mix(in srgb, var(--color-warn) 3%, transparent)',
                        borderColor: step.status === 'running' ? color : 'color-mix(in srgb, var(--color-warn) 30%, transparent)',
                    }}>
                    {/* Header row */}
                    <div className="flex items-center gap-2">
                        {step.status === 'running' ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" style={{ color }} />
                        ) : step.status === 'error' ? (
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-danger)' }} />
                        ) : (
                            <Search className="w-3.5 h-3.5 shrink-0" style={{ color }} />
                        )}
                        <span className="text-[10px] font-mono font-semibold truncate" style={{ color }}>
                            {step.label}
                        </span>
                        <span className="text-[8px] font-mono px-1.5 py-0.5 rounded shrink-0"
                            style={{ background: 'color-mix(in srgb, var(--color-warn) 7%, transparent)', color: 'color-mix(in srgb, var(--color-warn) 56%, var(--text-ghost))' }}>
                            RAG
                        </span>
                    </div>

                    {/* Query text */}
                    {query && (
                        <p className="text-[9px] font-mono truncate" style={{ color: 'var(--text-secondary)' }}>
                            &ldquo;{query}&rdquo;
                        </p>
                    )}

                    {/* Result chips */}
                    {step.status === 'completed' && resultCount > 0 && (
                        <div className="flex flex-wrap gap-1">
                            {scores.slice(0, 3).map((score, i) => (
                                <div key={i} className="flex items-center gap-1 px-1.5 py-0.5 rounded"
                                    style={{ background: 'color-mix(in srgb, var(--color-warn) 6%, transparent)' }}>
                                    <FileText className="w-2.5 h-2.5" style={{ color: 'color-mix(in srgb, var(--color-warn) 50%, var(--text-ghost))' }} />
                                    <span className="text-[8px] font-mono" style={{ color: 'color-mix(in srgb, var(--color-warn) 56%, var(--text-ghost))' }}>
                                        {score.toFixed(2)}
                                    </span>
                                </div>
                            ))}
                            {resultCount > 3 && (
                                <span className="text-[8px] font-mono px-1.5 py-0.5" style={{ color: 'color-mix(in srgb, var(--color-warn) 38%, var(--text-ghost))' }}>
                                    +{resultCount - 3}
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {/* Pulse ring for running */}
                {step.status === 'running' && (
                    <div className="absolute inset-0 rounded-xl animate-ping" style={{ background: color, opacity: 0.06 }} />
                )}
            </div>
            <Handle type="source" position={Position.Bottom} className="!bg-[var(--bg-4)] !border-[var(--bg-4)] !w-2 !h-2" />
        </>
    );
}
