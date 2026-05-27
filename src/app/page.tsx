"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { TRANSLATIONS, type Lang } from '@/components/i18n';
import { LeftPanel } from '@/components/LeftPanel';
import { RightPanel } from '@/components/RightPanel';
import { ChatPanel, type Attachment, type Message } from '@/components/ChatPanel';
import type { LogEntry } from '@/components/WorkflowView';
import { useTheme } from '@/hooks/useTheme';
import type { WorktreeInfo } from '@/lib/types';

export default function Home() {
    const [lang, setLang] = useState<Lang>('zh');
    const { theme, toggle: toggleTheme } = useTheme();
    const [messages, setMessages] = useState<Message[]>([]);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [status, setStatus] = useState<'idle' | 'thinking' | 'executing_tools'>('idle');
    const [globalState, setGlobalState] = useState<{
        todos: Array<{ content: string; status: string; activeForm: string }>;
        tasks: Array<{ id: number; subject: string; description: string; status: string; owner: string | null; blockedBy: number[]; blocks: number[] }>;
        teammates: Array<{ name: string; role: string; status: string }>;
        worktrees: WorktreeInfo[];
        bgTasks: Array<{ id: string; command: string; status: string }>;
        cronTasks: Array<{ id: string; command: string; intervalMs: number; lastRun: string | null; count: number }>;
        artifacts: Array<{ taskId: number | null; files: Array<{ name: string; createdAt: string; size: number; description: string }> }>;
        auditLog: Array<{ ts: string; action: string; taskId: number; actor: string; details: Record<string, unknown> }>;
        knowledge: { docCount: number; chunkCount: number; sources: Array<{ source: string; chunkCount: number; ingestedAt: string }> };
    }>({
        todos: [], tasks: [], teammates: [], worktrees: [], bgTasks: [], cronTasks: [], artifacts: [], auditLog: [],
        knowledge: { docCount: 0, chunkCount: 0, sources: [] }
    });
    const [telemetry, setTelemetry] = useState({ totalSession: 0, lastRequest: 0, totalRequests: 0, lastPrompt: 0, lastCompletion: 0 });
    const [taskFilter, setTaskFilter] = useState<{ status?: string; owner?: string; keyword?: string }>({});

    // Mobile drawer state
    const [leftOpen, setLeftOpen] = useState(false);
    const [rightOpen, setRightOpen] = useState(false);

    // Session state
    const [sessions, setSessions] = useState<{ id: string; title: string; messageCount: number; createdAt: string; updatedAt: string }[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
    const messagesRef = useRef(messages);
    useEffect(() => { messagesRef.current = messages; }, [messages]);
    const msgId = () => crypto.randomUUID().slice(0, 8);
    // Sync ref BEFORE setMessages — ref must be current for save logic
    const addMessage = useCallback((msg: Message) => {
        messagesRef.current = [...messagesRef.current, msg];
        setMessages(prev => [...prev, msg]);
    }, []);

    const t = TRANSLATIONS[lang];

    // Polling state
    useEffect(() => {
        let etag = '';
        const fetchState = async () => {
            try {
                const headers: Record<string, string> = {};
                if (etag) headers['If-None-Match'] = etag;
                const params = new URLSearchParams();
                if (taskFilter.status) params.set('status', taskFilter.status);
                if (taskFilter.owner) params.set('owner', taskFilter.owner);
                if (taskFilter.keyword) params.set('keyword', taskFilter.keyword);
                const qs = params.toString();
                const res = await fetch(`/api/state${qs ? '?' + qs : ''}`, { headers });
                if (res.status === 304) return;
                const newEtag = res.headers.get('ETag');
                if (newEtag) etag = newEtag;
                const data = await res.json();
                setGlobalState({
                    todos: data.todos || [], tasks: data.tasks || [],
                    teammates: data.teammates || [], worktrees: data.worktrees || [],
                    bgTasks: data.bgTasks || [], cronTasks: data.cronTasks || [],
                    artifacts: data.artifacts || [], auditLog: data.auditLog || [],
                    knowledge: data.knowledge || { docCount: 0, chunkCount: 0, sources: [] }
                });
                if (data.bgNotifs?.length) {
                    const bgMsgs = data.bgNotifs.map((n: { task_id: string; status: string; result: string }) => ({
                        id: msgId(),
                        role: 'assistant' as const,
                        content: `[BACKGROUND TASK: ${n.task_id}] Status: ${n.status}\nOutput:\n${n.result}`
                    }));
                    messagesRef.current = [...messagesRef.current, ...bgMsgs];
                    setMessages(prev => [...prev, ...bgMsgs]);
                }
            } catch {}
        };
        fetchState();
        const interval = setInterval(fetchState, 2000);
        return () => clearInterval(interval);
    }, [taskFilter]);

    // Load sessions on mount
    useEffect(() => {
        fetch('/api/sessions')
            .then(res => res.json())
            .then(data => {
                if (data.success && data.data?.length) {
                    setSessions(data.data);
                    // Auto-restore the latest session
                    const latest = data.data[0];
                    fetch(`/api/sessions?id=${latest.id}`)
                        .then(r => r.json())
                        .then(sd => {
                            if (sd.success && sd.data) {
                                setCurrentSessionId(sd.data.id);
                                messagesRef.current = sd.data.messages || [];
                                setMessages(sd.data.messages || []);
                            }
                        }).catch(() => {});
                }
            })
            .catch(() => {});
    }, []);

    const refreshSessions = useCallback(async () => {
        try {
            const res = await fetch('/api/sessions');
            const data = await res.json();
            if (data.success) setSessions(data.data || []);
        } catch {}
    }, []);

    const handleSend = useCallback(async (inputText: string, fileAttachments: Attachment[] = []) => {
        if ((!inputText.trim() && fileAttachments.length === 0) || status !== 'idle') return;

        // Auto-create session if none exists
        let activeSessionId = currentSessionId;
        if (!activeSessionId) {
            try {
                const res = await fetch('/api/sessions', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    activeSessionId = data.data.id;
                    setCurrentSessionId(data.data.id);
                }
            } catch {}
        }

        const userMsg: Message = { id: msgId(), role: 'user', content: inputText, attachments: fileAttachments.length > 0 ? fileAttachments : undefined };
        const prevMessages = [...messages];
        addMessage(userMsg);
        setStatus('thinking');
        setLogs(prev => [...prev, { msg: '> User prompt sent', reqId: 'client', ts: Date.now() }]);

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: inputText, history: prevMessages, attachments: fileAttachments.length > 0 ? fileAttachments : undefined })
            });
            if (!res.body) return;

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let streamDone = false;
            let buffer = '';
            let shouldSave = false;
            let saveReqId = '';

            const processBlock = (block: string) => {
                const eventMatch = block.match(/event: (.*)\n/);
                const dataMatch = block.match(/data: ([\s\S]*)/);
                if (!eventMatch || !dataMatch) return;

                const event = eventMatch[1];
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let dataObj: any;
                try { dataObj = JSON.parse(dataMatch[1]); } catch { dataObj = dataMatch[1]; }

                switch (event) {
                    case 'log':
                        if (typeof dataObj === 'object' && dataObj.msg) {
                            setLogs(prev => [...prev, { msg: dataObj.msg, reqId: dataObj.reqId || 'unknown', ts: Date.now(), toolName: dataObj.toolName, toolArgs: dataObj.toolArgs, toolOutput: dataObj.toolOutput }]);
                        } else {
                            setLogs(prev => [...prev, { msg: String(dataObj), reqId: 'unknown', ts: Date.now() }]);
                        }
                        break;
                    case 'state': setStatus(dataObj.status); break;
                    case 'message': addMessage({ id: msgId(), role: 'assistant', content: dataObj.content }); break;
                    case 'telemetry':
                        setTelemetry(prev => ({
                            totalSession: prev.totalSession + (dataObj.total_tokens || 0),
                            lastRequest: dataObj.total_tokens || 0,
                            totalRequests: prev.totalRequests + 1,
                            lastPrompt: dataObj.prompt_tokens || 0,
                            lastCompletion: dataObj.completion_tokens || 0,
                        }));
                        break;
                    case 'done':
                        setStatus('idle');
                        shouldSave = true;
                        saveReqId = dataObj.reqId || '';
                        break;
                    case 'error':
                        setLogs(prev => [...prev, { msg: `[ERROR] ${dataObj.message}`, reqId: 'error', ts: Date.now() }]);
                        setStatus('idle');
                        break;
                }
            };

            const processBuffer = (text: string, isFinal: boolean) => {
                const parts = text.split('\n\n');
                // Last part may be incomplete (no trailing \n\n) — keep as remaining unless final flush
                const remaining = isFinal ? '' : (parts.pop() || '');
                for (const block of parts) {
                    if (block.trim()) processBlock(block);
                }
                // Final flush: process remaining text as a complete block even without \n\n
                if (isFinal && remaining.trim()) {
                    processBlock(remaining);
                }
                return isFinal ? '' : remaining;
            };

            while (!streamDone) {
                const { value, done: doneReading } = await reader.read();
                streamDone = doneReading;
                if (value) {
                    buffer += decoder.decode(value, { stream: true });
                    buffer = processBuffer(buffer, false);
                }
            }
            // Flush decoder and process any remaining buffer
            buffer += decoder.decode();
            if (buffer.trim()) {
                processBuffer(buffer, true);
            }
            // Save session AFTER all events are processed
            if (shouldSave && activeSessionId) {
                const finalMsgs = messagesRef.current;
                const title = prevMessages.length === 0 ? inputText.slice(0, 40) : undefined;
                fetch('/api/sessions', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: activeSessionId, messages: finalMsgs, title })
                }).then(() => refreshSessions()).catch(() => {});
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setLogs(prev => [...prev, { msg: `[NETWORK_ERROR] ${message}`, reqId: 'error', ts: Date.now() }]);
            setStatus('idle');
        }
    }, [messages, status, currentSessionId, refreshSessions]);

    const handleAbort = useCallback(async () => {
        setLogs(prev => [...prev, { msg: '> Abort signal sent', reqId: 'client', ts: Date.now() }]);
        try { await fetch('/api/chat/abort', { method: 'POST' }); } catch {}
    }, []);

    const handleNewSession = useCallback(async () => {
        try {
            const res = await fetch('/api/sessions', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setCurrentSessionId(data.data.id);
                messagesRef.current = [];
                setMessages([]);
                setLogs([]);
                setTelemetry({ totalSession: 0, lastRequest: 0, totalRequests: 0, lastPrompt: 0, lastCompletion: 0 });
                await refreshSessions();
            }
        } catch {}
    }, [refreshSessions]);

    const handleSwitchSession = useCallback(async (id: string) => {
        try {
            const res = await fetch(`/api/sessions?id=${id}`);
            const data = await res.json();
            if (data.success && data.data) {
                setCurrentSessionId(data.data.id);
                messagesRef.current = data.data.messages || [];
                setMessages(data.data.messages || []);
                setLogs([]);
                setTelemetry({ totalSession: 0, lastRequest: 0, totalRequests: 0, lastPrompt: 0, lastCompletion: 0 });
            }
        } catch {}
    }, []);

    const handleDeleteSession = useCallback(async (id: string) => {
        try {
            await fetch(`/api/sessions?id=${id}`, { method: 'DELETE' });
            const remaining = sessions.filter(s => s.id !== id);
            setSessions(remaining);
            if (currentSessionId === id) {
                if (remaining.length > 0) {
                    await handleSwitchSession(remaining[0].id);
                } else {
                    await handleNewSession();
                }
            }
        } catch {}
    }, [sessions, currentSessionId, handleSwitchSession, handleNewSession]);

    const handleClearMessages = useCallback(async () => {
        messagesRef.current = [];
        setMessages([]);
        setLogs([]);
        setTelemetry({ totalSession: 0, lastRequest: 0, totalRequests: 0, lastPrompt: 0, lastCompletion: 0 });
        if (currentSessionId) {
            try {
                await fetch('/api/sessions', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: currentSessionId, messages: [] }),
                });
            } catch {}
        }
    }, [currentSessionId]);

    const toggleTodo = useCallback(async (idx: number, currentStatus: string) => {
        const nextStatus = currentStatus === 'completed' ? 'pending' : currentStatus === 'pending' ? 'in_progress' : 'completed';
        setGlobalState(prev => {
            const todos = [...prev.todos];
            todos[idx] = { ...todos[idx], status: nextStatus };
            return { ...prev, todos };
        });
        try {
            await fetch('/api/todos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index: idx, status: nextStatus })
            });
        } catch {}
    }, []);

    const handleCreateTask = useCallback(async (subject: string, description: string) => {
        try {
            await fetch('/api/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subject, description })
            });
        } catch {}
    }, []);

    const handleUpdateTaskStatus = useCallback(async (id: number, status: string) => {
        const prevTasks = globalState.tasks;
        setGlobalState(prev => ({
            ...prev,
            tasks: prev.tasks.map(t => t.id === id ? { ...t, status } : t)
        }));
        try {
            const res = await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, status })
            });
            if (!res.ok) throw new Error('Failed');
        } catch {
            // Revert on error
            setGlobalState(prev => ({ ...prev, tasks: prevTasks }));
        }
    }, [globalState.tasks]);

    const handleDeleteTask = useCallback(async (id: number) => {
        setGlobalState(prev => ({
            ...prev,
            tasks: prev.tasks.filter(t => t.id !== id)
        }));
        try {
            await fetch('/api/tasks', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
        } catch {}
    }, []);

    return (
        <div className="flex h-screen w-full overflow-hidden p-2 md:p-4 gap-2 md:gap-4">
            {/* Left Panel — desktop */}
            <div className="hidden md:flex flex-col w-64 xl:w-72 panel-side rounded-2xl overflow-hidden shrink-0">
                <LeftPanel
                    t={t}
                    todos={globalState.todos}
                    tasks={globalState.tasks}
                    worktrees={globalState.worktrees}
                    artifacts={globalState.artifacts}
                    onToggleTodo={toggleTodo}
                    taskFilter={taskFilter}
                    onTaskFilterChange={setTaskFilter}
                    onCreateTask={handleCreateTask}
                    onUpdateTaskStatus={handleUpdateTaskStatus}
                    onDeleteTask={handleDeleteTask}
                />
            </div>

            {/* Mobile drawer — left */}
            {leftOpen && (
                <div className="fixed inset-0 z-50 md:hidden flex">
                    <div className="w-72 max-w-[80vw] panel-side h-full relative">
                        <button onClick={() => setLeftOpen(false)} className="absolute top-3 right-3 p-1 rounded-lg hover:bg-white/10 text-gray-400 z-10">
                            <X className="w-4 h-4" />
                        </button>
                        <LeftPanel t={t} todos={globalState.todos} tasks={globalState.tasks} worktrees={globalState.worktrees} artifacts={globalState.artifacts} onToggleTodo={toggleTodo} taskFilter={taskFilter} onTaskFilterChange={setTaskFilter} onCreateTask={handleCreateTask} onUpdateTaskStatus={handleUpdateTaskStatus} onDeleteTask={handleDeleteTask} />
                    </div>
                    <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={() => setLeftOpen(false)} />
                </div>
            )}

            {/* Chat Panel */}
            <ChatPanel
                t={t}
                lang={lang}
                onToggleLang={() => setLang(l => l === 'zh' ? 'en' : 'zh')}
                theme={theme}
                onToggleTheme={toggleTheme}
                messages={messages}
                status={status}
                onSend={handleSend}
                onAbort={handleAbort}
                onToggleLeft={() => setLeftOpen(true)}
                onToggleRight={() => setRightOpen(true)}
                sessions={sessions}
                currentSessionId={currentSessionId}
                onNewSession={handleNewSession}
                onSwitchSession={handleSwitchSession}
                onDeleteSession={handleDeleteSession}
                onClearMessages={handleClearMessages}
                logs={logs}
                agentStatus={status}
            />

            {/* Right Panel — desktop */}
            <div className="hidden lg:flex flex-col w-72 xl:w-80 panel-side rounded-2xl overflow-hidden shrink-0">
                <RightPanel t={t} telemetry={telemetry} teammates={globalState.teammates} bgTasks={globalState.bgTasks} cronTasks={globalState.cronTasks} logs={logs} agentStatus={status} auditLog={globalState.auditLog} knowledge={globalState.knowledge} />
            </div>

            {/* Mobile drawer — right */}
            {rightOpen && (
                <div className="fixed inset-0 z-50 lg:hidden flex justify-end">
                    <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={() => setRightOpen(false)} />
                    <div className="w-80 max-w-[85vw] panel-side h-full relative">
                        <button onClick={() => setRightOpen(false)} className="absolute top-3 right-3 p-1 rounded-lg hover:bg-white/10 text-gray-400 z-10">
                            <X className="w-4 h-4" />
                        </button>
                        <RightPanel t={t} telemetry={telemetry} teammates={globalState.teammates} bgTasks={globalState.bgTasks} cronTasks={globalState.cronTasks} logs={logs} agentStatus={status} auditLog={globalState.auditLog} knowledge={globalState.knowledge} />
                    </div>
                </div>
            )}
        </div>
    );
}
