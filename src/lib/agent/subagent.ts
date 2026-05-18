/**
 * SubAgent 执行引擎 — 子 Agent 的独立 LLM 循环
 *
 * 提供两个核心能力:
 *   1. runAgentLoop() — 可复用的 Agent 循环 (LLM → tool_calls → 执行 → 重复)
 *   2. SubAgentRunner  — 单个子 Agent 的生命周期管理 (轮询 inbox → 执行 → 回复)
 *
 * 与主 Agent (route.ts) 的区别:
 *   - 不依赖 SSE 流 (结果通过 MessageBus 回传)
 *   - 不处理 abort 信号 (由 setStatus('idle') 终止)
 *   - 独立的 system prompt (基于角色定制)
 *   - 独立的 messages 上下文 (不与主 Agent 共享)
 */
import OpenAI from 'openai';
import { client, MODEL } from './llm-client';
import { runBash, runRead, runWrite, runEdit } from './tools';
import {
    TASK_MGR, TODO, BG_MGR, CRON_MGR, SKILLS,
    ARTIFACT_MGR, KNOWLEDGE_MGR, MCP_MGR,
    microCompact, BUS, TEAM_MGR,
} from './managers';

// ═══════════════════════════════════════════════════════════════
// 子 Agent 工具集 — 与主 Agent 相同 (不含团队协作工具, 避免递归)
// ═══════════════════════════════════════════════════════════════

/**
 * 子 Agent 可用的工具列表 — 排除 spawn_teammate / send_message 等团队工具
 * 防止子 Agent 递归创建子 Agent 或产生混乱的消息循环
 */
