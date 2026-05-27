"use client";

import React, { useState } from 'react';
import { GitBranch, FileText, FileBox, Plus, Trash2 } from 'lucide-react';
import { Section } from './Section';
import type { T } from './i18n';
import type { WorktreeInfo } from '@/lib/types';

export interface Task {
    id: number; subject: string; description: string; status: string;
    owner: string | null; blockedBy: number[]; blocks: number[];
}

export interface ArtifactGroup {
    taskId: number | null;
    files: Array<{ name: string; createdAt: string; size: number; description: string }>;
}

interface Props {
    t: T;
    todos: Array<{ content: string; status: string; activeForm: string }>;
    tasks: Task[];
    worktrees: WorktreeInfo[];
    artifacts: ArtifactGroup[];
    onToggleTodo: (idx: number, status: string) => void;
    taskFilter?: { status?: string; owner?: string; keyword?: string };
    onTaskFilterChange?: (filter: { status?: string; owner?: string; keyword?: string }) => void;
    onCreateTask?: (subject: string, description: string) => void;
    onUpdateTaskStatus?: (id: number, status: string) => void;
    onDeleteTask?: (id: number) => void;
}

const TASK_S: Record<string, { icon: string; tagCls: string; textCls: string }> = {
    completed:   { icon: '✓', tagCls: 'tag tag-teal',   textCls: 'text-[var(--text-muted)] line-through' },
    in_progress: { icon: '▸', tagCls: 'tag tag-sky',    textCls: 'text-[var(--text-primary)]' },
    pending:     { icon: '○', tagCls: 'tag tag-gray',   textCls: 'text-[var(--text-secondary)]' },
    expired:     { icon: '✕', tagCls: 'tag tag-red',    textCls: 'text-[var(--text-ghost)] line-through' },
};

