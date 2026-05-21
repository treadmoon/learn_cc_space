"use client";

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
    ReactFlow, Background, Controls,
    useReactFlow,
    type Node, type Edge, type NodeTypes,
    MarkerType, BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import {
    Zap, Minus, X, ChevronUp, Loader2, Maximize2
} from 'lucide-react';
import { groupByRequest, type LogEntry, type WorkflowStep } from './WorkflowView';
import type { T } from './i18n';
import { ThinkingNode, ToolNode, ResponseNode, ErrorNode, RetrievalNode } from './flow-nodes';

/* ── Node type registry ── */
const nodeTypes: NodeTypes = {
    thinking: ThinkingNode,
    tool: ToolNode,
    response: ResponseNode,
    error: ErrorNode,
    retrieval: RetrievalNode,
};

/* ── Color palette (CSS vars for theme support) ── */
const TYPE_COLORS: Record<string, string> = {
    thinking: 'var(--color-accent2)',
    tool_call: 'var(--color-accent)',
    response: 'var(--color-success)',
    error: 'var(--color-danger)',
    info: 'var(--text-muted)',
};

const TOOL_GROUPS: Record<string, string> = {
    write_file: 'file', edit_file: 'file', read_file: 'file',
    task_create: 'task', task_update: 'task', task_list: 'task',
    background_run: 'bg', check_background: 'bg',
};

/* ── Helpers ── */
function getNodeType(step: WorkflowStep): string {
    if (step.type === 'error') return 'error';
    if (step.type === 'response') return 'response';
    if (step.type === 'thinking') return 'thinking';
    if (step.type === 'tool_call' && step.toolName === 'knowledge_search') return 'retrieval';
    if (step.type === 'tool_call') return 'tool';
    return 'thinking'; // info → treat as thinking shape
}

function getNodeColor(step: WorkflowStep): string {
    if (step.type === 'tool_call' && step.toolName === 'knowledge_search') return 'var(--color-warn)';
    if (step.type === 'tool_call' && step.toolName) {
        const group = TOOL_GROUPS[step.toolName];
        if (group === 'task') return 'var(--color-warn)';
        if (group === 'bg') return 'var(--color-accent2)';
        if (group === 'file') return 'var(--color-accent)';
        return 'var(--color-teal)'; // bash/default
    }
    return TYPE_COLORS[step.type] || 'var(--text-muted)';
}

function getEdgeStyle(step: WorkflowStep): React.CSSProperties {
    const color = getNodeColor(step);
    if (step.status === 'error') return { stroke: 'var(--color-danger)', strokeWidth: 2, strokeDasharray: '6 3' };
    if (step.status === 'running') return { stroke: color, strokeWidth: 2, strokeDasharray: '6 3' };
    return { stroke: color, strokeWidth: 2, opacity: 0.5 };
}

/* ── Dagre layout ── */
const NODE_WIDTH = 180;
const NODE_HEIGHT = 70;

function layoutNodes(nodes: Node[], edges: Edge[]): Node[] {
    if (nodes.length === 0) return nodes;

    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: 'TB', nodesep: 80, ranksep: 70, marginx: 20, marginy: 20 });

    nodes.forEach(node => {
        const h = node.type === 'tool' ? 90 : node.type === 'error' ? 65 : 60;
        g.setNode(node.id, { width: NODE_WIDTH, height: h });
    });
    edges.forEach(edge => g.setEdge(edge.source, edge.target));

    dagre.layout(g);

    return nodes.map(node => {
        const pos = g.node(node.id);
        return {
            ...node,
            position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - (node.type === 'tool' ? 45 : 30) },
        };
    });
}