const SUB_AGENT_TOOLS = [
    // ── 文件系统 ──
    { type: 'function' as const, function: { name: 'bash', description: 'Run absolute or relative path bash command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    { type: 'function' as const, function: { name: 'read_file', description: 'Read file contents.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function' as const, function: { name: 'write_file', description: 'Write file contents.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function' as const, function: { name: 'edit_file', description: 'Replace exact text in file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } } },
    // ── 待办 ──
    { type: 'function' as const, function: { name: 'TodoWrite', description: 'Update task tracking list.', parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, activeForm: { type: 'string' } }, required: ['content', 'status', 'activeForm'] } } }, required: ['items'] } } },
    // ── 知识技能 ──
    { type: 'function' as const, function: { name: 'load_skill', description: 'Load specialized knowledge by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    // ── 后台任务 ──
    { type: 'function' as const, function: { name: 'background_run', description: 'Run command in background thread.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'integer' } }, required: ['command'] } } },
    { type: 'function' as const, function: { name: 'check_background', description: 'Check background task status.', parameters: { type: 'object', properties: { task_id: { type: 'string' } } } } },
    // ── 持久化任务 ──
    { type: 'function' as const, function: { name: 'task_create', description: 'Create a persistent file task.', parameters: { type: 'object', properties: { subject: { type: 'string' }, description: { type: 'string' } }, required: ['subject'] } } },
    { type: 'function' as const, function: { name: 'task_get', description: 'Get task details by ID.', parameters: { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'] } } },
    { type: 'function' as const, function: { name: 'task_update', description: 'Update task status or dependencies.', parameters: { type: 'object', properties: { task_id: { type: 'integer' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'expired', 'deleted'] }, add_blocked_by: { type: 'array', items: { type: 'integer' } }, add_blocks: { type: 'array', items: { type: 'integer' } } }, required: ['task_id'] } } },
    { type: 'function' as const, function: { name: 'task_list', description: 'List all tasks.', parameters: { type: 'object', properties: {} } } },
    // ── 定时调度 ──
    { type: 'function' as const, function: { name: 'cron_schedule', description: 'Schedule a background command to run periodically.', parameters: { type: 'object', properties: { name: { type: 'string' }, command: { type: 'string' }, interval_ms: { type: 'integer' } }, required: ['name', 'command', 'interval_ms'] } } },
    { type: 'function' as const, function: { name: 'cron_remove', description: 'Remove a scheduled background command.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    // ── 制品 ──
    { type: 'function' as const, function: { name: 'artifact_save', description: 'Save a file as a task artifact to .artifacts/ directory.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path to save as artifact' }, task_id: { type: 'integer', description: 'Associated task ID (optional, saves to shared/ if omitted)' }, description: { type: 'string', description: 'Brief description of the artifact' } }, required: ['path'] } } },
    // ── RAG 知识库 ──
    { type: 'function' as const, function: { name: 'knowledge_ingest', description: 'Ingest a file or text into the knowledge base for later retrieval.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path to ingest' }, text: { type: 'string', description: 'Direct text content to ingest' }, source: { type: 'string', description: 'Source identifier for text mode' } } } } },
    { type: 'function' as const, function: { name: 'knowledge_search', description: 'Semantic search over the knowledge base.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, top_k: { type: 'number', description: 'Number of results (default 5)' } }, required: ['query'] } } },
];

// ═══════════════════════════════════════════════════════════════
// runAgentLoop — 可复用的 Agent 循环核心
// ═══════════════════════════════════════════════════════════════

/**
 * 可复用的 Agent 循环 — LLM 调用 → 工具执行 → 结果注入, 最多 maxLoops 轮
 *
 * 与 route.ts 的主循环逻辑相同, 但:
 *   - 不依赖 SSE 流 (结果通过回调返回)
 *   - 不处理 abort 信号 (子 Agent 由 setStatus 终止)
 *   - 支持自定义 system prompt
 *
 * @param params.messages      初始消息数组 (会被原地修改)
 * @param params.systemPrompt  系统提示词 (作为第一条 system 消息注入)
 * @param params.tools         可用工具数组
 * @param params.toolHandlers  工具处理器映射
 * @param params.maxLoops      最大循环次数 (默认 10)
 * @param params.onLog         日志回调 (可选)
 * @returns 最终 messages 数组
 */
export async function runAgentLoop(params: {
    messages: any[];
    systemPrompt: string;
    tools: any[];
    toolHandlers: Record<string, Function>;
    maxLoops?: number;
    onLog?: (msg: string) => void;
}): Promise<any[]> {
    const { messages, systemPrompt, tools, toolHandlers, maxLoops = 10, onLog } = params;
    const log = onLog || (() => {});

    // 注入 system prompt 作为第一条消息
    messages.unshift({ role: 'system', content: systemPrompt });

    for (let loop = 0; loop < maxLoops; loop++) {
        // Step 1: 微压缩 — 节省 context window
        const compacted = microCompact(messages);
        if (compacted > 0) {
            log(`[COMPACT] Compressed ${compacted} old tool results`);
        }

        // Step 2: LLM API 调用 — 带指数退避重试
        const MAX_RETRIES = 3;
        let resp: OpenAI.Chat.Completions.ChatCompletion | null = null;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                resp = await client.chat.completions.create({
                    model: MODEL,
                    messages: messages.map(m => ({
                        role: m.role,
                        content: m.content,
                        tool_calls: m.tool_calls,
                        tool_call_id: m.tool_call_id,
                        name: m.name,
                    })),
                    tools,
                    max_tokens: 4000,
                });
                break;
            } catch (e: any) {
                const isRetryable = e.status === 429 || e.status === 500 || e.status === 503 || e.code === 'ECONNRESET';
                if (!isRetryable || attempt === MAX_RETRIES - 1) throw e;
                const delay = Math.pow(2, attempt) * 1000;
                log(`LLM call failed (${e.status || e.code}), retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
        if (!resp) throw new Error('LLM call failed after retries');

        // Step 3: 推入 assistant 消息
        const assistantMsg = resp.choices[0].message;
        messages.push(assistantMsg as any);

        const displayContent = assistantMsg.content || '';
        if (displayContent) {
            log(`[RESPONSE] ${displayContent.slice(0, 100)}${displayContent.length > 100 ? '...' : ''}`);
        }

        // Step 4: 判断是否继续
        if (resp.choices[0].finish_reason !== 'tool_calls') {
            log(`[DONE] Loop ${loop + 1} finished (reason: ${resp.choices[0].finish_reason})`);
            break;
        }

        // Step 5: 执行工具调用
        log(`[TOOLS] Executing ${assistantMsg.tool_calls?.length || 0} tool calls...`);
        for (const block of assistantMsg.tool_calls || []) {
            if (block.type !== 'function') continue;

            const handler = toolHandlers[block.function.name] ?? (() => 'Unknown tool');

            let inputArgs: Record<string, any> = {};
            try {
                inputArgs = JSON.parse(block.function.arguments || '{}');
            } catch (e: any) {
                const output = `Error: Failed to parse tool arguments: ${e.message}`;
                messages.push({ role: 'tool', tool_call_id: block.id, name: block.function.name, content: output });
                continue;
            }

            log(`  → ${block.function.name}(${JSON.stringify(inputArgs).slice(0, 60)})`);
            const output = await handler(inputArgs);
            log(`  ← ${String(output).slice(0, 80)}`);

            messages.push({
                role: 'tool',
                tool_call_id: block.id,
                name: block.function.name,
                content: String(output),
            });
        }
    }

    return messages;
}

// ═══════════════════════════════════════════════════════════════
// SubAgentRunner — 子 Agent 生命周期管理
// ═══════════════════════════════════════════════════════════════

/**
 * SubAgentRunner — 单个子 Agent 的执行引擎
 *
 * 生命周期:
 *   constructor(name, role) → 初始化
 *   start() → 启动后台循环 (非阻塞, 返回 Promise)
 *   stop()  → 停止循环
 *   wake()  → 唤醒轮询 (收到新消息时调用)
 *
 * 内部循环:
 *   1. 读取 inbox, 如果有消息则运行 agent loop
 *   2. 结果通过 BUS.sendInbox 发回主 Agent
 *   3. 无消息时等待 wake() 或 5s 超时后再次轮询
 *   4. 连续 60s 无消息 → 自动 setStatus('idle') 并退出
 */
export class SubAgentRunner {
    private name: string;
    private role: string;
    private running = false;
    private wakeResolve: (() => void) | null = null;

    /** 连续空闲时间阈值 (ms), 超过后自动停止 */
    private static readonly IDLE_TIMEOUT_MS = 60_000;
    /** 轮询间隔 (ms) */
    private static readonly POLL_INTERVAL_MS = 5_000;

    constructor(name: string, role: string) {
        this.name = name;
        this.role = role;
    }

    /**
     * 启动子 Agent 后台循环 — 非阻塞, 立即返回
     * 内部以 Promise 形式运行, 错误不会抛到调用方
     */
    start(): void {
        if (this.running) return;
        this.running = true;
        this._loop().catch(err => {
            console.error(`[SubAgent ${this.name}] Fatal error:`, err);
            this.running = false;
            try { TEAM_MGR.setStatus(this.name, 'idle'); } catch { /* ignore */ }
        });
    }

    /** 停止子 Agent 循环 */
    stop(): void {
        this.running = false;
        this._resolveWake(); // 唤醒等待中的轮询, 让它退出
        console.log(`[SubAgent ${this.name}] Stopped`);
    }

    /**
     * 唤醒轮询 — 当有新消息到达时调用
     * 如果循环正在等待 POLL_INTERVAL_MS, 立即唤醒它
     */
    wake(): void {
        this._resolveWake();
    }

    /**
     * 核心循环 — 轮询 inbox → 执行任务 → 回复结果
     *
     * 流程:
     *   while (running):
     *     1. 读取 inbox (破坏性读取)
     *     2. 有消息 → 构建 messages → runAgentLoop → 提取结果 → sendInbox 回复
     *     3. 无消息 → 等待 wake() 或超时
     *     4. 连续空闲超时 → 自动停止
     */
    private async _loop(): Promise<void> {
        console.log(`[SubAgent ${this.name}] Starting (role: ${this.role})`);

        let lastActiveTime = Date.now();

        while (this.running) {
            // 检查 TeammateManager 中的状态 (可能被外部 setStatus 修改)
            const members = TEAM_MGR.listAll();
            const me = members.find((m: any) => m.name === this.name);
            if (!me || me.status === 'idle') {
                console.log(`[SubAgent ${this.name}] Status is idle, exiting loop`);
                break;
            }

            // 读取 inbox (破坏性读取)
            const inbox = BUS.readInbox(this.name);

            if (inbox.length === 0) {
                // 无消息 — 检查空闲超时
                const idleTime = Date.now() - lastActiveTime;
                if (idleTime >= SubAgentRunner.IDLE_TIMEOUT_MS) {
                    console.log(`[SubAgent ${this.name}] Idle for ${Math.round(idleTime / 1000)}s, auto-stopping`);
                    TEAM_MGR.setStatus(this.name, 'idle');
                    break;
                }

                // 等待唤醒或超时
                await this._waitForWake(SubAgentRunner.POLL_INTERVAL_MS);
                continue;
            }

            // 有消息 — 执行任务
            lastActiveTime = Date.now();
            console.log(`[SubAgent ${this.name}] Received ${inbox.length} message(s)`);

            for (const msg of inbox) {
                const taskContent = msg.content || String(msg);
                console.log(`[SubAgent ${this.name}] Processing task: ${taskContent.slice(0, 80)}`);

                try {
                    // 构建初始消息
                    const messages: any[] = [
                        { role: 'user', content: taskContent },
                    ];

                    // 构建工具处理器
                    const toolHandlers = this._buildToolHandlers();

                    // 运行 Agent 循环
                    const result = await runAgentLoop({
                        messages,
                        systemPrompt: this._buildSystemPrompt(),
                        tools: SUB_AGENT_TOOLS,
                        toolHandlers,
                        maxLoops: 10,
                        onLog: (m) => console.log(`[SubAgent ${this.name}] ${m}`),
                    });

                    // 提取最终 assistant 回复
                    const lastAssistant = [...result].reverse().find(m => m.role === 'assistant' && m.content);
                    const reply = lastAssistant?.content || 'Task completed (no text output)';

                    // 通过 MessageBus 回复主 Agent
                    BUS.sendInbox(this.name, 'agent', reply);
                    console.log(`[SubAgent ${this.name}] Replied: ${reply.slice(0, 80)}...`);
                } catch (err: any) {
                    // 执行失败 — 将错误信息发回主 Agent
                    const errorMsg = `Error: ${err.message}`;
                    BUS.sendInbox(this.name, 'agent', errorMsg);
                    console.error(`[SubAgent ${this.name}] Task failed:`, err.message);
                }
            }
        }

        this.running = false;
        console.log(`[SubAgent ${this.name}] Loop ended`);
    }

    /**
     * 构建子 Agent 的 system prompt
     * 基于角色描述, 包含工作流程指引
     */
    private _buildSystemPrompt(): string {
        return `You are a sub-agent named "${this.name}" with the role: ${this.role}.

You work as part of a team under the main agent's coordination.

## Workflow
1. You receive tasks as user messages
2. You complete tasks using the available tools (bash, read_file, write_file, edit_file, etc.)
3. When done, provide a clear summary of what you accomplished
4. If you encounter errors, report them clearly

## Guidelines
- Focus on completing the assigned task efficiently
- Use tools to read, write, and execute code as needed
- Keep your final response concise but complete
- If a task requires multiple steps, work through them methodically`;
    }

    /**
     * 构建子 Agent 的工具处理器映射
     * 与 route.ts 的 createToolHandlers 相同, 但排除团队协作工具
     */
    private _buildToolHandlers(): Record<string, Function> {
        return {
            bash:       (kw: any) => runBash(kw.command),
            read_file:  (kw: any) => runRead(kw.path),
            write_file: (kw: any) => runWrite(kw.path, kw.content),
            edit_file:  (kw: any) => runEdit(kw.path, kw.old_text, kw.new_text),
            TodoWrite:  (kw: any) => TODO.update(kw.items || []),
            load_skill: (kw: any) => SKILLS.load(kw.name),
            background_run:   (kw: any) => BG_MGR.run(kw.command, kw.timeout || 120),
            check_background: (kw: any) => BG_MGR.check(kw.task_id),
            task_create: (kw: any) => TASK_MGR.create(kw.subject, kw.description || '', this.name, {}),
            task_get:    (kw: any) => TASK_MGR.get(kw.task_id),
            task_update: (kw: any) => TASK_MGR.update(kw.task_id, kw.status, kw.add_blocked_by, kw.add_blocks),
            task_list:   () => TASK_MGR.listAll(),
            cron_schedule: (kw: any) => CRON_MGR.schedule(kw.name, kw.command, kw.interval_ms),
            cron_remove:   (kw: any) => CRON_MGR.remove(kw.name),
            artifact_save: (kw: any) => ARTIFACT_MGR.save(kw.path, kw.task_id, kw.description),
            knowledge_ingest: async (kw: any) => {
                if (kw.path) return await KNOWLEDGE_MGR.ingest(kw.path);
                if (kw.text) return await KNOWLEDGE_MGR.ingestText(kw.text, kw.source || 'inline');
                return 'Error: Provide either path or text';
            },
            knowledge_search: async (kw: any) => await KNOWLEDGE_MGR.search(kw.query, kw.top_k),
        };
    }

    /**
     * 等待唤醒或超时 — 实现即时响应 + 空闲轮询
     * wake() 调用时会提前 resolve, 否则等待 timeoutMs 后自动超时
     */
    private _waitForWake(timeoutMs: number): Promise<void> {
        return new Promise(resolve => {
            this.wakeResolve = resolve;
            const timer = setTimeout(() => {
                this.wakeResolve = null;
                resolve();
            }, timeoutMs);

            // 如果被 wake() 提前唤醒, 清除定时器
            const origResolve = this.wakeResolve;
            this.wakeResolve = () => {
                clearTimeout(timer);
                this.wakeResolve = null;
                resolve();
            };
        });
    }

    /** 唤醒等待中的轮询 */
    private _resolveWake(): void {
        if (this.wakeResolve) {
            this.wakeResolve();
            this.wakeResolve = null;
        }
    }
}
