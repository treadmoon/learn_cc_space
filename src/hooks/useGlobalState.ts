import { useState, useEffect, useCallback, useRef } from 'react';

export interface GlobalState {
    todos: Array<{ content: string; status: string; activeForm: string }>;
    tasksString: string;
    teammates: Array<{ name: string; role: string; status: string }>;
    worktrees: string;
    bgTasks: Array<{ id: string; command: string; status: string }>;
    cronTasks: Array<{ id: string; command: string; intervalMs: number; lastRun: string | null; count: number }>;
}

const EMPTY: GlobalState = { todos: [], tasksString: '', teammates: [], worktrees: '', bgTasks: [], cronTasks: [] };

export function useGlobalState(onBgNotifs?: (msgs: string[]) => void) {
    const [state, setState] = useState<GlobalState>(EMPTY);
    const onBgNotifsRef = useRef(onBgNotifs);

    useEffect(() => {
        onBgNotifsRef.current = onBgNotifs;
    }, [onBgNotifs]);

    useEffect(() => {
        let etag = '';
        const fetchState = async () => {
            try {
                const headers: Record<string, string> = {};
                if (etag) headers['If-None-Match'] = etag;
                const res = await fetch('/api/state', { headers });
                if (res.status === 304) return;
                const newEtag = res.headers.get('ETag');
                if (newEtag) etag = newEtag;
                const data = await res.json();
                setState({
                    todos: data.todos || [],
                    tasksString: data.tasksString || '',
                    teammates: data.teammates || [],
                    worktrees: data.worktrees || '',
                    bgTasks: data.bgTasks || [],
                    cronTasks: data.cronTasks || []
                });
                if (data.bgNotifs?.length && onBgNotifsRef.current) {
                    onBgNotifsRef.current(data.bgNotifs.map((n: { task_id: string; status: string; result: string }) => `[BACKGROUND TASK: ${n.task_id}] Status: ${n.status}\nOutput:\n${n.result}`));
                }
            } catch {}
        };
        fetchState();
        const interval = setInterval(fetchState, 2000);
        return () => clearInterval(interval);
    }, []);

    const toggleTodo = useCallback(async (idx: number, currentStatus: string) => {
        const nextStatus = currentStatus === 'completed' ? 'pending' : currentStatus === 'pending' ? 'in_progress' : 'completed';
        setState(prev => {
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

    return { state, toggleTodo };
}