export function LeftPanel({ t, todos, tasks, worktrees, artifacts, onToggleTodo, taskFilter, onTaskFilterChange, onCreateTask, onUpdateTaskStatus, onDeleteTask }: Props) {
    const totalFiles = artifacts.reduce((sum, g) => sum + g.files.length, 0);
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [newSubject, setNewSubject] = useState('');
    const [newDescription, setNewDescription] = useState('');
    const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
    return (
        <div className="flex flex-col h-full">
            <div className="h-12 topbar-accent flex items-center px-4 gap-2.5 shrink-0">
                <span className="w-2 h-2 rounded-full bg-[var(--color-accent)]" />
                <h2 className="sh sh-sky">{t.localOps}</h2>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-hide">
                <Section title={t.worktrees} titleClass="sh sh-indigo"
                    icon={<GitBranch className="w-3.5 h-3.5 text-[var(--color-accent2)]" />}
                    count={worktrees.length > 0 ? <span className="tag tag-indigo">{worktrees.length}</span> : undefined}
                    defaultOpen={false}>
                    {worktrees.length === 0 ? (
                        <p className="text-[12px] text-[var(--text-ghost)] italic">{t.noWorktrees}</p>
                    ) : (
                        <div className="flex flex-col gap-1.5">
                            {worktrees.map((wt, i) => (
                                <div key={i} className="card-dark px-3 py-2 flex items-center gap-2">
                                    <GitBranch className="w-3 h-3 shrink-0" style={{ color: wt.isMain ? 'var(--color-success)' : 'var(--color-accent2)' }} />
                                    <div className="min-w-0 flex-1">
                                        <span className="text-[11px] font-mono font-semibold text-[var(--text-primary)] block truncate">
                                            {wt.branch}
                                        </span>
                                        <span className="text-[9px] font-mono text-[var(--text-ghost)] block truncate">
                                            {wt.path}
                                        </span>
                                    </div>
                                    {wt.isMain && <span className="tag tag-green text-[8px]">main</span>}
                                    {wt.locked && <span className="tag tag-amber text-[8px]">locked</span>}
                                    {wt.bare && <span className="tag tag-gray text-[8px]">bare</span>}
                                </div>
                            ))}
                        </div>
                    )}
                </Section>

                <div className="divider" />

                <Section title={t.todos} titleClass="sh sh-teal"
                    count={todos.length > 0 ? <span className="tag tag-teal">{todos.filter(t => t.status === 'completed').length}/{todos.length}</span> : undefined}>
                    {todos.length === 0 ? (
                        <p className="text-[12px] text-[var(--text-ghost)] italic">{t.noTodos}</p>
                    ) : (
                        <ul className="space-y-1">
                            {todos.map((todo, idx) => (
                                <li key={idx}
                                    className="group flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all hover:bg-[var(--bg-3)] active:scale-[0.98]"
                                    onClick={() => onToggleTodo(idx, todo.status)}>
                                    <span className={`w-4 h-4 rounded border-2 flex items-center justify-center text-[9px] font-bold shrink-0 transition-all ${
                                        todo.status === 'completed' ? 'bg-[var(--color-teal)] border-[var(--color-teal)] text-[var(--bg-0)]'
                                        : todo.status === 'in_progress' ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                                        : 'border-[var(--text-ghost)] group-hover:border-[var(--text-muted)]'
                                    }`}>
                                        {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '▸' : ''}
                                    </span>
                                    <span className={`text-[12px] leading-tight ${
                                        todo.status === 'completed' ? 'text-[var(--text-ghost)] line-through'
                                        : todo.status === 'in_progress' ? 'text-[var(--text-primary)] font-medium'
                                        : 'text-[var(--text-secondary)]'
                                    }`}>{todo.content}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Section>

                <div className="divider" />

                <Section title={t.tasks} titleClass="sh sh-amber"
                    count={
                        <div className="flex items-center gap-1.5">
                            {tasks.length > 0 && <span className="tag tag-amber">{tasks.filter(t => t.status === 'completed').length}/{tasks.length}</span>}
                            {onCreateTask && (
                                <button
                                    onClick={e => { e.preventDefault(); setShowCreateForm(!showCreateForm); }}
                                    className="w-5 h-5 rounded flex items-center justify-center bg-[var(--bg-3)] hover:bg-[var(--bg-4)] text-[var(--text-muted)] transition-colors"
                                    title={t.createTask}
                                >
                                    <Plus className="w-3 h-3" />
                                </button>
                            )}
                        </div>
                    }>
                    {onCreateTask && showCreateForm && (
                        <div className="card p-3 mb-3 border border-[var(--bg-4)]">
                            <input
                                type="text"
                                value={newSubject}
                                onChange={e => setNewSubject(e.target.value)}
                                placeholder={t.taskSubject}
                                className="w-full bg-[var(--bg-0)] border border-[var(--bg-3)] rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)] outline-none focus:border-[var(--text-muted)] placeholder:text-[var(--text-ghost)] mb-2"
                            />
                            <textarea
                                value={newDescription}
                                onChange={e => setNewDescription(e.target.value)}
                                placeholder={t.taskDescription}
                                rows={2}
                                className="w-full bg-[var(--bg-0)] border border-[var(--bg-3)] rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)] outline-none focus:border-[var(--text-muted)] placeholder:text-[var(--text-ghost)] mb-2 resize-none"
                            />
                            <div className="flex gap-2 justify-end">
                                <button
                                    onClick={() => { setShowCreateForm(false); setNewSubject(''); setNewDescription(''); }}
                                    className="px-2.5 py-1 rounded-lg text-[10px] font-medium text-[var(--text-muted)] hover:bg-[var(--bg-3)] transition-colors"
                                >
                                    {t.cancel}
                                </button>
                                <button
                                    onClick={() => {
                                        if (newSubject.trim()) {
                                            onCreateTask(newSubject.trim(), newDescription.trim());
                                            setShowCreateForm(false);
                                            setNewSubject('');
                                            setNewDescription('');
                                        }
                                    }}
                                    className="px-2.5 py-1 rounded-lg text-[10px] font-medium bg-[var(--bg-3)] text-[var(--text-primary)] hover:bg-[var(--bg-4)] transition-colors"
                                >
                                    {t.submit}
                                </button>
                            </div>
                        </div>
                    )}
                    {onTaskFilterChange && (
                        <div className="flex flex-col gap-2 mb-3">
                            <div className="flex gap-2">
                                <select
                                    value={taskFilter?.status || ''}
                                    onChange={e => onTaskFilterChange({ ...taskFilter, status: e.target.value || undefined })}
                                    className="flex-1 bg-[var(--bg-0)] border border-[var(--bg-3)] rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)] outline-none focus:border-[var(--text-muted)]"
                                >
                                    <option value="">{t.filterAll}</option>
                                    <option value="pending">{t.filterPending}</option>
                                    <option value="in_progress">{t.filterInProgress}</option>
                                    <option value="completed">{t.filterCompleted}</option>
                                    <option value="expired">{t.filterExpired}</option>
                                </select>
                            </div>
                            <input
                                type="text"
                                value={taskFilter?.keyword || ''}
                                onChange={e => onTaskFilterChange({ ...taskFilter, keyword: e.target.value || undefined })}
                                placeholder={t.searchPlaceholder}
                                className="bg-[var(--bg-0)] border border-[var(--bg-3)] rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)] outline-none focus:border-[var(--text-muted)] placeholder:text-[var(--text-ghost)]"
                            />
                        </div>
                    )}
                    {tasks.length === 0 ? (
                        <p className="text-[12px] text-[var(--text-ghost)] italic">{t.noTasks}</p>
                    ) : (
                        <ul className="space-y-2">
                            {tasks.map(task => {
                                const s = TASK_S[task.status] || TASK_S.pending;
                                return (
                                    <li key={task.id} className="card p-3">
                                        <div className="flex items-start gap-2.5">
                                            <span className={`${s.tagCls} mt-0.5 shrink-0`}>{s.icon}</span>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-mono text-[11px] text-[var(--text-muted)]">#{task.id}</span>
                                                    <span className={`text-[12px] font-medium truncate ${s.textCls}`}>{task.subject}</span>
                                                </div>
                                                {task.description && (
                                                    <p className="text-[11px] text-[var(--text-muted)] mt-1 leading-relaxed line-clamp-2">{task.description}</p>
                                                )}
                                                {(task.owner || task.blockedBy.length > 0) && (
                                                    <div className="flex items-center gap-2 mt-1.5">
                                                        {task.owner && <span className="tag tag-indigo">@{task.owner}</span>}
                                                        {task.blockedBy.length > 0 && (
                                                            <span className="tag tag-red">blocked by {task.blockedBy.map(id => `#${id}`).join(', ')}</span>
                                                        )}
                                                    </div>
                                                )}
                                                {(onUpdateTaskStatus || onDeleteTask) && (
                                                    <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[var(--bg-3)]">
                                                        {onUpdateTaskStatus && (
                                                            <select
                                                                value={task.status}
                                                                onChange={e => onUpdateTaskStatus(task.id, e.target.value)}
                                                                className="bg-[var(--bg-0)] border border-[var(--bg-3)] rounded px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)] outline-none focus:border-[var(--text-muted)]"
                                                            >
                                                                <option value="pending">{t.filterPending}</option>
                                                                <option value="in_progress">{t.filterInProgress}</option>
                                                                <option value="completed">{t.filterCompleted}</option>
                                                                <option value="expired">{t.filterExpired}</option>
                                                            </select>
                                                        )}
                                                        {onDeleteTask && (
                                                            deleteConfirm === task.id ? (
                                                                <div className="flex items-center gap-1 ml-auto">
                                                                    <button
                                                                        onClick={() => setDeleteConfirm(null)}
                                                                        className="px-1.5 py-0.5 rounded text-[9px] font-medium text-[var(--text-muted)] hover:bg-[var(--bg-3)] transition-colors"
                                                                    >
                                                                        {t.cancel}
                                                                    </button>
                                                                    <button
                                                                        onClick={() => { onDeleteTask(task.id); setDeleteConfirm(null); }}
                                                                        className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                                                                    >
                                                                        {t.confirmDelete}
                                                                    </button>
                                                                </div>
                                                            ) : (
                                                                <button
                                                                    onClick={() => setDeleteConfirm(task.id)}
                                                                    className="ml-auto p-1 rounded hover:bg-red-500/10 text-[var(--text-ghost)] hover:text-red-400 transition-colors"
                                                                    title={t.deleteTask}
                                                                >
                                                                    <Trash2 className="w-3 h-3" />
                                                                </button>
                                                            )
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </Section>

                {totalFiles > 0 && (
                    <>
                        <div className="divider" />
                        <Section title="产出文件" titleClass="sh sh-sky"
                            icon={<FileBox className="w-3.5 h-3.5 text-[var(--color-accent)]" />}
                            count={<span className="tag tag-sky">{totalFiles}</span>}
                            defaultOpen={false}>
                            <ul className="space-y-2">
                                {artifacts.filter(g => g.files.length > 0).map((group, gi) => (
                                    <li key={gi}>
                                        <div className="text-[10px] font-mono text-[var(--text-muted)] mb-1">
                                            {group.taskId ? `Task #${group.taskId}` : 'Shared'}
                                        </div>
                                        <ul className="space-y-0.5">
                                            {group.files.map((f, fi) => (
                                                <li key={fi} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--bg-3)] transition-colors">
                                                    <FileText className="w-3 h-3 text-[var(--color-accent)]/60 shrink-0" />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="text-[11px] text-[var(--text-secondary)] truncate">{f.name}</div>
                                                        {f.description && <div className="text-[10px] text-[var(--text-ghost)] truncate">{f.description}</div>}
                                                    </div>
                                                    <span className="text-[9px] text-[var(--text-ghost)] font-mono shrink-0">{f.size > 1024 ? `${(f.size / 1024).toFixed(1)}K` : `${f.size}B`}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </li>
                                ))}
                            </ul>
                        </Section>
                    </>
                )}
            </div>
        </div>
    );
}
