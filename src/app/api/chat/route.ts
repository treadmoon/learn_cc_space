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
import { runBash, runRead, runWrite, runEdit } from '@/lib/agent/tools';
import { TASK_MGR, TODO, BG_MGR, CRON_MGR, SKILLS, ARTIFACT_MGR, KNOWLEDGE_MGR, MCP_MGR, microCompact, BUS, TEAM_MGR } from '@/lib/agent/managers';
import { client, MODEL } from '@/lib/agent/llm-client';

export const runtime = 'nodejs';

// ═══════════════════════════════════════════════════════════════
// 请求中止管理
// ═══════════════════════════════════════════════════════════════

/**
 * 全局 AbortController 映射 — 按 reqId 管理每个请求的中止信号
 * 存储在 global 对象上, 避免 Next.js HMR 重建时丢失
 */
const globalForAbort = global as unknown as { agentAbortMap: Map<string, AbortController> };
if (!globalForAbort.agentAbortMap) globalForAbort.agentAbortMap = new Map();

/**
 * 创建中止控制器 — 为每个请求分配独立的 AbortController
 * @param reqId 请求唯一标识
 * @returns     AbortController 实例
 */
function createAbort(reqId: string): AbortController {
    const ctrl = new AbortController();
    globalForAbort.agentAbortMap.set(reqId, ctrl);
    return ctrl;
}

/**
 * 清理中止控制器 — 请求结束后移除映射, 防止内存泄漏
 */
function cleanupAbort(reqId: string) {
    globalForAbort.agentAbortMap.delete(reqId);
}

/**
 * 触发中止 — 供外部调用 (如用户点击"停止"按钮)
 * @param reqId 指定请求 ID; 为空时中止所有活跃请求
 */
export function triggerAbort(reqId?: string) {
    if (reqId) {
        globalForAbort.agentAbortMap.get(reqId)?.abort();
    } else {
        for (const ctrl of globalForAbort.agentAbortMap.values()) ctrl.abort();
    }
}

// ═══════════════════════════════════════════════════════════════
// 上下文压缩
// ═══════════════════════════════════════════════════════════════

/**
 * 压缩对话上下文 — 移除旧消息, 仅保留最近 KEEP_RECENT 条
 * 被 Agent 通过 compress 工具主动调用, 或在上下文接近窗口限制时触发
 *
 * 策略:
 *   1. splice 移除前 N-KEEP_RECENT 条消息
 *   2. 在头部插入一条压缩摘要消息 (role: user)
 *   3. 统计被移除的 user/assistant/tool 消息数量
 *
 * @param msgs  messages 数组 (原地修改)
 * @returns     压缩结果描述
 */
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

// ═══════════════════════════════════════════════════════════════
// LLM 客户端配置
// ═══════════════════════════════════════════════════════════════

/**
 * OpenAI SDK 客户端和 MODEL — 从 llm-client.ts 导入, 与 subagent.ts 共享
 * 支持 Anthropic Claude / 火山引擎 Ark 等第三方服务
 * baseURL 和 apiKey 从环境变量读取
 */
// client, MODEL → imported from '@/lib/agent/llm-client'

// ═══════════════════════════════════════════════════════════════
// 工具定义 (24 个)
// ═══════════════════════════════════════════════════════════════

/**
 * TOOLS 数组 — 注册给 LLM 的可调用工具列表
 * 每个工具包含: name, description, parameters (JSON Schema)
 * LLM 返回 tool_calls 时, 按 name 分派到 toolHandlers 执行
 *
 * 分类:
 *   文件系统: bash, read_file, write_file, edit_file
 *   任务管理: TodoWrite, task_create, task_get, task_update, task_list
 *   后台任务: background_run, check_background
 *   定时调度: cron_schedule, cron_remove
 *   知识技能: load_skill, knowledge_ingest, knowledge_search
 *   上下文:   compress
 *   制品:     artifact_save
 */
