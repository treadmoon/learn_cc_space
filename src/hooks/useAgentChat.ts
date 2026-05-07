import { useState, useCallback, useRef, useEffect } from 'react';

export interface Message {
    role: 'user' | 'assistant';
    content: string;
}

export interface Telemetry {
    totalSession: number;
    lastRequest: number;
    totalRequests: number;
}

export type AgentStatus = 'idle' | 'thinking' | 'executing_tools';

export function useAgentChat() {
    const [messages, setMessages] = useState<Message[]>([]);
    const [status, setStatus] = useState<AgentStatus>('idle');
    const [logs, setLogs] = useState<string[]>([]);
    const [telemetry, setTelemetry] = useState<Telemetry>({ totalSession: 0, lastRequest: 0, totalRequests: 0 });
    const messagesRef = useRef<Message[]>([]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    const send = useCallback(async (input: string) => {
        if (!input.trim() || status !== 'idle') return;

        const userMsg: Message = { role: 'user', content: input };
        const prevMessages = [...messagesRef.current];
        setMessages(prev => [...prev, userMsg]);
        setStatus('thinking');
        setLogs(prev => [...prev, '> User prompt sent']);

        const reqId = crypto.randomUUID().slice(0, 8);

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: input, history: prevMessages, reqId })
            });
            if (!res.body) return;

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let done = false;
            let buffer = '';

            while (!done) {
                const { value, done: doneReading } = await reader.read();
                done = doneReading;
                if (value) {
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n\n');
                    buffer = lines.pop() || '';

                    for (const block of lines) {
                        const eventMatch = block.match(/event: (.*)\n/);
                        const dataMatch = block.match(/data: ([\s\S]*)/);
                        if (!eventMatch || !dataMatch) continue;

                        const event = eventMatch[1];
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        let dataObj: any;
                        try { dataObj = JSON.parse(dataMatch[1]); } catch { dataObj = dataMatch[1]; }

                        switch (event) {
                            case 'log': setLogs(prev => [...prev, dataObj]); break;
                            case 'state': setStatus(dataObj.status); break;
                            case 'message': setMessages(prev => [...prev, { role: 'assistant', content: dataObj.content }]); break;
                            case 'telemetry':
                                setTelemetry(prev => ({
                                    totalSession: prev.totalSession + (dataObj.total_tokens || 0),
                                    lastRequest: dataObj.total_tokens || 0,
                                    totalRequests: prev.totalRequests + 1
                                }));
                                break;
                            case 'done': setStatus('idle'); break;
                            case 'error':
                                setLogs(prev => [...prev, `[ERROR] ${dataObj.message}`]);
                                setStatus('idle');
                                break;
                        }
                    }
                }
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setLogs(prev => [...prev, `[NETWORK_ERROR] ${message}`]);
            setStatus('idle');
        }
    }, [status]);

    const abort = useCallback(async () => {
        setLogs(prev => [...prev, '> Abort signal sent']);
        try {
            await fetch('/api/chat/abort', { method: 'POST' });
        } catch {}
    }, []);

    const appendBgMessages = useCallback((bgMsgs: string[]) => {
        setMessages(prev => [...prev, ...bgMsgs.map(content => ({ role: 'assistant' as const, content }))]);
    }, []);

    return { messages, status, logs, telemetry, send, abort, appendBgMessages };
}
