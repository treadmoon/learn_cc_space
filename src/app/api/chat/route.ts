import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { runBash, runRead, runWrite, runEdit } from '@/lib/agent/tools';
import { TASK_MGR, TODO, BG_MGR, CRON_MGR, SKILLS, ARTIFACT_MGR, microCompact } from '@/lib/agent/managers';

export const runtime = 'nodejs';

// Per-request abort management — keyed by request ID
const globalForAbort = global as unknown as { agentAbortMap: Map<string, AbortController> };
if (!globalForAbort.agentAbortMap) globalForAbort.agentAbortMap = new Map();

function createAbort(reqId: string): AbortController {
    const ctrl = new AbortController();
    globalForAbort.agentAbortMap.set(reqId, ctrl);
    return ctrl;
}
function cleanupAbort(reqId: string) {
    globalForAbort.agentAbortMap.delete(reqId);
}
export function triggerAbort(reqId?: string) {
    if (reqId) {
        globalForAbort.agentAbortMap.get(reqId)?.abort();
    } else {
        // Abort all active requests (backward compat)
        for (const ctrl of globalForAbort.agentAbortMap.values()) ctrl.abort();
    }
}

function compressMessages(msgs: any[]): string {
    const KEEP_RECENT = 4;
    if (msgs.length <= KEEP_RECENT + 1) return 'Context is already small, no compression needed.';

    const removed = msgs.splice(0, msgs.length - KEEP_RECENT);
    const toolCount = removed.filter((m: any) => m.role === 'tool').length;
    const userCount = removed.filter((m: any) => m.role === 'user').length;
    const assistantCount = removed.filter((m: any) => m.role === 'assistant').length;

    msgs.unshift({
        role: 'user',
        content: `<context-compression>\nPrevious conversation compressed. Removed ${removed.length} messages (${userCount} user, ${assistantCount} assistant, ${toolCount} tool results). Continue from the most recent context.\n</context-compression>`
    });

    return `Compressed: removed ${removed.length} old messages, kept ${KEEP_RECENT} recent.`;
}

const client = new OpenAI({
    baseURL: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_API_KEY || 'sk-none',
});
const MODEL = process.env.MODEL_ID || 'claude-3-5-sonnet-20241022';