/* ── Steps → Flow data ── */
function stepsToFlow(steps: WorkflowStep[]): { nodes: Node[]; edges: Edge[] } {
    const nodes: Node[] = steps.map(step => ({
        id: String(step.id),
        type: getNodeType(step),
        position: { x: 0, y: 0 },
        data: { step },
    }));

    const edges: Edge[] = [];
    for (let i = 0; i < steps.length - 1; i++) {
        const src = steps[i];
        const tgt = steps[i + 1];
        const color = getNodeColor(tgt);
        edges.push({
            id: `e-${src.id}-${tgt.id}`,
            source: String(src.id),
            target: String(tgt.id),
            animated: tgt.status === 'running',
            style: getEdgeStyle(tgt),
            markerEnd: {
                type: MarkerType.ArrowClosed,
                color: tgt.status === 'error' ? 'var(--color-danger)' : color,
                width: 16,
                height: 16,
            },
        });
    }

    return { nodes, edges };
}

/* ── AutoFit component ── */
function AutoFit({ nodeCount }: { nodeCount: number }) {
    const { fitView } = useReactFlow();
    useEffect(() => {
        if (nodeCount > 0) {
            const t = setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 100);
            return () => clearTimeout(t);
        }
    }, [nodeCount, fitView]);
    return null;
}

/* ── Main overlay ── */
interface FlowGraphProps {
    logs: LogEntry[];
    agentStatus: 'idle' | 'thinking' | 'executing_tools';
    t: T;
    onDismiss: () => void;
}

const EMPTY_STEPS: WorkflowStep[] = [];

