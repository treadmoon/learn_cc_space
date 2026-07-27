/**
 * POST /api/chat — Agent 核心对话接口
 *
 * 整体架构:
 *   客户端 POST 请求 → SSE 流式响应
 *   内部运行 Agent 循环 (最多 15 轮): LLM 调用 → 工具执行 → 结果注入 → 继续
 *   通过 SSE 实时推送状态、日志、消息、遥测数据给前端
 *
 * 数据流:
 *   用户消息 → [microCompact → drain 通知 → LLM → tool_calls → 执行] × N → done
 */
import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { TOOLS, createToolHandlers, executeToolCalls, buildUserMessage, loadMcpTools } from '@/lib/agent/tools';
import { BG_MGR, microCompact } from '@/lib/agent/managers';
import { client, MODEL } from '@/lib/agent/llm-client';
import { createAbort, cleanupAbort } from '@/lib/agent/abort';
import { runChatGraph } from '@/lib/agent/langgraph/chat-graph';

export const runtime = 'nodejs';

type ChatEngine = 'openai' | 'langgraph';
type SseData = Record<string, unknown> | OpenAI.Completions.CompletionUsage;
type ToolHandler = (args: Record<string, unknown>) => unknown;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getRetryMetadata(error: unknown): { status?: number; code?: string } {
    return error as { status?: number; code?: string };
}