const TOOLS = [
    { type: 'function' as const, function: { name: 'bash', description: 'Run absolute or relative path bash command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    { type: 'function' as const, function: { name: 'read_file', description: 'Read file contents.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function' as const, function: { name: 'write_file', description: 'Write file contents.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function' as const, function: { name: 'edit_file', description: 'Replace exact text in file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } } },
    { type: 'function' as const, function: { name: 'TodoWrite', description: 'Update task tracking list.', parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, activeForm: { type: 'string' } }, required: ['content', 'status', 'activeForm'] } } }, required: ['items'] } } },
    { type: 'function' as const, function: { name: 'load_skill', description: 'Load specialized knowledge by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    { type: 'function' as const, function: { name: 'compress', description: 'Manually compress conversation context. (Dummy implementation)', parameters: { type: 'object', properties: {} } } },
    { type: 'function' as const, function: { name: 'background_run', description: 'Run command in background thread.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'integer' } }, required: ['command'] } } },
    { type: 'function' as const, function: { name: 'check_background', description: 'Check background task status.', parameters: { type: 'object', properties: { task_id: { type: 'string' } } } } },
    { type: 'function' as const, function: { name: 'task_create', description: 'Create a persistent file task.', parameters: { type: 'object', properties: { subject: { type: 'string' }, description: { type: 'string' } }, required: ['subject'] } } },
    { type: 'function' as const, function: { name: 'task_get', description: 'Get task details by ID.', parameters: { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'] } } },
    { type: 'function' as const, function: { name: 'task_update', description: 'Update task status or dependencies.', parameters: { type: 'object', properties: { task_id: { type: 'integer' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'expired', 'deleted'] }, add_blocked_by: { type: 'array', items: { type: 'integer' } }, add_blocks: { type: 'array', items: { type: 'integer' } } }, required: ['task_id'] } } },
    { type: 'function' as const, function: { name: 'task_list', description: 'List all tasks.', parameters: { type: 'object', properties: {} } } },
    { type: 'function' as const, function: { name: 'cron_schedule', description: 'Schedule a background command to run periodically.', parameters: { type: 'object', properties: { name: { type: 'string' }, command: { type: 'string' }, interval_ms: { type: 'integer' } }, required: ['name', 'command', 'interval_ms'] } } },
    { type: 'function' as const, function: { name: 'cron_remove', description: 'Remove a scheduled background command.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    { type: 'function' as const, function: { name: 'artifact_save', description: 'Save a file as a task artifact to .artifacts/ directory.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path to save as artifact' }, task_id: { type: 'integer', description: 'Associated task ID (optional, saves to shared/ if omitted)' }, description: { type: 'string', description: 'Brief description of the artifact' } }, required: ['path'] } } }
];

export async function POST(req: NextRequest) {
    const { message, history = [], reqId: clientReqId } = await req.json();
    const reqId = clientReqId || crypto.randomUUID().slice(0, 8);
    const abortCtrl = createAbort(reqId);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            function sendEvent(event: string, data: any) {
                controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            }

            try {
                const toolHandlers: Record<string, Function> = {
                    bash: (kw: any) => runBash(kw.command),
                    read_file: (kw: any) => runRead(kw.path),
                    write_file: (kw: any) => runWrite(kw.path, kw.content),
                    edit_file: (kw: any) => runEdit(kw.path, kw.old_text, kw.new_text),
                    TodoWrite: (kw: any) => TODO.update(kw.items || []),
                    load_skill: (kw: any) => SKILLS.load(kw.name),
                    compress: () => compressMessages(messages),
                    background_run: (kw: any) => BG_MGR.run(kw.command, kw.timeout || 120),
                    check_background: (kw: any) => BG_MGR.check(kw.task_id),
                    task_create: (kw: any) => TASK_MGR.create(kw.subject, kw.description || ''),
                    task_get: (kw: any) => TASK_MGR.get(kw.task_id),
                    task_update: (kw: any) => TASK_MGR.update(kw.task_id, kw.status, kw.add_blocked_by, kw.add_blocks),
                    task_list: () => TASK_MGR.listAll(),
                    cron_schedule: (kw: any) => CRON_MGR.schedule(kw.name, kw.command, kw.interval_ms),
                    cron_remove: (kw: any) => CRON_MGR.remove(kw.name),
                    artifact_save: (kw: any) => ARTIFACT_MGR.save(kw.path, kw.task_id, kw.description)
                };

                // NOTE: `messages` is intentionally declared after toolHandlers.
                // The `compress` handler captures it via closure and mutates it in-place.
                const messages = [...history];
                if (message) {
                    messages.push({ role: 'user', content: message });
                }

                sendEvent('state', { status: 'thinking' });

                for (let loop = 0; loop < 15; loop++) {
                    // Check abort signal
                    if (abortCtrl.signal.aborted) {
                        sendEvent('message', { role: 'assistant', content: '⚠️ Agent loop force-stopped by user.' });
                        break;
                    }

                    microCompact(messages);

                    const notifs = BG_MGR.drain();
                    if (notifs.length) {
                        const txt = notifs.map(n => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join('\n');
                        messages.push({ role: 'user', content: `<background-results>\n${txt}\n</background-results>` });
                        sendEvent('log', 'Received background notifications');
                    }

                    const MAX_RETRIES = 3;
                    let resp: OpenAI.Chat.Completions.ChatCompletion | null = null;
                    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                        try {
                            resp = await client.chat.completions.create({
                                model: MODEL,
                                messages: messages.map(m => ({ role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name })),
                                tools: TOOLS,
                                max_tokens: 4000
                            });
                            break;
                        } catch (e: any) {
                            const isRetryable = e.status === 429 || e.status === 500 || e.status === 503 || e.code === 'ECONNRESET';
                            if (!isRetryable || attempt === MAX_RETRIES - 1) throw e;
                            const delay = Math.pow(2, attempt) * 1000;
                            sendEvent('log', `LLM call failed (${e.status || e.code}), retrying in ${delay}ms...`);
                            await new Promise(r => setTimeout(r, delay));
                        }
                    }
                    if (!resp) throw new Error('LLM call failed after retries');

                    if (resp.usage) {
                        sendEvent('telemetry', resp.usage);
                    }

                    const assistantMsg = resp.choices[0].message;
                    messages.push(assistantMsg as any);

                    const displayContent = assistantMsg.content || '';
                    if (displayContent) {
                        sendEvent('message', { role: 'assistant', content: displayContent });
                    }

                    if (resp.choices[0].finish_reason !== 'tool_calls') {
                        break;
                    }

                    sendEvent('state', { status: 'executing_tools' });

                    for (const block of assistantMsg.tool_calls || []) {
                        if (block.type === 'function') {
                            const handler = toolHandlers[block.function.name] || (() => 'Unknown tool');
                            let inputArgs: Record<string, any> = {};
                            let parseError = false;
                            try {
                                inputArgs = JSON.parse(block.function.arguments || '{}');
                            } catch (e: any) {
                                parseError = true;
                                const output = `Error: Failed to parse tool arguments: ${e.message}. Raw: ${(block.function.arguments || '').slice(0, 200)}`;
                                sendEvent('log', `[PARSE_ERROR] ${block.function.name}: ${e.message}`);
                                messages.push({
                                    role: 'tool',
                                    tool_call_id: block.id,
                                    name: block.function.name,
                                    content: output
                                });
                            }

                            if (!parseError) {
                                sendEvent('log', `Tool: ${block.function.name} ${JSON.stringify(inputArgs).slice(0, 40)}...`);
                                const output = handler(inputArgs);
                                sendEvent('log', `Result: ${String(output).slice(0, 80)}...`);

                                messages.push({
                                    role: 'tool',
                                    tool_call_id: block.id,
                                    name: block.function.name,
                                    content: String(output)
                                });
                            }
                        }
                    }
                }

                sendEvent('done', { status: 'finished', reqId });
                cleanupAbort(reqId);
                controller.close();
            } catch (err: any) {
                sendEvent('error', { message: err.message });
                console.error(err);
                cleanupAbort(reqId);
                controller.close();
            }
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
        },
    });
}
