"use client";

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Send, Loader2, Globe, Square, PanelLeftOpen, PanelRightOpen, Terminal, Sparkles, Plus, MessageSquare, ChevronDown, Trash2, Paperclip, FileText, Image as ImageIcon, Sun, Moon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { T, Lang } from './i18n';
import type { Theme } from '@/hooks/useTheme';
import { FlowGraph } from './FlowGraph';
import type { LogEntry } from './WorkflowView';

export interface Attachment {
    name: string;
    type: string;
    data: string;   // base64 without data: prefix
    size: number;
}

export interface Message {
    id?: string;
    role: string;
    content: string;
    attachments?: Attachment[];
}

interface SessionSummary { id: string; title: string; messageCount: number; createdAt: string; updatedAt: string; }

interface SlashCommand {
    name: string;
    labelKey: keyof T;
    descKey: keyof T;
    action: 'input' | 'callback';
    insertText?: string;
    callbackKey?: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
    { name: 'clear', labelKey: 'slashClear', descKey: 'slashClearDesc', action: 'callback', callbackKey: 'clear' },
    { name: 'new', labelKey: 'slashNew', descKey: 'slashNewDesc', action: 'callback', callbackKey: 'new' },
    { name: 'compress', labelKey: 'slashCompress', descKey: 'slashCompressDesc', action: 'input', insertText: '/compress' },
    { name: 'tasks', labelKey: 'slashTasks', descKey: 'slashTasksDesc', action: 'input', insertText: '请列出所有任务' },
    { name: 'help', labelKey: 'slashHelp', descKey: 'slashHelpDesc', action: 'input', insertText: '请介绍你的功能和可用工具' },
];

interface Props {
    t: T; lang: Lang; onToggleLang: () => void;
    theme: Theme; onToggleTheme: () => void;
    messages: Message[]; status: 'idle' | 'thinking' | 'executing_tools';
    onSend: (msg: string, attachments: Attachment[]) => void; onAbort: () => void;
    onToggleLeft?: () => void; onToggleRight?: () => void;
    sessions: SessionSummary[];
    currentSessionId: string | null;
    onNewSession: () => void;
    onSwitchSession: (id: string) => void;
    onDeleteSession: (id: string) => void;
    onClearMessages?: () => void;
    logs?: LogEntry[];
    agentStatus?: 'idle' | 'thinking' | 'executing_tools';
}

function parseThinkingBlocks(content: string) {
    const re = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
    if (!re.test(content)) return [{ type: 'text' as const, content }];
    re.lastIndex = 0;
    const parts: Array<{ type: 'text' | 'thought'; content: string }> = [];
    let last = 0, m;
    while ((m = re.exec(content)) !== null) {
        if (m.index > last) parts.push({ type: 'text', content: content.slice(last, m.index) });
        parts.push({ type: 'thought', content: m[2].trim() });
        last = re.lastIndex;
    }
    if (last < content.length) parts.push({ type: 'text', content: content.slice(last) });
    return parts;
}

