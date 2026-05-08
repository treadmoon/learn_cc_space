"use client";

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Send, Loader2, Globe, Square, PanelLeftOpen, PanelRightOpen, Terminal, Sparkles, Plus, MessageSquare, ChevronDown, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { T, Lang } from './i18n';

interface Message { role: string; content: string; }
interface SessionSummary { id: string; title: string; messageCount: number; createdAt: string; updatedAt: string; }

interface Props {
    t: T; lang: Lang; onToggleLang: () => void;
    messages: Message[]; status: 'idle' | 'thinking' | 'executing_tools';
    onSend: (msg: string) => void; onAbort: () => void;
    onToggleLeft?: () => void; onToggleRight?: () => void;
    sessions: SessionSummary[];
    currentSessionId: string | null;
    onNewSession: () => void;
    onSwitchSession: (id: string) => void;
    onDeleteSession: (id: string) => void;
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

export function ChatPanel({ t, lang, onToggleLang, messages, status, onSend, onAbort, onToggleLeft, onToggleRight, sessions, currentSessionId, onNewSession, onSwitchSession, onDeleteSession }: Props) {
    const [input, setInput] = useState('');
    const scrollRef = useRef<HTMLDivElement>(null);
    const taRef = useRef<HTMLTextAreaElement>(null);
    const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
    const sessionMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, status]);
    useEffect(() => {
        if (!sessionMenuOpen) return;
        const handler = (e: MouseEvent) => {
            if (sessionMenuRef.current && !sessionMenuRef.current.contains(e.target as Node)) setSessionMenuOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [sessionMenuOpen]);
    const adjustHeight = useCallback(() => {
        const el = taRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    }, []);
    useEffect(() => { adjustHeight(); }, [input, adjustHeight]);

    const submit = (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!input.trim() || status !== 'idle') return;
        onSend(input); setInput('');
    };

    return (
        <div className="flex-1 flex flex-col panel-main rounded-2xl overflow-hidden">
            <div className="h-12 topbar-main flex items-center px-4 md:px-5 gap-2.5 shrink-0">
                {onToggleLeft && (
                    <button onClick={onToggleLeft} className="md:hidden p-1.5 rounded-lg hover:bg-[var(--bg-4)] text-[var(--text-muted)] transition-colors">
                        <PanelLeftOpen className="w-4 h-4" />
                    </button>
                )}
                <Terminal className="w-4 h-4 text-[#38BDF8]" />
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
                                className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-[#38BDF8] hover:bg-[var(--bg-3)] transition-colors border-b border-[var(--bg-4)]">
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

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 scrollbar-hide flex flex-col">
                {messages.length === 0 && (
                    <div className="flex-1 flex flex-col items-center justify-center gap-4">
                        <div className="w-16 h-16 rounded-2xl bg-[var(--bg-3)] flex items-center justify-center">
                            <Sparkles className="w-7 h-7 text-[#818CF8]/60" />
                        </div>
                        <p className="text-[14px] text-[var(--text-secondary)]">{t.welcomeLine}</p>
                        <p className="text-[11px] text-[var(--text-ghost)] font-mono">{t.welcomeSub}</p>
                    </div>
                )}

                {messages.map((m, i) => (
                    <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-in`}>
                        <div className={`max-w-[90%] md:max-w-[80%] rounded-2xl px-4 py-3 ${
                            m.role === 'user'
                                ? 'bg-[#38BDF8]/10 text-[var(--text-primary)]'
                                : 'card text-[var(--text-secondary)]'
                        }`}>
                            {m.role === 'user' ? (
                                <pre className="whitespace-pre-wrap text-[13px] leading-relaxed" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>{m.content}</pre>
                            ) : (
                                <div className="space-y-3">
                                    {parseThinkingBlocks(m.content).map((part, pIdx) => {
                                        if (part.type === 'thought') {
                                            return (
                                                <details key={pIdx} className="group rounded-lg overflow-hidden bg-[#818CF8]/[0.06]">
                                                    <summary className="cursor-pointer px-3 py-2 flex items-center gap-2 select-none hover:bg-[#818CF8]/[0.04] transition-colors">
                                                        <span className="w-2 h-2 rounded-full bg-[#818CF8]/40 group-open:bg-[#818CF8] transition-colors" />
                                                        <span className="font-mono text-[10px] tracking-wider uppercase text-[#818CF8]/60 group-open:text-[#818CF8] font-semibold transition-colors">{t.thinking}</span>
                                                    </summary>
                                                    <div className="px-3 pb-3">
                                                        <div className="pl-3 border-l-2 border-[#818CF8]/20 whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-muted)] italic font-mono">
                                                            {part.content}
                                                        </div>
                                                    </div>
                                                </details>
                                            );
                                        }
                                        if (!part.content.trim()) return null;
                                        return (
                                            <div key={pIdx} className="prose prose-invert prose-sm max-w-none
                                                prose-p:leading-relaxed prose-p:my-1.5
                                                prose-pre:bg-[var(--bg-0)] prose-pre:rounded-lg prose-pre:font-mono prose-pre:border-0
                                                prose-code:text-[#38BDF8] prose-code:text-xs prose-code:font-mono
                                                prose-a:text-[#818CF8] prose-a:no-underline hover:prose-a:underline
                                                prose-headings:text-[var(--text-primary)] prose-headings:font-semibold
                                                prose-strong:text-[var(--text-primary)]
                                                prose-table:text-xs prose-table:font-mono
                                                prose-th:text-[var(--text-secondary)]
                                                prose-li:text-[var(--text-secondary)]">
                                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.content}</ReactMarkdown>
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
                            <Loader2 className="w-4 h-4 animate-spin text-[#38BDF8]" />
                            <span className="text-[12px] text-[var(--text-muted)]">{status === 'thinking' ? t.analyzing : t.executing}</span>
                            <button onClick={onAbort} className="tag tag-red flex items-center gap-1 hover:brightness-125 transition-all cursor-pointer">
                                <Square className="w-2 h-2 fill-current" />{t.stop}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <div className="p-3 md:p-4 bg-[var(--bg-1)] shrink-0">
                <form onSubmit={submit} className="relative flex items-end">
                    <span className="absolute left-3.5 bottom-3 font-mono text-[12px] text-[#38BDF8]/40 select-none pointer-events-none">❯</span>
                    <textarea ref={taRef} value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
                        placeholder={t.placeholder} rows={1}
                        className="w-full bg-[var(--bg-0)] border border-[var(--bg-4)] rounded-xl py-2.5 pl-9 pr-11 text-[13px] text-[var(--text-primary)] focus:outline-none glow-focus transition-all placeholder-[var(--text-ghost)] resize-none scrollbar-hide leading-relaxed"
                        disabled={status !== 'idle'} />
                    <button type="submit" disabled={status !== 'idle' || !input.trim()}
                        className="absolute right-2.5 bottom-1.5 p-2 rounded-lg bg-[#38BDF8] text-[var(--bg-0)] hover:brightness-110 transition-all disabled:opacity-20 disabled:bg-[var(--bg-4)]">
                        <Send className="w-3.5 h-3.5" />
                    </button>
                </form>
            </div>
        </div>
    );
}