export function FlowGraph({ logs, agentStatus, t, onDismiss }: FlowGraphProps) {
    const [minimized, setMinimized] = useState(false);
    const [visible, setVisible] = useState(false);

    const groups = useMemo(() => groupByRequest(logs), [logs]);
    const currentGroup = groups[groups.length - 1];
    const steps = currentGroup?.steps ?? EMPTY_STEPS;
    const done = steps.filter(s => s.status === 'completed').length;
    const errs = steps.filter(s => s.status === 'error').length;
    const progress = steps.length > 0 ? (done / steps.length) * 100 : 0;
    const currentStep = steps.find(s => s.status === 'running') || steps[steps.length - 1];

    // Compute flow data directly — no useEffect sync needed
    const { nodes, edges } = useMemo(() => {
        const { nodes: rawNodes, edges: rawEdges } = stepsToFlow(steps);
        const laid = layoutNodes(rawNodes, rawEdges);
        return { nodes: laid, edges: rawEdges };
    }, [steps]);

    // Auto-show when agent starts working
    useEffect(() => {
        if (agentStatus !== 'idle') { setVisible(true); setMinimized(false); }
    }, [agentStatus]);

    // Escape key to dismiss
    const handleDismiss = useCallback(() => { setVisible(false); onDismiss(); }, [onDismiss]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleDismiss(); };
        if (visible && !minimized) {
            window.addEventListener('keydown', onKey);
            return () => window.removeEventListener('keydown', onKey);
        }
    }, [visible, minimized, handleDismiss]);


    if (!visible || steps.length === 0) return null;

    const statusColor = agentStatus !== 'idle' ? 'var(--color-accent)' : (errs > 0 ? 'var(--color-danger)' : 'var(--color-teal)');
    const statusLabel = agentStatus === 'thinking' ? t.flowThinking : agentStatus === 'executing_tools' ? t.flowExecuting : t.flowCompleted;

    /* ── Minimized floating pill ── */
    if (minimized) {
        const stepLabel = currentStep?.label || '';
        return (
            <div className="absolute bottom-20 right-4 z-40 animate-in">
                <button onClick={() => setMinimized(false)}
                    className="group flex items-center gap-2.5 pl-3.5 pr-3 py-2.5 rounded-xl border transition-all hover:scale-[1.03] active:scale-[0.97] cursor-pointer"
                    style={{
                        background: 'linear-gradient(135deg, var(--bg-2), var(--bg-3))',
                        borderColor: `${statusColor}30`,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.25), 0 0 0 1px var(--glass)',
                    }}>
                    <div className="relative">
                        <div className="w-2 h-2 rounded-full" style={{ background: statusColor }} />
                        {agentStatus !== 'idle' && <div className="absolute inset-0 w-2 h-2 rounded-full animate-ping" style={{ background: statusColor, opacity: 0.3 }} />}
                    </div>
                    <div className="flex flex-col items-start gap-0.5">
                        {stepLabel && (
                            <span className="text-[9px] font-mono text-[var(--text-ghost)] truncate max-w-[100px]">{stepLabel}</span>
                        )}
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono text-[var(--text-secondary)]">{done}/{steps.length}</span>
                            <div className="w-12 h-1 rounded-full bg-[var(--bg-4)] overflow-hidden">
                                <div className="h-full rounded-full transition-all duration-500" style={{ width: `${progress}%`, background: statusColor }} />
                            </div>
                        </div>
                    </div>
                    <Maximize2 className="w-3 h-3 text-[var(--text-ghost)] group-hover:text-[var(--text-muted)] transition-colors" />
                </button>
            </div>
        );
    }

    /* ── Full flow graph overlay ── */
    return (
        <div className="absolute inset-4 z-40 flex flex-col rounded-2xl overflow-hidden animate-in pointer-events-auto"
            style={{
                background: 'var(--bg-1)',
                border: '1px solid var(--bg-4)',
                boxShadow: '0 12px 48px rgba(0,0,0,0.4), 0 0 0 1px var(--glass)',
            }}>

            {/* Header */}
            <div className="flex items-center gap-2.5 px-4 py-2.5 shrink-0"
                style={{
                    background: 'linear-gradient(90deg, rgba(var(--color-accent-rgb), 0.08) 0%, var(--bg-2) 50%)',
                    borderBottom: '1px solid rgba(var(--color-accent-rgb), 0.10)',
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
                        <span className="w-2 h-2 rounded-full" style={{ background: 'var(--color-success)' }} />
                        <span className="text-[10px] font-mono text-[var(--text-ghost)]">{done}</span>
                        {errs > 0 && (
                            <>
                                <span className="w-2 h-2 rounded-full ml-1" style={{ background: 'var(--color-danger)' }} />
                                <span className="text-[10px] font-mono text-[var(--color-danger)]/70">{errs}</span>
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
                    <span className="text-[9px] font-mono text-[var(--text-ghost)] opacity-50">ESC</span>
                    <button onClick={() => setMinimized(true)} className="p-1.5 rounded-lg hover:bg-[var(--bg-4)] text-[var(--text-ghost)] hover:text-[var(--text-muted)] transition-colors" title="Minimize">
                        <Minus className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={handleDismiss} className="p-1.5 rounded-lg hover:bg-[var(--bg-4)] text-[var(--text-ghost)] hover:text-[var(--text-muted)] transition-colors" title="Close (Esc)">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            {/* React Flow canvas */}
            <div className="flex-1 relative">
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    fitView
                    proOptions={{ hideAttribution: true }}
                    nodesDraggable={true}
                    nodesConnectable={false}
                    elementsSelectable={true}
                    minZoom={0.3}
                    maxZoom={2}
                    defaultEdgeOptions={{
                        type: 'smoothstep',
                    }}
                >
                    <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--glass)" />
                    <Controls
                        showInteractive={false}
                        className="!bg-[var(--bg-3)] !border-[var(--bg-4)] !shadow-lg [&>button]:!bg-[var(--bg-3)] [&>button]:!border-[var(--bg-4)] [&>button]:!text-[var(--text-secondary)] [&>button:hover]:!bg-[var(--bg-4)]"
                    />
                    <AutoFit nodeCount={nodes.length} />
                </ReactFlow>
            </div>

            {/* Footer — current step detail */}
            {currentStep && (
                <div className="px-4 py-2.5 shrink-0" style={{ background: 'var(--bg-2)', borderTop: '1px solid var(--border-subtle)' }}>
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 rounded flex items-center justify-center shrink-0"
                            style={{ background: `${getNodeColor(currentStep)}15`, color: getNodeColor(currentStep) }}>
                            {agentStatus !== 'idle' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="text-[9px] font-mono text-[var(--text-ghost)] uppercase tracking-wider">{t.flowCurrentStep}</span>
                                <span className="text-[10px] font-mono font-semibold truncate" style={{ color: getNodeColor(currentStep) }}>
                                    {currentStep.label}
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