const TOOLS = [
    // ── 文件系统工具 ──
    { type: 'function' as const, function: { name: 'bash', description: 'Run absolute or relative path bash command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    { type: 'function' as const, function: { name: 'read_file', description: 'Read file contents.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function' as const, function: { name: 'write_file', description: 'Write file contents.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function' as const, function: { name: 'edit_file', description: 'Replace exact text in file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } } },
    // ── 待办工具 ──
    { type: 'function' as const, function: { name: 'TodoWrite', description: 'Update task tracking list.', parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, activeForm: { type: 'string' } }, required: ['content', 'status', 'activeForm'] } } }, required: ['items'] } } },
    // ── 知识技能工具 ──
    { type: 'function' as const, function: { name: 'load_skill', description: 'Load specialized knowledge by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    // ── 上下文压缩工具 ──
    { type: 'function' as const, function: { name: 'compress', description: 'Manually compress conversation context. (Dummy implementation)', parameters: { type: 'object', properties: {} } } },
    // ── 后台任务工具 ──
    { type: 'function' as const, function: { name: 'background_run', description: 'Run command in background thread.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'integer' } }, required: ['command'] } } },
    { type: 'function' as const, function: { name: 'check_background', description: 'Check background task status.', parameters: { type: 'object', properties: { task_id: { type: 'string' } } } } },
    // ── 持久化任务工具 ──
    { type: 'function' as const, function: { name: 'task_create', description: 'Create a persistent file task.', parameters: { type: 'object', properties: { subject: { type: 'string' }, description: { type: 'string' } }, required: ['subject'] } } },
    { type: 'function' as const, function: { name: 'task_get', description: 'Get task details by ID.', parameters: { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'] } } },
    { type: 'function' as const, function: { name: 'task_update', description: 'Update task status or dependencies.', parameters: { type: 'object', properties: { task_id: { type: 'integer' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'expired', 'deleted'] }, add_blocked_by: { type: 'array', items: { type: 'integer' } }, add_blocks: { type: 'array', items: { type: 'integer' } } }, required: ['task_id'] } } },
    { type: 'function' as const, function: { name: 'task_list', description: 'List all tasks.', parameters: { type: 'object', properties: {} } } },
    // ── 定时调度工具 ──
    { type: 'function' as const, function: { name: 'cron_schedule', description: 'Schedule a background command to run periodically.', parameters: { type: 'object', properties: { name: { type: 'string' }, command: { type: 'string' }, interval_ms: { type: 'integer' } }, required: ['name', 'command', 'interval_ms'] } } },
    { type: 'function' as const, function: { name: 'cron_remove', description: 'Remove a scheduled background command.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    // ── 团队协作工具 ──
    { type: 'function' as const, function: { name: 'spawn_teammate', description: 'Create or wake a sub-agent teammate with a name and role.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Unique teammate name' }, role: { type: 'string', description: 'Role description for the teammate' } }, required: ['name', 'role'] } } },
    { type: 'function' as const, function: { name: 'create_teammate', description: 'Create a collaborative teammate (peer agent with full tools and team communication).', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Unique teammate name' }, role: { type: 'string', description: 'Role description for the teammate' } }, required: ['name', 'role'] } } },
    { type: 'function' as const, function: { name: 'list_teammates', description: 'List all teammates and their current status.', parameters: { type: 'object', properties: {} } } },
    { type: 'function' as const, function: { name: 'set_teammate_status', description: 'Update a teammate\'s status (e.g. working, idle).', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Teammate name' }, status: { type: 'string', description: 'New status value' } }, required: ['name', 'status'] } } },
    { type: 'function' as const, function: { name: 'send_message', description: 'Send a message to a teammate\'s inbox.', parameters: { type: 'object', properties: { to: { type: 'string', description: 'Recipient teammate name' }, content: { type: 'string', description: 'Message content' } }, required: ['to', 'content'] } } },
    { type: 'function' as const, function: { name: 'read_inbox', description: 'Read and clear your inbox messages (destructive read).', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Teammate name whose inbox to read' } }, required: ['name'] } } },
    // ── 制品工具 ──
    { type: 'function' as const, function: { name: 'artifact_save', description: 'Save a file as a task artifact to .artifacts/ directory.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path to save as artifact' }, task_id: { type: 'integer', description: 'Associated task ID (optional, saves to shared/ if omitted)' }, description: { type: 'string', description: 'Brief description of the artifact' } }, required: ['path'] } } },
    // ── RAG 知识库工具 ──
    { type: 'function' as const, function: { name: 'knowledge_ingest', description: 'Ingest a file or text into the knowledge base for later retrieval. Supports .md, .txt, .json, .csv, .py, .ts, .js and other text formats.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path to ingest' }, text: { type: 'string', description: 'Direct text content to ingest (alternative to path)' }, source: { type: 'string', description: 'Source identifier for text mode (required when using text)' } } } } },
    { type: 'function' as const, function: { name: 'knowledge_search', description: 'Semantic search over the knowledge base. Use this to find relevant information before answering questions.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, top_k: { type: 'number', description: 'Number of results to return (default 5)' } }, required: ['query'] } } }
];

/**
 * 构建用户消息 — 将文本和附件转换为 LLM 可理解的多模态消息格式
 * 图片 → base64 data URL, 文本文件 → 解码截断注入, 其他 → 元信息占位
 * 无输入时返回 null
 */
function buildUserMessage(
    message: string | undefined,
    attachments: Array<{ type?: string; name?: string; data: string; size?: number }> | undefined
): { role: 'user'; content: any } | null {
    if (!message && !attachments?.length) return null;

    if (!attachments?.length) {
        return { role: 'user', content: message || '' };
    }

    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    if (message) parts.push({ type: 'text', text: message });

    const TEXT_FILE_RE = /\.(md|json|txt|csv|xml|yaml|yml|ts|js|tsx|jsx|py|go|rs|java|c|cpp|h|css|html|sql|sh)$/i;

    for (const att of attachments) {
        if (att.type?.startsWith('image/')) {
            parts.push({ type: 'image_url', image_url: { url: `data:${att.type};base64,${att.data}` } });
        } else if (att.type?.startsWith('text/') || att.name?.match(TEXT_FILE_RE)) {
            const textContent = Buffer.from(att.data, 'base64').toString('utf8').slice(0, 10000);
            parts.push({ type: 'text', text: `\n\n[File: ${att.name}]\n${textContent}` });
        } else {
            parts.push({ type: 'text', text: `\n\n[Attached: ${att.name} (${att.type}, ${att.size} bytes)]` });
        }
    }

    return { role: 'user', content: parts };
}

/**
 * 加载 MCP 工具 — 从 .mcp.json 配置的 MCP Server 动态获取工具列表
 *
 * 流程:
 *   1. 调用 MCP_MGR.getTools() 懒连接所有配置的 MCP Server 并获取工具列表
 *   2. 将 MCP 工具转换为 OpenAI function-calling 格式, 合并到内置 TOOLS 数组
 *   3. 构建 MCP 工具名集合 (mcpToolNames), 用于工具执行时判断是否走 MCP 路由
 *
 * 容错:
 *   - 单个 MCP Server 连接失败不影响其他 Server 和内置工具
 *   - 所有 Server 都失败时返回原始 TOOLS, Agent 正常工作
 *
 * @param builtInTools  内置工具数组 (TOOLS)
 * @param reqId         当前请求 ID, 用于日志
 * @param sendEvent     SSE 事件发送器, 用于推送加载状态
 * @returns activeTools  合并后的完整工具列表
 * @returns mcpToolNames MCP 工具名集合 (用于 handler 分发)
 */
async function loadMcpTools(
    builtInTools: typeof TOOLS,
    reqId: string,
    sendEvent: (event: string, data: any) => void
): Promise<{ activeTools: typeof TOOLS; mcpToolNames: Set<string> }> {
    let activeTools: typeof TOOLS = [...builtInTools];

    try {
        // 懒连接各 MCP Server, 并行获取工具列表 (单个失败不阻塞)
        const mcpTools = await MCP_MGR.getTools();

        if (mcpTools.length > 0) {
            // MCP 工具追加到内置工具之后, LLM 可同时看到两类工具
            activeTools = [...builtInTools, ...mcpTools] as typeof TOOLS;
            sendEvent('log', { msg: `[MCP] Loaded ${mcpTools.length} tools from MCP servers`, reqId });
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        sendEvent('log', { msg: `[MCP] Failed to load MCP tools: ${msg}`, reqId });
    }

    // 构建 MCP 工具名集合 — 通过排除内置工具名得到
    // 工具执行时用此集合判断: 命中 → 走 MCP_MGR.callTool() 路由, 未命中 → 走内置 handler
    const mcpToolNames = new Set(
        activeTools
            .filter(t => !builtInTools.some(s => s.function.name === t.function.name))
            .map(t => t.function.name)
    );

    return { activeTools, mcpToolNames };
}

/**
 * 执行 LLM 返回的所有工具调用
 *
 * 对 tool_calls 数组逐个执行:
 *   1. 查找 handler — 内置工具 → MCP 工具 → fallback
 *   2. 解析 JSON 参数 — 解析失败时注入错误消息让 LLM 自行修正
 *   3. 执行 handler (await, 支持异步工具)
 *   4. 将结果作为 role:'tool' 消息推入 messages, 供下一轮 LLM 参考
 *
 * 每个工具调用都会通过 SSE 发送日志 (调用参数 + 执行结果), 供前端 FlowGraph 可视化
 *
 * @param toolCalls    LLM 返回的 tool_calls 数组 (可能为 undefined)
 * @param toolHandlers 内置工具 handler 映射表
 * @param mcpToolNames MCP 工具名集合 (命中时走 MCP_MGR.callTool 路由)
 * @param messages     消息数组 — 执行结果原地推入
 * @param reqId        请求 ID, 用于日志
 * @param sendEvent    SSE 事件发送器
 */
async function executeToolCalls(
    toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
    toolHandlers: Record<string, Function>,
    mcpToolNames: Set<string>,
    messages: any[],
    reqId: string,
    sendEvent: (event: string, data: any) => void
): Promise<void> {
    for (const block of toolCalls || []) {
        if (block.type !== 'function') continue;

        // 查找 handler: 先查内置工具 → 再查 MCP 工具 → 最后 fallback
        const handler = toolHandlers[block.function.name] ?? (
            mcpToolNames.has(block.function.name)
                ? (kw: Record<string, unknown>) => MCP_MGR.callTool(block.function.name, kw)
                : () => 'Unknown tool'
        );

        // 解析 LLM 返回的 JSON 参数字符串
        let inputArgs: Record<string, any> = {};
        try {
            inputArgs = JSON.parse(block.function.arguments || '{}');
        } catch (e: any) {
            // 参数解析失败 — 注入错误消息, 让 LLM 知道参数格式有误并自行修正
            const output = `Error: Failed to parse tool arguments: ${e.message}. Raw: ${(block.function.arguments || '').slice(0, 200)}`;
            sendEvent('log', { msg: `[PARSE_ERROR] ${block.function.name}: ${e.message}`, reqId });
            messages.push({ role: 'tool', tool_call_id: block.id, name: block.function.name, content: output });
            continue;
        }

        // 记录工具调用日志 (前端 FlowGraph 可视化)
        sendEvent('log', { msg: `Tool: ${block.function.name} ${JSON.stringify(inputArgs).slice(0, 40)}...`, reqId, toolName: block.function.name, toolArgs: inputArgs });

        // 执行工具 (await 支持异步工具如 knowledge_ingest)
        const output = await handler(inputArgs);

        // 记录执行结果 (截断到 2000 字符避免撑爆 SSE)
        sendEvent('log', { msg: `Result: ${String(output).slice(0, 80)}...`, reqId, toolName: block.function.name, toolOutput: String(output).slice(0, 2000) });

        // 结果推入 messages, 供下一轮 LLM 调用参考
        messages.push({ role: 'tool', tool_call_id: block.id, name: block.function.name, content: String(output) });
    }
}

/**
 * 工具处理器工厂 — 创建当前请求的 handler 映射表
 * 绝大多数 handler 是纯静态的 (直接委托 Manager 单例),
 * 仅 compress 和 task_create 需要注入请求级参数:
 *   - compress: 需要 messages 引用以原地压缩上下文
 *   - task_create: 需要 reqId 写入审计日志
 */
function createToolHandlers(messages: any[], reqId: string): Record<string, Function> {
    return {
        // ── 文件系统 → tools.ts ──
        bash:       (kw: any) => runBash(kw.command),
        read_file:  (kw: any) => runRead(kw.path),
        write_file: (kw: any) => runWrite(kw.path, kw.content),
        edit_file:  (kw: any) => runEdit(kw.path, kw.old_text, kw.new_text),

        // ── 待办 ──
        TodoWrite:  (kw: any) => TODO.update(kw.items || []),

        // ── 知识技能 ──
        load_skill: (kw: any) => SKILLS.load(kw.name),

        // ── 上下文压缩 (需要 messages 引用) ──
        compress:   () => compressMessages(messages),

        // ── 后台任务 ──
        background_run:   (kw: any) => BG_MGR.run(kw.command, kw.timeout || 120),
        check_background: (kw: any) => BG_MGR.check(kw.task_id),

        // ── 持久化任务 (task_create 需要 reqId) ──
        task_create: (kw: any) => TASK_MGR.create(kw.subject, kw.description || '', 'agent', { reqId }),
        task_get:    (kw: any) => TASK_MGR.get(kw.task_id),
        task_update: (kw: any) => TASK_MGR.update(kw.task_id, kw.status, kw.add_blocked_by, kw.add_blocks),
        task_list:   () => TASK_MGR.listAll(),

        // ── 定时调度 ──
        cron_schedule: (kw: any) => CRON_MGR.schedule(kw.name, kw.command, kw.interval_ms),
        cron_remove:   (kw: any) => CRON_MGR.remove(kw.name),

        // ── 团队协作 ──
        spawn_teammate:      (kw: any) => TEAM_MGR.spawn(kw.name, kw.role),
        create_teammate:     (kw: any) => TEAM_MGR.createTeammate(kw.name, kw.role),
        list_teammates:      () => TEAM_MGR.listAll(),
        set_teammate_status: (kw: any) => { TEAM_MGR.setStatus(kw.name, kw.status); return `Status of '${kw.name}' set to '${kw.status}'`; },
        send_message:        (kw: any) => BUS.sendInbox(kw.to, 'agent', kw.content),
        read_inbox:          (kw: any) => BUS.readInbox(kw.name),

        // ── 制品 ──
        artifact_save: (kw: any) => ARTIFACT_MGR.save(kw.path, kw.task_id, kw.description),

        // ── RAG 知识库 (异步) ──
        knowledge_ingest: async (kw: any) => {
            if (kw.path) return await KNOWLEDGE_MGR.ingest(kw.path);
            if (kw.text) return await KNOWLEDGE_MGR.ingestText(kw.text, kw.source || 'inline');
            return 'Error: Provide either path or text';
        },
        knowledge_search: async (kw: any) => await KNOWLEDGE_MGR.search(kw.query, kw.top_k),
    };
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
    const { message, history = [], reqId: clientReqId, attachments } = await req.json();
    const reqId = clientReqId || crypto.randomUUID().slice(0, 8);
    const abortCtrl = createAbort(reqId);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            /**
             * SSE 事件发送器 — 将事件编码为 `event: {name}\ndata: {json}\n\n` 格式推入流
             * 前端通过 EventSource 或 fetch + ReadableStream 接收
             */
            function sendEvent(event: string, data: any) {
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
                    // 通知格式: <background-results>[bg:tid] status: result</background-results>
                    const notifs = BG_MGR.drain();
                    if (notifs.length) {
                        const txt = notifs.map(n => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join('\n');
                        messages.push({ role: 'user', content: `<background-results>\n${txt}\n</background-results>` });
                        sendEvent('log', { msg: 'Received background notifications', reqId });
                    }

                    // Step 3: LLM API 调用 — 带指数退避重试
                    // 可重试错误: 429(限流) / 500(服务器错误) / 503(服务不可用) / ECONNRESET(连接重置)
                    const MAX_RETRIES = 3;
                    let resp: OpenAI.Chat.Completions.ChatCompletion | null = null;
                    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                        try {
                            resp = await client.chat.completions.create({
                                model: MODEL,
                                messages: messages.map(m => ({ role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name })),
                                tools: activeTools,
                                max_tokens: 4000
                            });
                            break;
                        } catch (e: any) {
                            const isRetryable = e.status === 429 || e.status === 500 || e.status === 503 || e.code === 'ECONNRESET';
                            if (!isRetryable || attempt === MAX_RETRIES - 1) throw e;
                            const delay = Math.pow(2, attempt) * 1000;  // 1s → 2s → 4s
                            sendEvent('log', { msg: `LLM call failed (${e.status || e.code}), retrying in ${delay}ms...`, reqId });
                            await new Promise(r => setTimeout(r, delay));
                        }
                    }
                    if (!resp) throw new Error('LLM call failed after retries');

                    // 发送 token 用量遥测数据
                    if (resp.usage) {
                        sendEvent('telemetry', resp.usage);
                    }

                    const assistantMsg = resp.choices[0].message;
                    messages.push(assistantMsg as any);

                    // 发送 assistant 文本内容给前端 (即使有 tool_calls, 也可能伴随文本)
                    const displayContent = assistantMsg.content || '';
                    if (displayContent) {
                        sendEvent('message', { role: 'assistant', content: displayContent });
                    }

                    // Step 4: 判断是否需要继续循环
                    // finish_reason === 'tool_calls' → LLM 要求执行工具 → 继续
                    // finish_reason === 'stop' 或其他 → LLM 完成回复 → 退出
                    if (resp.choices[0].finish_reason !== 'tool_calls') {
                        if (displayContent) {
                            sendEvent('log', { msg: `Response: ${displayContent.slice(0, 60)}${displayContent.length > 60 ? '...' : ''}`, reqId, responsePreview: displayContent.slice(0, 200) });
                        }
                        break;
                    }

                    // 通知前端: Agent 开始执行工具
                    sendEvent('state', { status: 'executing_tools' });

                    // 执行 LLM 请求的所有工具调用, 结果原地推入 messages
                    await executeToolCalls(assistantMsg.tool_calls, toolHandlers, mcpToolNames, messages, reqId, sendEvent);
                }

                // Agent 循环结束, 发送完成事件
                sendEvent('done', { status: 'finished', reqId });
                cleanupAbort(reqId);
                controller.close();
            } catch (err: any) {
                // 致命错误: 发送 error 事件并关闭流
                sendEvent('error', { message: err.message });
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
