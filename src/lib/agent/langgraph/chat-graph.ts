import OpenAI from 'openai';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { client, MODEL } from '@/lib/agent/llm-client';
import { BG_MGR, microCompact } from '@/lib/agent/managers';
import { executeToolCalls } from '@/lib/agent/tools';

type AgentMessage = {
    role: string;
    content?: unknown;
    tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
    tool_call_id?: string;
    name?: string;
};

type ToolHandler = (args: Record<string, unknown>) => unknown;

interface RunChatGraphParams {
    messages: AgentMessage[];
    activeTools: ChatCompletionTool[];
    toolHandlers: Record<string, ToolHandler>;
    mcpToolNames: Set<string>;
    reqId: string;
    sendEvent: (event: string, data: Record<string, unknown> | OpenAI.Completions.CompletionUsage) => void;
    abortSignal: AbortSignal;
    maxLoops?: number;
}

interface ChatGraphContext extends RunChatGraphParams {
    maxLoops: number;
}

const ChatGraphState = Annotation.Root({
    loop: Annotation<number>({
        reducer: (_left, right) => right,
        default: () => 0,
    }),
    finishReason: Annotation<string | null>({
        reducer: (_left, right) => right,
        default: () => null,
    }),
    assistantMessage: Annotation<OpenAI.Chat.Completions.ChatCompletionMessage | null>({
        reducer: (_left, right) => right,
        default: () => null,
    }),
    shouldStop: Annotation<boolean>({
        reducer: (_left, right) => right,
        default: () => false,
    }),
    abortAnnounced: Annotation<boolean>({
        reducer: (_left, right) => right,
        default: () => false,
    }),
});

type ChatGraphStateType = typeof ChatGraphState.State;

type ChatGraphUpdate = Partial<ChatGraphStateType>;

function assertNotAborted(state: ChatGraphStateType, context: ChatGraphContext): ChatGraphUpdate | null {
    if (!context.abortSignal.aborted) return null;

    if (!state.abortAnnounced) {
        context.sendEvent('message', { role: 'assistant', content: '⚠️ Agent loop force-stopped by user.' });
    }

    return { shouldStop: true, abortAnnounced: true };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        if (signal.aborted) {
            resolve();
            return;
        }

        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

async function callLlmWithRetry(context: ChatGraphContext): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            return await client.chat.completions.create({
                model: MODEL,
                messages: context.messages.map(m => ({
                    role: m.role,
                    content: m.content,
                    tool_calls: m.tool_calls,
                    tool_call_id: m.tool_call_id,
                    name: m.name,
                })) as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
                tools: context.activeTools,
                max_tokens: 4000,
            }, { signal: context.abortSignal });
        } catch (e: unknown) {
            const error = e as { status?: number; code?: string };
            const isRetryable = error.status === 429 || error.status === 500 || error.status === 503 || error.code === 'ECONNRESET';
            if (!isRetryable || attempt === MAX_RETRIES - 1) throw e;

            const delay = Math.pow(2, attempt) * 1000;
            context.sendEvent('log', { msg: `LLM call failed (${error.status || error.code}), retrying in ${delay}ms...`, reqId: context.reqId });
            await delay(delay, context.abortSignal);
        }
    }

    throw new Error('LLM call failed after retries');
}

function createChatGraph(context: ChatGraphContext) {
    async function prepare(state: ChatGraphStateType): Promise<ChatGraphUpdate> {
        const aborted = assertNotAborted(state, context);
        if (aborted) return aborted;

        if (state.loop >= context.maxLoops) {
            return { shouldStop: true };
        }

        const compacted = microCompact(context.messages);
        if (compacted > 0) {
            context.sendEvent('log', { msg: `[COMPACT] Compressed ${compacted} old tool results to save context`, reqId: context.reqId, compacted });
        }

        const notifs = BG_MGR.drain();
        if (notifs.length) {
            const txt = notifs.map(n => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join('\n');
            context.messages.push({ role: 'user', content: `<background-results>\n${txt}\n</background-results>` });
            context.sendEvent('log', { msg: 'Received background notifications', reqId: context.reqId });
        }

        return {};
    }

    async function llm(state: ChatGraphStateType): Promise<ChatGraphUpdate> {
        const aborted = assertNotAborted(state, context);
        if (aborted) return aborted;

        const resp = await callLlmWithRetry(context);

        if (resp.usage) {
            context.sendEvent('telemetry', resp.usage);
        }

        const assistantMsg = resp.choices[0].message;
        context.messages.push(assistantMsg as AgentMessage);

        const displayContent = assistantMsg.content || '';
        if (displayContent) {
            context.sendEvent('message', { role: 'assistant', content: displayContent });
        }

        const finishReason = resp.choices[0].finish_reason;
        if (finishReason !== 'tool_calls') {
            const preview = displayContent ? displayContent.slice(0, 60) + (displayContent.length > 60 ? '...' : '') : '(no text output)';
            context.sendEvent('log', { msg: `Response: ${preview}`, reqId: context.reqId, responsePreview: displayContent?.slice(0, 200) || '' });
        }

        return {
            loop: state.loop + 1,
            finishReason,
            assistantMessage: assistantMsg,
            shouldStop: finishReason !== 'tool_calls',
        };
    }

    async function tools(state: ChatGraphStateType): Promise<ChatGraphUpdate> {
        context.sendEvent('state', { status: 'executing_tools' });
        await executeToolCalls(state.assistantMessage?.tool_calls, context.toolHandlers, context.mcpToolNames, context.messages, context.reqId, context.sendEvent);

        return {
            assistantMessage: null,
            finishReason: null,
        };
    }

    function routeAfterPrepare(state: ChatGraphStateType): 'llm' | typeof END {
        return state.shouldStop ? END : 'llm';
    }

    function routeAfterLlm(state: ChatGraphStateType): 'tools' | typeof END {
        if (state.shouldStop || state.finishReason !== 'tool_calls') return END;
        return 'tools';
    }

    return new StateGraph(ChatGraphState)
        .addNode('prepare', prepare)
        .addNode('llm', llm)
        .addNode('tools', tools)
        .addEdge(START, 'prepare')
        .addConditionalEdges('prepare', routeAfterPrepare)
        .addConditionalEdges('llm', routeAfterLlm)
        .addEdge('tools', 'prepare')
        .compile();
}

export async function runChatGraph(params: RunChatGraphParams): Promise<void> {
    const context = {
        ...params,
        maxLoops: params.maxLoops ?? 15,
    };

    const graph = createChatGraph(context);
    await graph.invoke({
        loop: 0,
        finishReason: null,
        assistantMessage: null,
        shouldStop: false,
        abortAnnounced: false,
    });
}