export function ChatPanel({ t, lang, onToggleLang, theme, onToggleTheme, messages, status, onSend, onAbort, onToggleLeft, onToggleRight, sessions, currentSessionId, onNewSession, onSwitchSession, onDeleteSession, onClearMessages, logs, agentStatus }: Props) {
    const [flowDismissed, setFlowDismissed] = useState(false);
    const [input, setInput] = useState('');
    const scrollRef = useRef<HTMLDivElement>(null);
    const taRef = useRef<HTMLTextAreaElement>(null);
    const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
    const sessionMenuRef = useRef<HTMLDivElement>(null);
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [dragging, setDragging] = useState(false);
    const [slashMenu, setSlashMenu] = useState<{ open: boolean; filter: string; selectedIdx: number }>({ open: false, filter: '', selectedIdx: 0 });
    const blurTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    const MAX_FILES = 5;

    const processFiles = useCallback(async (files: FileList | File[]) => {
        const fileArray = Array.from(files);
        const remaining = MAX_FILES - attachments.length;
        if (remaining <= 0) return;

        const toProcess = fileArray.slice(0, remaining);
        const newAttachments: Attachment[] = [];

        for (const file of toProcess) {
            if (file.size > MAX_FILE_SIZE) continue;
            try {
                const base64 = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
                newAttachments.push({ name: file.name, type: file.type, data: base64, size: file.size });
            } catch { /* skip */ }
        }

        setAttachments(prev => [...prev, ...newAttachments]);
    }, [attachments.length]);

    const removeAttachment = useCallback((idx: number) => {
        setAttachments(prev => prev.filter((_, i) => i !== idx));
    }, []);

    const filteredCommands = useMemo(() =>
        slashMenu.open
            ? SLASH_COMMANDS.filter(cmd => cmd.name.startsWith(slashMenu.filter.toLowerCase()))
            : [],
        [slashMenu.open, slashMenu.filter]
    );

    const executeCommand = useCallback((cmd: SlashCommand) => {
        setSlashMenu({ open: false, filter: '', selectedIdx: 0 });
        if (cmd.action === 'callback') {
            if (cmd.callbackKey === 'clear') {
                onClearMessages?.();
                setInput('');
            } else if (cmd.callbackKey === 'new') {
                onNewSession();
                setInput('');
            }
        } else if (cmd.insertText) {
            setInput(cmd.insertText);
            taRef.current?.focus();
        }
    }, [onClearMessages, onNewSession]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) processFiles(e.dataTransfer.files);
    }, [processFiles]);

    useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, status]);
    useEffect(() => { if (agentStatus && agentStatus !== 'idle') setFlowDismissed(false); }, [agentStatus]);
    useEffect(() => {
        if (!sessionMenuOpen) return;
        const handler = (e: MouseEvent) => {
            if (sessionMenuRef.current && !sessionMenuRef.current.contains(e.target as Node)) setSessionMenuOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [sessionMenuOpen]);
    useEffect(() => () => { if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current); }, []);
    const adjustHeight = useCallback(() => {
        const el = taRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    }, []);
    useEffect(() => { adjustHeight(); }, [input, adjustHeight]);

    const submit = (e?: React.FormEvent) => {
        e?.preventDefault();
        if ((!input.trim() && attachments.length === 0) || status !== 'idle') return;
        onSend(input, attachments); setInput(''); setAttachments([]);
    };

    return (
        <div className="flex-1 flex flex-col panel-main rounded-2xl overflow-hidden relative">
            <div className="h-12 topbar-main flex items-center px-4 md:px-5 gap-2.5 shrink-0">
                {onToggleLeft && (
                    <button onClick={onToggleLeft} className="md:hidden p-1.5 rounded-lg hover:bg-[var(--bg-4)] text-[var(--text-muted)] transition-colors">
                        <PanelLeftOpen className="w-4 h-4" />
                    </button>
                )}
                <Terminal className="w-4 h-4 text-[var(--color-accent)]" />
                <h1 className="text-[13px] font-semibold text-[var(--text-primary)] hidden sm:block">{t.title}</h1>

                {/* Session selector */}
                <div className="relative ml-1" ref={sessionMenuRef}>
                    <button onClick={() => setSessionMenuOpen(!sessionMenuOpen)}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--bg-3)] hover:bg-[var(--bg-4)] text-[12px] text-[var(--text-secondary)] transition-colors max-w-[180px]">
                        <MessageSquare className="w-3 h-3 shrink-0" />
                        <span className="truncate">{sessions.find(s => s.id === currentSessionId)?.title || t.sessionUntitled}</span>
                        <ChevronDown className="w-3 h-3 shrink-0" />
                    </button>
                    {sessionMenuOpen && (
                        <div className="absolute top-full left-0 mt-1 w-64 bg-[var(--bg-2)] border border-[var(--bg-4)] rounded-xl shadow-2xl z-50 overflow-hidden animate-in">
                            <button onClick={() => { onNewSession(); setSessionMenuOpen(false); }}
                                className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-[var(--color-accent)] hover:bg-[var(--bg-3)] transition-colors border-b border-[var(--bg-4)]">
                                <Plus className="w-3.5 h-3.5" />{t.newSession}
                            </button>
                            <div className="max-h-60 overflow-y-auto">
                                {sessions.length === 0 ? (
                                    <div className="px-3 py-4 text-[11px] text-[var(--text-ghost)] text-center">{t.noSessions}</div>
                                ) : sessions.map(s => (
                                    <div key={s.id}
                                        className={`flex items-center gap-2 px-3 py-2 text-[12px] cursor-pointer transition-colors group ${s.id === currentSessionId ? 'bg-[var(--bg-3)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-3)]'}`}
                                        onClick={() => { onSwitchSession(s.id); setSessionMenuOpen(false); }}>
                                        <div className="flex-1 min-w-0">
                                            <div className="truncate font-medium">{s.title || t.sessionUntitled}</div>
                                            <div className="text-[10px] text-[var(--text-ghost)]">{s.messageCount} msgs</div>
                                        </div>
                                        <button onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id); }}
                                            className="p-1 rounded hover:bg-red-500/20 text-[var(--text-ghost)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all">
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                <div className="ml-auto flex items-center gap-2">
                    <button onClick={onToggleTheme}
                        className="p-1.5 rounded-lg hover:bg-[var(--bg-4)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                        title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
                        {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                    </button>
                    <button onClick={onToggleLang}
                        className="text-[11px] px-2.5 py-1 rounded-md bg-[var(--bg-4)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
                        <Globe className="w-3 h-3 inline mr-1 -mt-px" />{lang === 'zh' ? 'EN' : '中文'}
                    </button>
                    {onToggleRight && (
                        <button onClick={onToggleRight} className="lg:hidden p-1.5 rounded-lg hover:bg-[var(--bg-4)] text-[var(--text-muted)] transition-colors">
                            <PanelRightOpen className="w-4 h-4" />
                        </button>
                    )}
                </div>
            </div>

            {/* Flow Graph — absolute positioned flowchart overlay */}
            {logs && agentStatus && !flowDismissed && (
                <FlowGraph logs={logs} agentStatus={agentStatus} t={t} onDismiss={() => setFlowDismissed(true)} />
            )}

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 scrollbar-hide flex flex-col">
                {messages.length === 0 && (
                    <div className="flex-1 flex flex-col items-center justify-center gap-4">
                        <div className="w-16 h-16 rounded-2xl bg-[var(--bg-3)] flex items-center justify-center">
                            <Sparkles className="w-7 h-7 text-[var(--color-accent2)]/60" />
                        </div>
                        <p className="text-[14px] text-[var(--text-secondary)]">{t.welcomeLine}</p>
                        <p className="text-[11px] text-[var(--text-ghost)] font-mono">{t.welcomeSub}</p>
                    </div>
                )}

                {messages.map((m, i) => (
                    <div key={m.id ?? i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-in`}>
                        <div className={`max-w-[90%] md:max-w-[80%] rounded-2xl px-4 py-3 ${
                            m.role === 'user'
                                ? 'bg-[var(--color-accent)]/10 text-[var(--text-primary)]'
                                : 'card text-[var(--text-secondary)]'
                        }`}>
                            {m.role === 'user' ? (
                                <div>
                                    {m.attachments && m.attachments.length > 0 && (
                                        <div className="flex flex-wrap gap-2 mb-2">
                                            {m.attachments.map((att, ai) => (
                                                att.type.startsWith('image/') ? (
                                                    <img key={ai} src={`data:${att.type};base64,${att.data}`} alt={att.name}
                                                        className="max-w-[200px] max-h-[150px] rounded-lg object-cover border border-[var(--bg-4)]" />
                                                ) : (
                                                    <div key={ai} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--bg-3)] text-[11px] text-[var(--text-secondary)]">
                                                        <FileText className="w-3 h-3 shrink-0" />
                                                        <span className="truncate max-w-[120px]">{att.name}</span>
                                                    </div>
                                                )
                                            ))}
                                        </div>
                                    )}
                                    {m.content && <pre className="whitespace-pre-wrap text-[13px] leading-relaxed" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>{m.content}</pre>}
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {parseThinkingBlocks(m.content).map((part, pIdx) => {
                                        if (part.type === 'thought') {
                                            return (
                                                <details key={pIdx} className="group rounded-lg overflow-hidden bg-[var(--color-accent2)]/5">
                                                    <summary className="cursor-pointer px-3 py-2 flex items-center gap-2 select-none hover:bg-[var(--color-accent2)]/5 transition-colors">
                                                        <span className="w-2 h-2 rounded-full bg-[var(--color-accent2)]/40 group-open:bg-[var(--color-accent2)] transition-colors" />
                                                        <span className="font-mono text-[10px] tracking-wider uppercase text-[var(--color-accent2)]/60 group-open:text-[var(--color-accent2)] font-semibold transition-colors">{t.thinking}</span>
                                                    </summary>
                                                    <div className="px-3 pb-3">
                                                        <div className="pl-3 border-l-2 border-[var(--color-accent2)]/20 whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-muted)] italic font-mono">
                                                            {part.content}
                                                        </div>
                                                    </div>
                                                </details>
                                            );
                                        }
                                        if (!part.content.trim()) return null;
                                        return (
                                            <div key={pIdx} className={`prose ${theme === 'dark' ? 'prose-invert' : ''} prose-sm max-w-none
                                                prose-p:leading-relaxed prose-p:my-1.5
                                                prose-pre:bg-[var(--bg-0)] prose-pre:rounded-lg prose-pre:font-mono prose-pre:border-0
                                                prose-code:text-[var(--color-accent)] prose-code:text-xs prose-code:font-mono
                                                prose-a:text-[var(--color-accent2)] prose-a:no-underline hover:prose-a:underline
                                                prose-headings:text-[var(--text-primary)] prose-headings:font-semibold
                                                prose-strong:text-[var(--text-primary)]
                                                prose-table:text-xs prose-table:font-mono
                                                prose-th:text-[var(--text-secondary)]
                                                prose-li:text-[var(--text-secondary)]`}>
                                                <ReactMarkdown remarkPlugins={[remarkGfm]}
                                                    components={{
                                                        img: ({ src, alt }) => (
                                                            <img src={src} alt={alt || ''} className="max-w-full rounded-lg my-2 border border-[var(--bg-4)]" loading="lazy" />
                                                        )
                                                    }}
                                                >{part.content}</ReactMarkdown>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                ))}

                {status !== 'idle' && (
                    <div className="flex justify-start animate-in">
                        <div className="card px-4 py-2.5 flex items-center gap-3">
                            <Loader2 className="w-4 h-4 animate-spin text-[var(--color-accent)]" />
                            <span className="text-[12px] text-[var(--text-muted)]">{status === 'thinking' ? t.analyzing : t.executing}</span>
                            <button onClick={onAbort} className="tag tag-red flex items-center gap-1 hover:brightness-125 transition-all cursor-pointer">
                                <Square className="w-2 h-2 fill-current" />{t.stop}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <div className="p-3 md:p-4 bg-[var(--bg-1)] shrink-0"
                onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
                {dragging && (
                    <div className="absolute inset-0 z-40 bg-[var(--bg-0)]/80 backdrop-blur-sm flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--color-accent)]">
                        <div className="text-center">
                            <Paperclip className="w-8 h-8 text-[var(--color-accent)] mx-auto mb-2" />
                            <p className="text-[13px] text-[var(--text-secondary)]">{t.dropFiles}</p>
                        </div>
                    </div>
                )}
                {attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                        {attachments.map((att, i) => (
                            <div key={i} className="relative group flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-lg bg-[var(--bg-3)] border border-[var(--bg-4)]">
                                {att.type.startsWith('image/') ? (
                                    <img src={`data:${att.type};base64,${att.data}`} alt={att.name}
                                        className="w-8 h-8 rounded object-cover" />
                                ) : (
                                    <div className="w-8 h-8 rounded bg-[var(--bg-0)] flex items-center justify-center">
                                        <FileText className="w-4 h-4 text-[var(--text-muted)]" />
                                    </div>
                                )}
                                <div className="min-w-0">
                                    <div className="text-[11px] text-[var(--text-secondary)] truncate max-w-[100px]">{att.name}</div>
                                    <div className="text-[9px] text-[var(--text-ghost)]">{att.size > 1024 * 1024 ? `${(att.size / 1024 / 1024).toFixed(1)}MB` : `${(att.size / 1024).toFixed(0)}KB`}</div>
                                </div>
                                <button onClick={() => removeAttachment(i)}
                                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[var(--bg-4)] text-[var(--text-ghost)] hover:bg-red-500/30 hover:text-red-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all">
                                    <Trash2 className="w-2.5 h-2.5" />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <input ref={fileInputRef} type="file" multiple className="hidden"
                    accept="image/*,text/*,.md,.json,.csv,.xml,.yaml,.yml,.ts,.js,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.css,.html,.sql,.sh"
                    onChange={(e) => { if (e.target.files) processFiles(e.target.files); e.target.value = ''; }} />
                <form onSubmit={submit} className="relative flex items-end">
                    {slashMenu.open && filteredCommands.length > 0 && (
                        <div role="listbox" aria-label={t.slashCommands}
                            className="absolute bottom-full left-0 right-0 mb-1 bg-[var(--bg-2)] border border-[var(--bg-4)] rounded-xl shadow-2xl z-50 overflow-hidden">
                            <div className="px-2.5 py-1.5 text-[10px] text-[var(--text-ghost)] uppercase tracking-wider font-mono">
                                {t.slashCommands}
                            </div>
                            {filteredCommands.map((cmd, i) => (
                                <button key={cmd.name} type="button" role="option" id={`slash-opt-${cmd.name}`}
                                    aria-selected={i === slashMenu.selectedIdx}
                                    className={`w-full flex items-center gap-3 px-3 py-2 text-[12px] transition-colors ${
                                        i === slashMenu.selectedIdx ? 'bg-[var(--bg-3)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-3)]'
                                    }`}
                                    onMouseDown={(e) => { e.preventDefault(); executeCommand(cmd); }}
                                    onMouseEnter={() => setSlashMenu(prev => ({ ...prev, selectedIdx: i }))}>
                                    <span className="font-mono text-[var(--color-accent)]">/{cmd.name}</span>
                                    <span className="text-[var(--text-ghost)]">{t[cmd.descKey]}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    <span className="absolute left-3.5 bottom-3 font-mono text-[12px] text-[var(--color-accent)]/40 select-none pointer-events-none">❯</span>
                    <textarea ref={taRef} value={input}
                        onChange={(e) => {
                            const val = e.target.value;
                            setInput(val);
                            const cursorPos = e.target.selectionStart || val.length;
                            const textBeforeCursor = val.slice(0, cursorPos);
                            const slashMatch = textBeforeCursor.match(/(?:^|\s)\/([a-zA-Z]*)$/);
                            if (slashMatch) {
                                setSlashMenu({ open: true, filter: slashMatch[1], selectedIdx: 0 });
                            } else {
                                setSlashMenu(prev => prev.open ? { ...prev, open: false } : prev);
                            }
                        }}
                        onKeyDown={(e) => {
                            if (slashMenu.open && filteredCommands.length > 0) {
                                if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    setSlashMenu(prev => ({ ...prev, selectedIdx: (prev.selectedIdx + 1) % filteredCommands.length }));
                                    return;
                                }
                                if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    setSlashMenu(prev => ({ ...prev, selectedIdx: (prev.selectedIdx - 1 + filteredCommands.length) % filteredCommands.length }));
                                    return;
                                }
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    executeCommand(filteredCommands[slashMenu.selectedIdx]);
                                    return;
                                }
                                if (e.key === 'Escape') {
                                    e.preventDefault();
                                    setSlashMenu({ open: false, filter: '', selectedIdx: 0 });
                                    return;
                                }
                            }
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
                        }}
                        onBlur={() => { blurTimeoutRef.current = setTimeout(() => setSlashMenu({ open: false, filter: '', selectedIdx: 0 }), 150); }}
                        placeholder={t.placeholder} rows={1}
                        aria-expanded={slashMenu.open && filteredCommands.length > 0}
                        aria-haspopup="listbox"
                        aria-activedescendant={slashMenu.open && filteredCommands[slashMenu.selectedIdx] ? `slash-opt-${filteredCommands[slashMenu.selectedIdx].name}` : undefined}
                        className="w-full bg-[var(--bg-0)] border border-[var(--bg-4)] rounded-xl py-2.5 pl-9 pr-20 text-[13px] text-[var(--text-primary)] focus:outline-none glow-focus transition-all placeholder-[var(--text-ghost)] resize-none scrollbar-hide leading-relaxed"
                        disabled={status !== 'idle'} />
                    <div className="absolute right-2 bottom-1.5 flex items-center gap-1">
                        <button type="button" onClick={() => fileInputRef.current?.click()}
                            disabled={status !== 'idle' || attachments.length >= MAX_FILES}
                            className="p-2 rounded-lg text-[var(--text-ghost)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-3)] transition-all disabled:opacity-30"
                            title={t.attachFile}>
                            <Paperclip className="w-3.5 h-3.5" />
                        </button>
                        <button type="submit" disabled={status !== 'idle' || (!input.trim() && attachments.length === 0)}
                            className="p-2 rounded-lg bg-[var(--color-accent)] text-[var(--bg-0)] hover:brightness-110 transition-all disabled:opacity-20 disabled:bg-[var(--bg-4)]">
                            <Send className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