function getChatEngine(input: unknown): ChatEngine {
    return input === 'langgraph' ? 'langgraph' : 'openai';
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

// ═══════════════════════════════════════════════════════════════
// POST /api/chat — 主入口
// ═══════════════════════════════════════════════════════════════

/**
 * POST 处理器 — Agent 对话的核心入口
 *
 * 请求体:
 *   { message, history, reqId, attachments }
 *   - message: 用户输入文本
 *   - history: 历史消息数组 (来自客户端)
 *   - reqId: 客户端生成的请求 ID (用于中止管理)
 *   - attachments: 附件数组 (图片/文件)
 *
 * 响应:
 *   SSE 流 (text/event-stream), 包含以下事件:
 *   - state: Agent 状态变化 (thinking / executing_tools)
 *   - log: 工具执行日志
 *   - message: Assistant 文本输出
 *   - telemetry: Token 用量统计
 *   - done: 流完成
 *   - error: 致命错误
 */
export async function POST(req: NextRequest) {
    const body = await req.json();
    const { message, history = [], reqId: clientReqId, attachments } = body;
    const engine = getChatEngine(body.engine ?? process.env.AGENT_ENGINE);
    const reqId = clientReqId || crypto.randomUUID().slice(0, 8);
    const abortCtrl = createAbort(reqId);
    req.signal.addEventListener('abort', () => abortCtrl.abort(), { once: true });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            /**
             * SSE 事件发送器 — 将事件编码为 `event: {name}\ndata: {json}\n\n` 格式推入流
             * 前端通过 EventSource 或 fetch + ReadableStream 接收
             */
            function sendEvent(event: string, data: SseData) {
                controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            }

            try {
                // ─────────────────────────────────────────────
                // 消息列表构建
                // ─────────────────────────────────────────────
                const messages = [...history];

                // 创建工具处理器 — 注入当前请求的 messages 和 reqId
                const toolHandlers = createToolHandlers(messages, reqId);

                // 处理用户输入消息和附件
                const userMsg = buildUserMessage(message, attachments);
                if (userMsg) messages.push(userMsg);

                // 通知前端: Agent 开始思考
                sendEvent('state', { status: 'thinking' });

                // 加载 MCP 工具并合并到内置工具列表
                const { activeTools, mcpToolNames } = await loadMcpTools(TOOLS, reqId, sendEvent);

                // ═════════════════════════════════════════════
                // Agent 主循环 (最多 15 轮)
                // ═════════════════════════════════════════════
                // 默认保留原手写 OpenAI loop; engine=langgraph 时使用 LangGraph 编排层。
                if (engine === 'langgraph') {
                    await runChatGraph({
                        messages,
                        activeTools,
                        toolHandlers: toolHandlers as Record<string, ToolHandler>,
                        mcpToolNames,
                        reqId,
                        sendEvent,
                        abortSignal: abortCtrl.signal,
                        maxLoops: 15,
                    });
                } else {
                    // 每轮执行:
                    //   1. 检查中止信号
                    //   2. microCompact() 压缩旧工具结果 (保留最近 3 条)
                    //   3. BG_MGR.drain() 消费后台任务完成通知
                    //   4. LLM API 调用 (带指数退避重试)
                    //   5. 若返回 tool_calls → 执行工具 → 注入结果 → 继续循环
                    //   6. 若返回纯文本 → 跳出循环, 流结束
                    for (let loop = 0; loop < 15; loop++) {
                        // 检查用户是否触发了中止
                        if (abortCtrl.signal.aborted) {
                            sendEvent('message', { role: 'assistant', content: '⚠️ Agent loop force-stopped by user.' });
                            break;
                        }

                        // Step 1: 微压缩 — 将旧工具结果替换为摘要, 节省 context window
                        const compacted = microCompact(messages);
                        if (compacted > 0) {
                            sendEvent('log', { msg: `[COMPACT] Compressed ${compacted} old tool results to save context`, reqId, compacted });
                        }

                        // Step 2: 消费后台任务通知 — 将完成的后台任务结果注入对话
                        const notifs = BG_MGR.drain();
                        if (notifs.length) {
                            const txt = notifs.map(n => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join('\n');
                            messages.push({ role: 'user', content: `<background-results>\n${txt}\n</background-results>` });
                            sendEvent('log', { msg: 'Received background notifications', reqId });
                        }

                        // Step 3: LLM API 调用 — 带指数退避重试
                        const MAX_RETRIES = 3;
                        let resp: OpenAI.Chat.Completions.ChatCompletion | null = null;
                        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                            try {
                                resp = await client.chat.completions.create({
                                    model: MODEL,
                                    messages: messages.map(m => ({ role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name })),
                                    tools: activeTools,
                                    max_tokens: 4000
                                }, { signal: abortCtrl.signal });
                                break;
                            } catch (e: unknown) {
                                const error = getRetryMetadata(e);
                                const isRetryable = error.status === 429 || error.status === 500 || error.status === 503 || error.code === 'ECONNRESET';
                                if (!isRetryable || attempt === MAX_RETRIES - 1) throw e;
                                const delay = Math.pow(2, attempt) * 1000;
                                sendEvent('log', { msg: `LLM call failed (${error.status || error.code}), retrying in ${delay}ms...`, reqId });
                                await delay(delay, abortCtrl.signal);
                            }
                        }
                        if (!resp) throw new Error('LLM call failed after retries');

                        // 发送 token 用量遥测数据
                        if (resp.usage) {
                            sendEvent('telemetry', resp.usage);
                        }

                        const assistantMsg = resp.choices[0].message;
                        messages.push(assistantMsg);

                        // 发送 assistant 文本内容给前端
                        const displayContent = assistantMsg.content || '';
                        if (displayContent) {
                            sendEvent('message', { role: 'assistant', content: displayContent });
                        }

                        // Step 4: 判断是否需要继续循环
                        if (resp.choices[0].finish_reason !== 'tool_calls') {
                            const preview = displayContent ? displayContent.slice(0, 60) + (displayContent.length > 60 ? '...' : '') : '(no text output)';
                            sendEvent('log', { msg: `Response: ${preview}`, reqId, responsePreview: displayContent?.slice(0, 200) || '' });
                            break;
                        }

                        // 通知前端: Agent 开始执行工具
                        sendEvent('state', { status: 'executing_tools' });

                        // 执行 LLM 请求的所有工具调用, 结果原地推入 messages
                        await executeToolCalls(assistantMsg.tool_calls, toolHandlers, mcpToolNames, messages, reqId, sendEvent);
                    }
                }

                // Agent 循环结束, 发送完成事件
                sendEvent('done', { status: 'finished', reqId });
                cleanupAbort(reqId);
                controller.close();
            } catch (err: unknown) {
                // 致命错误: 发送 error 事件并关闭流
                sendEvent('error', { message: getErrorMessage(err) });
                console.error(err);
                cleanupAbort(reqId);
                controller.close();
            }
        }
    });

    // 返回 SSE 流响应
    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
        },
    });
}
