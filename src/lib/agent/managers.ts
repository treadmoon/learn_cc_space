/**
 * Agent 管理器模块 — 所有 Manager 单例的定义和注册
 *
 * 本模块是 Agent 的"基础设施层", 提供以下能力:
 *   - TodoManager:       待办列表 (会话内短期任务跟踪)
 *   - TaskManager:       持久化任务 (文件存储, 支持依赖/审计)
 *   - BackgroundManager: 后台 shell 命令执行 (异步, 通知队列)
 *   - CronManager:       定时调度 (setInterval → BG_MGR)
 *   - SkillLoader:       技能加载 (skills/ 目录下的 SKILL.md)
 *   - MessageBus:        成员间消息传递 (破坏性读取 inbox)
 *   - TeammateManager:   团队成员管理 (.team/config.json)
 *   - WorktreeManager:   Git worktree 列表
 *   - ArtifactManager:   制品归档 (.artifacts/)
 *   - SessionManager:    会话持久化 (.sessions/)
 *   - KnowledgeManager:  RAG 知识库 (.knowledge/) — 定义在 knowledge.ts
 *   - McpManager:        MCP Client (.mcp.json) — 定义在 mcp.ts
 *
 * 单例模式: 通过 globalForAgent 确保 Next.js HMR 不会重复实例化
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exec, execSync } from 'node:child_process';
import { mkdirSync } from './tools';
import { KnowledgeManager } from './knowledge';
import { McpManager } from './mcp';

const WORKDIR = process.cwd();
const TODOS_FILE = path.join(WORKDIR, '.todos.json');      // 待办列表持久化文件
const TASKS_DIR = path.join(WORKDIR, '.tasks');             // 持久化任务目录
const AUDIT_FILE = path.join(TASKS_DIR, 'audit.jsonl');     // 任务审计日志
const TEAM_DIR = path.join(WORKDIR, '.team');               // 团队协作目录
const INBOX_DIR = path.join(TEAM_DIR, 'inbox');             // 成员收件箱

/**
 * 待办项 — 会话内的短期任务跟踪单元
 * content: 任务描述
 * status: pending(待办) / in_progress(进行中, 限 1 个) / completed(已完成)
 * activeForm: 进行中时的动词描述 (如 "正在编写测试"), 前端展示用
 */
export interface TodoItem {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
}

/**
 * TodoManager — 待办列表管理
 *
 * 存储: .todos.json (全量替换, 非增量)
 * 特性:
 *   - 最多 20 项, 最多 1 个 in_progress
 *   - LLM 每次调用 TodoWrite 全量覆盖, render() 返回文本供下一轮参考
 *   - 与 TaskManager 不同: Todo 是会话级轻量跟踪, Task 是跨会话持久化
 */
export class TodoManager {
    public items: TodoItem[];

    constructor() {
        this.items = this._load();
    }

    private _load(): TodoItem[] {
        try {
            if (!fs.existsSync(TODOS_FILE)) return [];
            return JSON.parse(fs.readFileSync(TODOS_FILE, 'utf8'));
        } catch {
            return [];
        }
    }

    private _save() {
        fs.writeFileSync(TODOS_FILE, JSON.stringify(this.items, null, 2), 'utf8');
    }

    /**
     * 更新待办列表 — 全量替换 (非增量)
     *
     * LLM 每次调用 TodoWrite 时传入完整的 items 数组, 整体替换旧列表。
     * 选择全量替换而非增量更新的原因:
     *   - LLM 更擅长生成完整列表 (减少部分更新的歧义)
     *   - 简化状态机 (不需要处理 add/remove/update 单项的复杂逻辑)
     *
     * 校验规则:
     *   1. 每项必须有 content (非空) 和 activeForm (进行时的动词描述)
     *   2. status 只允许 pending / in_progress / completed
     *   3. 最多 20 项 (防止 LLM 生成过长列表浪费 context)
     *   4. 最多 1 个 in_progress (强制聚焦, 避免多任务并行混乱)
     *
     * 执行流程:
     *   遍历校验 → 全量替换 this.items → 持久化到 .todos.json → 返回渲染文本
     *
     * @param items  LLM 生成的待办数组 [{content, status, activeForm}, ...]
     * @returns      渲染后的文本 (供 LLM 下一轮参考)
     * @throws       校验失败时抛出 Error (LLM 会收到错误消息并自行修正)
     */
    update(items: any[]): string {
        const validated: TodoItem[] = [];
        let inProgressCount = 0;

        // 逐项校验: 类型转换 + 必填检查 + 枚举校验
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const content = String(item.content || '').trim();
            const status = String(item.status || 'pending').toLowerCase() as any;
            const activeForm = String(item.activeForm || '').trim();

            if (!content) throw new Error(`Item ${i}: content required`);
            if (!['pending', 'in_progress', 'completed'].includes(status)) {
                throw new Error(`Item ${i}: invalid status '${status}'`);
            }
            if (!activeForm) throw new Error(`Item ${i}: activeForm required`);
            if (status === 'in_progress') inProgressCount++;

            validated.push({ content, status, activeForm });
        }

        // 全局约束: 数量上限 + 单任务聚焦
        if (validated.length > 20) throw new Error('Max 20 todos');
        if (inProgressCount > 1) throw new Error('Only one in_progress allowed');

        // 全量替换 + 持久化 + 返回渲染文本
        this.items = validated;
        this._save();
        return this.render();
    }

    /**
     * 渲染待办列表为文本 — 供 LLM 阅读的格式化输出
     *
     * 输出格式:
     *   [x] 已完成的任务
     *   [>] 正在执行的任务 <- 正在执行的动作
     *   [ ] 待办任务
     *
     *   (2/5 completed)
     *
     * 状态标记:
     *   [x] completed — 已完成
     *   [>] in_progress — 进行中 (附加 activeForm 描述)
     *   [ ] pending — 待办
     *   [?] unknown — 未知状态 (防御性 fallback)
     *
     * 末尾追加进度统计: (已完成数/总数 completed)
     *
     * @returns 格式化的待办文本
     */
    render(): string {
        if (!this.items.length) return 'No todos.';

        // 状态 → 标记符号映射
        const statusMap: Record<string, string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };

        const lines = this.items.map(item => {
            const mark = statusMap[item.status] || '[?]';
            // in_progress 项附加 activeForm, 告诉 LLM 当前正在做什么
            const suffix = item.status === 'in_progress' ? ` <- ${item.activeForm}` : '';
            return `${mark} ${item.content}${suffix}`;
        });

        // 追加进度统计
        const done = this.items.filter((t: TodoItem) => t.status === 'completed').length;
        lines.push(`\n(${done}/${this.items.length} completed)`);

        return lines.join('\n');
    }

    hasOpenItems(): boolean {
        return this.items.some((item: TodoItem) => item.status !== 'completed');
    }
}

/**
 * 任务过滤器 — 供 listAllStructured() 和 /api/state 使用
 * status: 按状态过滤 (pending/in_progress/completed/deleted)
 * owner:  按负责人过滤 (子 Agent 名称)
 * keyword: 按主题/描述关键词搜索
 */
export interface TaskFilter {
    status?: string;
    owner?: string;
    keyword?: string;
}

/**
 * TaskManager — 持久化任务管理
 *
 * 存储: .tasks/task_{id}.json (每个任务独立文件, 自增 ID)
 * 审计: .tasks/audit.jsonl (追加写入, 记录 create/update/delete/claim)
 *
 * 与 TodoManager 的区别:
 *   - Todo: 会话级, 内存 + .todos.json, LLM 全量覆盖
 *   - Task: 跨会话, 文件系统持久化, 支持依赖关系和审计日志
 *
 * 依赖关系:
 *   - blockedBy: 本任务被哪些任务阻塞 (上游未完成则不能开始)
 *   - blocks:    本任务阻塞了哪些任务 (下游等待本任务完成)
 *   - completed 时自动从其他任务的 blockedBy 中移除 (解锁下游)
 */
export class TaskManager {
    constructor() {
        mkdirSync(TASKS_DIR);
    }

    /* ── 内部方法 ── */

    /**
     * 写入审计日志 — 追加到 .tasks/audit.jsonl
     * 每行一个 JSON: { ts, action, taskId, actor, details }
     * action 类型: create / update / delete / claim
     * actor: 操作者 (默认 'agent', 也可能是子 Agent 名称)
     */
    private _audit(action: string, taskId: number, actor: string = 'agent', details: Record<string, unknown> = {}) {
        const entry = { ts: new Date().toISOString(), action, taskId, actor, details };
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8');
    }

    /**
     * 读取审计日志 — 支持按 taskId 过滤
     * 返回最近 limit 条记录 (倒序, 最新的在前)
     * 供 /api/state 返回给前端 RightPanel 展示
     */
    getAuditLog(taskId?: number, limit: number = 50): Array<{ ts: string; action: string; taskId: number; actor: string; details: Record<string, unknown> }> {
        try {
            if (!fs.existsSync(AUDIT_FILE)) return [];
            const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(l => l);
            let entries = lines.map(l => JSON.parse(l));
            if (taskId !== undefined) {
                entries = entries.filter((e: { taskId: number }) => e.taskId === taskId);
            }
            return entries.slice(-limit).reverse();
        } catch {
            return [];
        }
    }

    /**
     * 生成下一个任务 ID — 扫描 .tasks/ 目录中已有文件取最大值 +1
     * 策略: 文件名即 ID (task_1.json, task_2.json, ...), 无需额外的计数器文件
     * 首个任务返回 1
     */
    private _nextId(): number {
        const ObjectFiles = fs.readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json'));
        if (!ObjectFiles.length) return 1;
        const ids = ObjectFiles.map(f => parseInt(f.replace('task_', '').replace('.json', '')) || 0);
        return Math.max(...ids) + 1;
    }

    /**
     * 从文件加载任务 — 读取 .tasks/task_{tid}.json
     * @throws Task 不存在时抛出 Error
     */
    private _load(tid: string | number): any {
        const p = path.join(TASKS_DIR, `task_${tid}.json`);
        if (!fs.existsSync(p)) throw new Error(`Task ${tid} not found`);
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }

    /**
     * 保存任务到文件 — 写入 .tasks/task_{id}.json
     * 全量覆盖 (非增量更新)
     */
    private _save(task: any) {
        const p = path.join(TASKS_DIR, `task_${task.id}.json`);
        fs.writeFileSync(p, JSON.stringify(task, null, 2), 'utf8');
    }

    /* ── 公开 API ── */

    /**
     * 创建持久化任务
     *
     * 流程:
     *   1. _nextId() 生成自增 ID
     *   2. 构造任务对象 (status=pending, owner=null, blockedBy=[], blocks=[])
     *   3. _save() 写入 .tasks/task_{id}.json
     *   4. _audit() 记录 create 审计日志
     *   5. 返回 JSON 字符串 (供 LLM 阅读)
     *
     * @param subject     任务主题 (必填, 简短描述)
     * @param description 任务详情 (可选)
     * @param actor       操作者 (默认 'agent', 子 Agent 时为子 Agent 名称)
     * @param meta        附加元信息 (写入审计日志, 如 reqId)
     * @returns           任务 JSON 字符串
     */
    create(subject: string, description: string = '', actor: string = 'agent', meta?: Record<string, unknown>): string {
        const task = {
            id: this._nextId(),
            subject,
            description,
            status: 'pending',
            owner: null,        // 未分配, 等待 claim()
            blockedBy: [],      // 上游依赖 (这些任务完成后才能开始)
            blocks: []          // 下游依赖 (本任务完成后解锁这些任务)
        };
        this._save(task);
        this._audit('create', task.id, actor, { subject, ...meta });
        return JSON.stringify(task, null, 2);
    }

    /**
     * 获取单个任务详情 — 返回 JSON 字符串
     * @throws Task 不存在时抛出 Error (LLM 会收到错误消息)
     */
    get(tid: string | number): string {
        return JSON.stringify(this._load(tid), null, 2);
    }

    /**
     * 更新任务状态或依赖关系 — TaskManager 最复杂的方法
     *
     * 可更新内容:
     *   - status: pending → in_progress → completed / deleted
     *   - addBlockedBy: 添加上游依赖 (本任务被谁阻塞)
     *   - addBlocks: 添加下游依赖 (本任务阻塞了谁)
     *
     * 特殊逻辑:
     *
     *   completed 时 — 解锁下游:
     *     遍历所有任务, 将本任务从其他任务的 blockedBy 中移除
     *     例: 任务 A blockedBy: [B], B 完成后 → A blockedBy: [] (可开始)
     *
     *   deleted 时 — 物理删除:
     *     删除 .tasks/task_{tid}.json 文件, 不再出现在 listAll 中
     *     但审计日志保留 (可追溯)
     *
     *   addBlockedBy / addBlocks — 合并去重:
     *     与现有值合并, Set 去重, 不会重复添加
     *
     * @param tid          任务 ID
     * @param status       新状态 (null 则不更新)
     * @param addBlockedBy 要添加的上游依赖 ID 数组
     * @param addBlocks    要添加的下游依赖 ID 数组
     * @param actor        操作者
     * @returns            更新后的任务 JSON 字符串
     */
    update(tid: string | number, status: string | null = null, addBlockedBy: number[] | null = null, addBlocks: number[] | null = null, actor: string = 'agent'): string {
        const task = this._load(tid);

        if (status) {
            task.status = status;

            // completed → 解锁下游: 从所有任务的 blockedBy 中移除本任务
            if (status === 'completed') {
                const files = fs.readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json'));
                for (const file of files) {
                    const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
                    if (t.blockedBy && t.blockedBy.includes(Number(tid))) {
                        t.blockedBy = t.blockedBy.filter((id: number) => id !== Number(tid));
                        this._save(t);
                    }
                }
            }

            // deleted → 物理删除文件 (审计日志保留)
            if (status === 'deleted') {
                const p = path.join(TASKS_DIR, `task_${tid}.json`);
                if (fs.existsSync(p)) fs.unlinkSync(p);
                this._audit('delete', Number(tid), actor);
                return `Task ${tid} deleted`;
            }

            this._audit('update', Number(tid), actor, { status });
        }

        // 依赖关系: 合并去重
        if (addBlockedBy) task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
        if (addBlocks) task.blocks = [...new Set([...task.blocks, ...addBlocks])];

        this._save(task);

        if (addBlockedBy || addBlocks) {
            this._audit('update', Number(tid), actor, { addBlockedBy, addBlocks });
        }

        return JSON.stringify(task, null, 2);
    }

    /**
     * 列出所有任务 — 文本格式, 供 LLM 阅读
     *
     * 输出格式:
     *   [ ] #1: 任务主题
     *   [>] #2: 任务主题 @ws-engineer (blocked by: [1])
     *   [x] #3: 任务主题
     *   [!] #4: 过期任务
     *
     * 状态标记:
     *   [ ] pending — 待办
     *   [>] in_progress — 进行中
     *   [x] completed — 已完成
     *   [!] expired — 已过期
     *   [?] unknown — 未知状态
     *
     * @returns 格式化的任务列表文本
     */
    listAll(): string {
        const files = fs.readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json')).sort();
        if (!files.length) return 'No tasks.';
        const statusMap: Record<string, string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]', expired: '[!]' };
        const lines = files.map(file => {
            const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
            const mark = statusMap[t.status] || '[?]';
            const owner = t.owner ? ` @${t.owner}` : '';
            const blocked = t.blockedBy && t.blockedBy.length ? ` (blocked by: ${t.blockedBy})` : '';
            return `${mark} #${t.id}: ${t.subject}${owner}${blocked}`;
        });
        return lines.join('\n');
    }

    /**
     * 列出所有任务 — 结构化数据, 供 /api/state 返回给前端
     *
     * 与 listAll() 的区别:
     *   - listAll(): 返回文本字符串, 供 LLM 阅读
     *   - listAllStructured(): 返回结构化数组, 供前端 React 组件渲染
     *
     * 支持过滤:
     *   - status: 精确匹配 (如 'pending')
     *   - owner: 大小写不敏感匹配 (如 'ws-engineer')
     *   - keyword: 在 subject + description 中模糊搜索
     */
    listAllStructured(filter?: TaskFilter): Array<{ id: number; subject: string; description: string; status: string; owner: string | null; blockedBy: number[]; blocks: number[] }> {
        const files = fs.readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json')).sort();
        let tasks = files.map(file => {
            const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
            return { id: t.id, subject: t.subject, description: t.description || '', status: t.status, owner: t.owner || null, blockedBy: t.blockedBy || [], blocks: t.blocks || [] };
        });

        if (filter) {
            // 按状态精确匹配
            if (filter.status) {
                tasks = tasks.filter(t => t.status === filter.status);
            }
            // 按负责人大小写不敏感匹配
            if (filter.owner) {
                const ownerLower = filter.owner.toLowerCase();
                tasks = tasks.filter(t => t.owner && t.owner.toLowerCase() === ownerLower);
            }
            // 按关键词模糊搜索 (subject + description)
            if (filter.keyword) {
                const kw = filter.keyword.toLowerCase();
                tasks = tasks.filter(t =>
                    t.subject.toLowerCase().includes(kw) ||
                    t.description.toLowerCase().includes(kw)
                );
            }
        }

        return tasks;
    }

    /**
     * 认领任务 — 将任务分配给指定成员并设为 in_progress
     *
     * 典型场景:
     *   主 Agent 创建任务后, 调用 claim() 分配给子 Agent
     *   或子 Agent 完成任务后, 主 Agent claim() 下一个任务
     *
     * 流程:
     *   1. 加载任务
     *   2. 设置 owner + status = in_progress
     *   3. 保存 + 审计
     *
     * @param tid    任务 ID
     * @param owner  认领者名称 (如 'ws-engineer')
     * @param actor  操作者
     * @returns      确认消息
     */
    claim(tid: string | number, owner: string, actor: string = 'agent'): string {
        const task = this._load(tid);
        task.owner = owner;
        task.status = 'in_progress';
        this._save(task);
        this._audit('claim', Number(tid), actor, { owner });
        return `Claimed task #${tid} for ${owner}`;
    }
}

/**
 * BackgroundManager — 后台任务执行器
 *
 * 核心机制:
 *   - run() 通过 child_process.exec 异步执行 shell 命令, 不阻塞 Agent 循环
 *   - 完成后将结果 push 到 notifications 队列
 *   - drain() 一次性取出所有通知后清空 (一次性消费语义)
 *
 * 双消费者模型:
 *   消费者 1: Agent 循环 (route.ts) — 注入为 <background-results> 合成消息
 *   消费者 2: State API (state/route.ts) — 作为 bgNotifs 返回给前端
 *
 * 并发控制: 最多 5 个同时运行的后台任务
 * 超时: 默认 120 秒, 超时后状态标记为 'timeout'
 */
export class BackgroundManager {
    public tasks: Record<string, any>;        // 所有任务 { tid → { status, command, result } }
    public notifications: any[];              // 完成通知队列, 等待 drain() 消费
    private maxConcurrent = 5;                // 最大并发数

    constructor() {
        this.tasks = {};
        this.notifications = [];
    }

    /**
     * 后台执行 shell 命令 — 非阻塞, 通过 child_process.exec 异步运行
     * 流程: 并发检查 → 生成 8 位 UUID → 启动子进程 → 完成后推送通知
     * 状态: running → completed / error / timeout
     * 通知: 完成后 push 到 notifications 队列, 等待 drain() 消费
     */
    run(command: string, timeout: number = 120): string {
        const running = Object.values(this.tasks).filter(t => t.status === 'running').length;
        if (running >= this.maxConcurrent) {
            return `Error: Max concurrent background tasks (${this.maxConcurrent}) reached. Wait for existing tasks to finish.`;
        }

        const tid = randomUUID().slice(0, 8);
        this.tasks[tid] = { status: 'running', command, result: null };

        exec(command, { cwd: WORKDIR, timeout: timeout * 1000, shell: '/bin/sh' }, (error, stdout, stderr) => {
            const outStr = String(stdout || '').trim();
            const errStr = String(stderr || '').trim();
            const result = (outStr + (errStr ? '\n' + errStr : '')).trim().slice(0, 50000);
            
            if (error) {
                this.tasks[tid].status = error.killed ? 'timeout' : 'error';
                this.tasks[tid].result = result || error.message;
            } else {
                this.tasks[tid].status = 'completed';
                this.tasks[tid].result = result || '(no output)';
            }
            this.notifications.push({
                task_id: tid,
                status: this.tasks[tid].status,
                result: String(this.tasks[tid].result).slice(0, 500)
            });
        });

        return `Background task ${tid} started: ${command.slice(0, 80)}`;
    }

    check(tid: string | null = null): string {
        if (tid) {
            const t = this.tasks[tid];
            return t ? `[${t.status}] ${t.result || '(running)'}` : `Unknown: ${tid}`;
        }
        const lines = Object.entries(this.tasks)
            .map(([k, v]) => `${k}: [${v.status}] ${v.command.slice(0, 60)}`)
            .join('\n');
        return lines || 'No bg tasks.';
    }

    /**
     * 消费通知队列 — 一次性取出所有待处理通知后清空
     * 两个消费者:
     *   1. Agent 循环 (route.ts:L149) — 注入为 <background-results> 合成消息
     *   2. State API (state/route.ts:L46) — 作为 bgNotifs 返回给前端
     */
    drain(): any[] {
        const notifs = [...this.notifications];
        this.notifications = [];
        return notifs;
    }

    listActive(): any[] {
        return Object.entries(this.tasks)
            .filter(([_, t]) => t.status === 'running')
            .map(([id, t]) => ({ id, command: String(t.command).slice(0, 80), status: t.status }));
    }
}

/**
 * CronManager — 定时调度管理
 *
 * 机制: setInterval 定期触发, 内部委托 BG_MGR.run() 执行
 * 结果与普通后台任务共享同一套 drain 通知管道
 *
 * 使用场景:
 *   - 定期轮询外部服务状态
 *   - 定时执行数据同步脚本
 *   - 周期性清理临时文件
 *
 * 存储: 纯内存 (进程重启后丢失, 不持久化)
 */
export class CronManager {
    public tasks: Record<string, { id: string; command: string; intervalMs: number; timer: NodeJS.Timeout | null; lastRun: string | null; count: number }>;

    constructor() {
        this.tasks = {};
    }

    /**
     * 创建定时任务 — setInterval 定期触发
     * 内部委托 BG_MGR.run() 执行, 结果走同一套 drain 通知管道
     * 若同名任务已存在, 先清除旧 timer 再创建新的
     */
    schedule(name: string, command: string, intervalMs: number): string {
        if (this.tasks[name] && this.tasks[name].timer) {
            clearInterval(this.tasks[name].timer!);
        }

        const timer = setInterval(() => {
            try {
                // Pipe directly to background task manager to leverage its stdout persistence!
                globalForAgent.BG_MGR.run(command, 120);
                if (this.tasks[name]) {
                    this.tasks[name].lastRun = new Date().toISOString();
                    this.tasks[name].count++;
                }
            } catch (e) {
                // ignore
            }
        }, intervalMs);

        this.tasks[name] = { id: name, command, intervalMs, timer, lastRun: null, count: 0 };
        return `Cron task '${name}' scheduled to run every ${intervalMs}ms.`;
    }

    remove(name: string): string {
        if (this.tasks[name]) {
            if (this.tasks[name].timer) clearInterval(this.tasks[name].timer!);
            delete this.tasks[name];
            return `Cron task '${name}' removed.`;
        }
        return `Cron task '${name}' not found.`;
    }

    listActive(): any[] {
        return Object.values(this.tasks).map(t => ({
            id: t.id,
            command: String(t.command).slice(0, 80),
            intervalMs: t.intervalMs,
            lastRun: t.lastRun,
            count: t.count
        }));
    }
}

/**
 * SkillLoader — 技能文件加载器
 *
 * 技能 (Skill) ≠ 工具 (Tool):
 *   - Tool: 可执行的函数 (如 bash, read_file), 产生副作用
 *   - Skill: Markdown 知识文档, 注入上下文供 LLM 参考, 不执行任何操作
 *
 * 存储: skills/{name}/SKILL.md (带 YAML frontmatter)
 * 格式:
 *   ---
 *   name: my-skill
 *   description: 一行描述
 *   ---
 *   技能正文 (Markdown)
 *
 * 调用: LLM 调用 load_skill(name) → 返回 <skill> 标签包裹的 Markdown 文本
 * 加载时机: 进程启动时一次性扫描 skills/ 目录, 运行时不重新加载
 */
export class SkillLoader {
    /** 已加载的技能 { 技能名 → { meta: YAML 元信息, body: Markdown 正文 } } */
    public skills: Record<string, { meta: any; body: string }> = {};

    /**
     * 构造函数 — 进程启动时一次性扫描 skills/ 目录
     * 运行时不重新加载 (技能文件是静态知识, 不会动态变化)
     */
    constructor(skillsDir: string) {
        this._loadSkills(skillsDir);
    }

    /**
     * 扫描 skills/ 目录并加载所有 SKILL.md 文件
     *
     * 目录约定:
     *   skills/
     *   ├── frontend-design/
     *   │   └── SKILL.md        ← 子目录名即技能名 (除非 YAML 中指定了 name)
     *   ├── data-pipeline/
     *   │   └── SKILL.md
     *   └── ...
     *
     * 文件格式 (YAML frontmatter + Markdown 正文):
     *   ---
     *   name: my-skill           ← 可选, 不写则用目录名
     *   description: 一行描述    ← 可选, 供 descriptions() 展示
     *   ---
     *   # 技能正文
     *   这里是 Markdown 内容...
     *
     * 解析流程:
     *   1. 列出 skillsDir 下的所有子目录
     *   2. 筛选出包含 SKILL.md 的子目录
     *   3. 逐个读取: 用正则分离 frontmatter 和 body
     *   4. 手动解析 frontmatter (逐行按冒号分割, 不依赖 YAML 库)
     *   5. 技能名优先取 meta.name, 否则用目录名
     */
    private _loadSkills(skillsDir: string) {
        // skillsDir 不存在时静默返回 (项目可能没有自定义技能)
        if (!fs.existsSync(skillsDir)) return;

        // Step 1: 列出所有子目录
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

        // Step 2: 筛选包含 SKILL.md 的子目录 → 得到文件路径数组
        const skillFiles = entries.filter(e => e.isDirectory())
             .map(e => path.join(skillsDir, e.name, 'SKILL.md'))
             .filter(p => fs.existsSync(p));

        // Step 3: 逐个解析
        for (const file of skillFiles.sort()) {
            const text = fs.readFileSync(file, 'utf8');

            // Step 4: 用正则分离 YAML frontmatter 和 Markdown 正文
            // 匹配: ---\n{frontmatter}\n---\n{body}
            const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
            let meta: any = {};
            let body = text;  // 默认: 整个文件作为 body (无 frontmatter 时)

            if (match) {
                // 手动解析 frontmatter — 逐行按首个冒号分割
                // 为什么不用 YAML 库? 减少依赖, 且 frontmatter 格式简单 (key: value)
                const frontmatter = match[1];
                for (const line of frontmatter.trim().split('\n')) {
                    const colonIdx = line.indexOf(':');
                    if (colonIdx !== -1) {
                        const key = line.slice(0, colonIdx).trim();
                        const value = line.slice(colonIdx + 1).trim();
                        meta[key] = value;
                    }
                }
                body = match[2].trim();
            }

            // Step 5: 技能名 — 优先取 YAML 中的 name, 否则用父目录名
            // 例: skills/frontend-design/SKILL.md → name = meta.name || 'frontend-design'
            const name = meta.name || path.basename(path.dirname(file));
            this.skills[name] = { meta, body };
        }
    }

    /**
     * 生成技能描述列表 — 供 LLM 查看有哪些技能可用
     *
     * 输出格式:
     *   (no skills)                           ← 无技能时
     *   或
     *   - frontend-design: 前端设计指导       ← 有技能时
     *   - data-pipeline: 数据管道设计
     *
     * 调用时机: Agent 系统提示词中可能引用, 或 LLM 调用 load_skill 前参考
     */
    descriptions(): string {
        if (!Object.keys(this.skills).length) return '(no skills)';
        return Object.entries(this.skills)
            .map(([n, s]) => `  - ${n}: ${s.meta.description || '-'}`)
            .join('\n');
    }

    /**
     * 加载指定技能 — 返回 <skill> 标签包裹的 Markdown 正文
     *
     * LLM 调用 load_skill(name) 时触发:
     *   1. 在 this.skills 中查找
     *   2. 找到 → 返回 <skill name="xxx">正文</skill>
     *   3. 未找到 → 返回错误提示 + 可用技能列表 (帮助 LLM 自行修正)
     *
     * 为什么用 <skill> 标签包裹?
     *   - 与普通对话内容区分开, LLM 能识别这是"参考资料"而非"用户消息"
     *   - 类似 XML 的结构化标签是 LLM 熟悉的格式
     *
     * @param name  技能名 (对应 YAML 中的 name 或目录名)
     * @returns     <skill> 标签包裹的正文, 或错误提示
     */
    load(name: string): string {
        const skill = this.skills[name];
        if (!skill) {
            return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(', ')}`;
        }
        return `<skill name="${name}">\n${skill.body}\n</skill>`;
    }
}

/**
 * MessageBus — 成员间消息传递
 *
 * 模型: 破坏性读取 (destructive read)
 *   - 写入: appendFile 追加到 .team/inbox/{name}.jsonl
 *   - 读取: 读取全部内容后立即清空文件
 *   - 语义: fire-and-forget, 消息被读取后即丢失
 *
 * 与传统消息队列的区别:
 *   - 无持久化保留 (读完即删)
 *   - 无重试机制
 *   - 无确认机制
 *   - 适用场景: 子 Agent 间一次性结果传递
 */
export class MessageBus {
    constructor() {
        mkdirSync(INBOX_DIR);
    }
    
    /**
     * 读取指定成员的收件箱 — 破坏性读取 (读后清空)
     * 存储: .team/inbox/{name}.jsonl (每行一个 JSON 消息)
     * 语义: fire-and-forget, 消息被读取后即丢失
     */
    readInbox(name: string): any[] {
        const inboxPath = path.join(INBOX_DIR, `${name}.jsonl`);
        if (!fs.existsSync(inboxPath)) return [];
        const content = fs.readFileSync(inboxPath, 'utf8').trim();
        if (!content) return [];
        try {
            const msgs = content.split('\n').filter(l => l).map(l => JSON.parse(l));
            fs.writeFileSync(inboxPath, '', 'utf8'); // clear
            return msgs;
        } catch { return []; }
    }

    /**
     * 向指定成员收件箱写入消息 — 追加到 .team/inbox/{name}.jsonl
     * 每行一个 JSON 对象, 格式: { from, content, timestamp }
     *
     * 与 readInbox 的破坏性读取配对使用:
     *   sendInbox('tester', 'agent', '开始测试') → 写入 tester.jsonl
     *   readInbox('tester')                       → 读取并清空 tester.jsonl
     *
     * @param to      收件人名称 (对应 .team/inbox/{to}.jsonl)
     * @param from    发件人名称
     * @param content 消息内容
     * @returns       确认消息
     */
    sendInbox(to: string, from: string, content: string): string {
        const inboxPath = path.join(INBOX_DIR, `${to}.jsonl`);
        const msg = JSON.stringify({ from, content, timestamp: new Date().toISOString() });
        fs.appendFileSync(inboxPath, msg + '\n', 'utf8');

        // 唤醒目标子 Agent — 让它立即处理新消息, 无需等待 5s 轮询
        // TEAM_MGR 在文件末尾初始化, 运行时一定已就绪
        try { TEAM_MGR.wakeRunner(to); } catch { /* 目标不是子 Agent, 忽略 */ }

        return `Message sent to '${to}'`;
    }
}

/**
 * TeammateManager — 团队成员管理 + SubAgent 生命周期
 *
 * 存储: .team/config.json (JSON 配置文件)
 * 成员状态: working(执行中) / idle(空闲)
 *
 * 生命周期:
 *   spawn(name, role) → 注册成员 + 设为 working + 启动 SubAgentRunner
 *   setStatus(name, 'idle') → 标记为空闲 + 停止 SubAgentRunner
 *   wakeRunner(name) → 唤醒子 Agent 轮询 (收到新消息时)
 *
 * 与子 Agent 的协作流程:
 *   1. 主 Agent 调用 spawn() → 注册 + 启动后台 LLM 循环
 *   2. 主 Agent 调用 send_message() → 写入 inbox + 唤醒子 Agent
 *   3. 子 Agent 收到消息 → 运行 agent loop → 结果发回主 Agent inbox
 *   4. 主 Agent 调用 read_inbox() → 读取子 Agent 的回复
 *   5. 主 Agent 调用 setStatus('idle') → 终止子 Agent 循环
 */
export class TeammateManager {
    public configPath: string;
    /** 活跃的子 Agent 运行器 — 按成员名索引 */
    private runners: Map<string, any>;  // any: 避免循环导入 SubAgentRunner 类型
    /** 最大团队成员数 — 防止无限递归创建 */
    private static readonly MAX_TEAM_SIZE = 10;

    constructor() {
        mkdirSync(TEAM_DIR);
        this.configPath = path.join(TEAM_DIR, 'config.json');
        this.runners = new Map();
        if (!fs.existsSync(this.configPath)) {
            this._save({ team_name: 'default', members: [] });
        }
    }

    _load() {
        if (fs.existsSync(this.configPath)) {
            try {
                return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            } catch (e) {
                return { team_name: 'default', members: [] };
            }
        }
        return { team_name: 'default', members: [] };
    }

    _save(data: any) {
        fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf8');
    }

    listAll(): any[] {
        const config = this._load();
        return config.members || [];
    }

    /**
     * 派生/唤醒子 Agent — 注册成员 + 启动 SubAgentRunner 后台循环
     *
     * 若成员已存在: 更新 role 并重新启动 runner
     * 若成员不存在: 新建并启动 runner
     *
     * SubAgentRunner 以非阻塞方式运行, 内部会:
     *   - 轮询 inbox (5s 间隔 + 即时唤醒)
     *   - 收到消息后运行独立的 LLM agent loop
     *   - 结果通过 MessageBus 发回主 Agent
     *   - 空闲 60s 后自动停止
     *
     * @param name 子 Agent 名称 (唯一标识)
     * @param role 角色描述 (注入 system prompt)
     */
    spawn(name: string, role: string) {
        const config = this._load();
        let member = config.members.find((m: any) => m.name === name);
        if (member) {
            member.status = 'working';
            member.role = role;
            member.type = 'subagent';
        } else {
            if (config.members.length >= TeammateManager.MAX_TEAM_SIZE) {
                return `Error: Max team size (${TeammateManager.MAX_TEAM_SIZE}) reached. Remove idle members first.`;
            }
            config.members.push({ name, role, status: 'working', type: 'subagent' });
        }
        this._save(config);

        // 停止旧 runner (如果存在)
        if (this.runners.has(name)) {
            this.runners.get(name).stop();
        }

        // 启动新 SubAgentRunner (延迟导入避免循环依赖)
        const { SubAgentRunner } = require('./subagent');
        const runner = new SubAgentRunner(name, role);
        this.runners.set(name, runner);
        runner.start();

        return `Spawned '${name}' (role: ${role}), sub-agent loop started`;
    }

    /**
     * 创建 Teammate (对等协作模式) — 注册成员 + 启动 TeammateRunner
     *
     * 与 spawn() 的区别:
     *   - spawn()        → SubAgentRunner (有限工具, 单向汇报)
     *   - createTeammate() → TeammateRunner (全量工具, 双向通信)
     *
     * TeammateRunner 拥有全部工具 (含 send_message, read_inbox, create_teammate),
     * 可以与其他 Teammate 直接通信, 不需要通过主 Agent 中转。
     *
     * @param name Teammate 名称 (唯一标识)
     * @param role 角色描述 (注入 system prompt)
     */
    createTeammate(name: string, role: string) {
        const config = this._load();
        let member = config.members.find((m: any) => m.name === name);
        if (member) {
            member.status = 'working';
            member.role = role;
            member.type = 'teammate';
        } else {
            if (config.members.length >= TeammateManager.MAX_TEAM_SIZE) {
                return `Error: Max team size (${TeammateManager.MAX_TEAM_SIZE}) reached. Remove idle members first.`;
            }
            config.members.push({ name, role, status: 'working', type: 'teammate' });
        }
        this._save(config);

        // 停止旧 runner (如果存在)
        if (this.runners.has(name)) {
            this.runners.get(name).stop();
        }

        // 启动新 TeammateRunner (延迟导入避免循环依赖)
        const { TeammateRunner } = require('./subagent');
        const runner = new TeammateRunner(name, role);
        this.runners.set(name, runner);
        runner.start();

        return `Created teammate '${name}' (role: ${role}), collaborative mode`;
    }

    /**
     * 更新子 Agent 状态 — 如 'working' → 'idle'
     * 若设为 idle, 同时停止对应的 SubAgentRunner
     * 静默失败: 成员不存在时不报错
     */
    setStatus(name: string, status: string) {
        const config = this._load();
        const member = config.members.find((m: any) => m.name === name);
        if (member) {
            member.status = status;
            this._save(config);
        }

        // 停止 SubAgentRunner
        if (status === 'idle' && this.runners.has(name)) {
            this.runners.get(name).stop();
            this.runners.delete(name);
        }
    }

    /**
     * 唤醒子 Agent — 当有新消息到达其 inbox 时调用
     * 子 Agent 的轮询会立即被唤醒, 无需等待 5s 间隔
     */
    wakeRunner(name: string) {
        if (this.runners.has(name)) {
            this.runners.get(name).wake();
        }
    }
}

/**
 * WorktreeManager — Git worktree 列表查询
 *
 * 只读操作: 执行 `git worktree list` 返回当前仓库的所有 worktree
 * 用途: 前端 RightPanel 展示当前分支/worktree 状态
 * 不管理 worktree 的创建/删除 (由 git 命令直接操作)
 */
export class WorktreeManager {
    list(): string {
        try {
            const output = execSync('git worktree list', { cwd: WORKDIR, encoding: 'utf8', stdio: 'pipe' });
            return output.trim();
        } catch (e: any) {
            return `Not a git repository, or worktree tracking unavailable.`;
        }
    }
}

const ARTIFACTS_DIR = path.join(WORKDIR, '.artifacts');

export interface ArtifactFile {
    name: string;
    createdAt: string;
    size: number;
    description: string;
}

export interface ArtifactMeta {
    taskId: number | null;
    files: ArtifactFile[];
}

/**
 * ArtifactManager — 制品归档管理
 *
 * 存储: .artifacts/
 *   .artifacts/task-{id}/     ← 关联到特定任务的制品
 *   .artifacts/shared/        ← 未关联任务的共享制品
 *   每个目录下有 _meta.json   ← 记录文件列表和元信息
 *
 * 用途: Agent 执行任务过程中产生的输出文件 (报告、代码、配置等)
 * 操作: save() 复制文件到归档目录 + 更新元信息
 */
export class ArtifactManager {
    constructor() {
        mkdirSync(ARTIFACTS_DIR);
    }

    private _dir(taskId?: number | null): string {
        const dir = taskId ? path.join(ARTIFACTS_DIR, `task-${taskId}`) : path.join(ARTIFACTS_DIR, 'shared');
        mkdirSync(dir);
        return dir;
    }

    private _metaPath(dir: string): string {
        return path.join(dir, '_meta.json');
    }

    private _loadMeta(dir: string): ArtifactMeta {
        const p = this._metaPath(dir);
        if (fs.existsSync(p)) {
            try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* ignore */ }
        }
        return { taskId: null, files: [] };
    }

    private _saveMeta(dir: string, meta: ArtifactMeta) {
        fs.writeFileSync(this._metaPath(dir), JSON.stringify(meta, null, 2), 'utf8');
    }

    save(filePath: string, taskId?: number | null, description?: string): string {
        const srcPath = path.resolve(WORKDIR, filePath);
        if (!fs.existsSync(srcPath)) return `Error: File not found: ${filePath}`;

        const dir = this._dir(taskId);
        const fileName = path.basename(filePath);
        const destPath = path.join(dir, fileName);

        fs.copyFileSync(srcPath, destPath);
        const stat = fs.statSync(destPath);

        const meta = this._loadMeta(dir);
        meta.taskId = taskId || null;
        meta.files = meta.files.filter(f => f.name !== fileName);
        meta.files.push({ name: fileName, createdAt: new Date().toISOString(), size: stat.size, description: description || '' });
        this._saveMeta(dir, meta);

        const loc = taskId ? `task-${taskId}` : 'shared';
        return `Saved ${fileName} to .artifacts/${loc}/ (${stat.size} bytes)`;
    }

    list(taskId?: number | null): ArtifactMeta[] {
        if (!fs.existsSync(ARTIFACTS_DIR)) return [];
        if (taskId !== undefined && taskId !== null) {
            const dir = path.join(ARTIFACTS_DIR, `task-${taskId}`);
            if (!fs.existsSync(dir)) return [];
            return [this._loadMeta(dir)];
        }
        const entries = fs.readdirSync(ARTIFACTS_DIR, { withFileTypes: true });
        return entries.filter(e => e.isDirectory()).map(e => this._loadMeta(path.join(ARTIFACTS_DIR, e.name)));
    }
}

const SESSIONS_DIR = path.join(WORKDIR, '.sessions');

export interface SessionData {
    id: string;
    title: string;
    messages: Array<{ role: string; content: string }>;
    createdAt: string;
    updatedAt: string;
}

export interface SessionSummary {
    id: string;
    title: string;
    messageCount: number;
    createdAt: string;
    updatedAt: string;
}

/**
 * SessionManager — 会话持久化管理
 *
 * 存储: .sessions/{uuid}.json (每个会话一个文件)
 * 数据结构:
 *   { id, title, messages: [{role, content}], createdAt, updatedAt }
 *
 * 保存时机: SSE 流收到 'done' 事件时, 客户端自动调用 PATCH /api/sessions
 * 注意: 保存的是完整 messages 数组 (含 tool 结果), 不受 compressMessages 影响
 *
 * 会话操作:
 *   create()      → 创建新会话 (UUID)
 *   list()        → 列出所有会话 (按 updatedAt 降序)
 *   get(id)       → 获取单个会话
 *   update(id, m) → 更新消息和标题
 *   delete(id)    → 删除会话
 *   getLatest()   → 获取最近的会话 (页面加载时恢复)
 */
export class SessionManager {
    constructor() {
        mkdirSync(SESSIONS_DIR);
    }

    private _path(id: string): string {
        return path.join(SESSIONS_DIR, `${id}.json`);
    }

    private _read(id: string): SessionData | null {
        const p = this._path(id);
        if (!fs.existsSync(p)) return null;
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
    }

    private _write(data: SessionData) {
        fs.writeFileSync(this._path(data.id), JSON.stringify(data, null, 2), 'utf8');
    }

    create(): SessionData {
        const now = new Date().toISOString();
        const data: SessionData = {
            id: randomUUID(),
            title: 'New Session',
            messages: [],
            createdAt: now,
            updatedAt: now,
        };
        this._write(data);
        return data;
    }

    list(): SessionSummary[] {
        if (!fs.existsSync(SESSIONS_DIR)) return [];
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
        const summaries: SessionSummary[] = [];
        for (const file of files) {
            try {
                const data: SessionData = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
                summaries.push({
                    id: data.id,
                    title: data.title,
                    messageCount: data.messages.length,
                    createdAt: data.createdAt,
                    updatedAt: data.updatedAt,
                });
            } catch { /* skip corrupt files */ }
        }
        return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    get(id: string): SessionData | null {
        return this._read(id);
    }

    update(id: string, messages: Array<{ role: string; content: string }>, title?: string): void {
        const data = this._read(id);
        if (!data) return;
        data.messages = messages;
        data.updatedAt = new Date().toISOString();
        if (title) data.title = title;
        this._write(data);
    }

    delete(id: string): boolean {
        const p = this._path(id);
        if (!fs.existsSync(p)) return false;
        fs.unlinkSync(p);
        return true;
    }

    getLatest(): SessionData | null {
        const list = this.list();
        if (!list.length) return null;
        return this._read(list[0].id);
    }
}

// ═══════════════════════════════════════════════════════════════
// 单例注册 — globalForAgent 模式确保 HMR 安全
// ═══════════════════════════════════════════════════════════════
//
// globalForAgent 是一个类型断言技巧: 把 Node.js 的 global 对象"伪装"成
// 强类型的 Manager 容器, 解决两个问题:
//
//   问题 1 — TypeScript 类型:
//     global.TODO = new TodoManager()  // ❌ TS 报错: 属性 TODO 不存在于 Global
//     globalForAgent.TODO = new TodoManager()  // ✅ 断言后类型安全
//
//   问题 2 — Next.js HMR:
//     export const TODO = new TodoManager()  // ❌ 每次 HMR 都 new, 内存状态丢失
//     export const TODO = globalForAgent.TODO || new TodoManager()  // ✅ 首次 new, 之后复用
//
//   global 对象在 Node.js 进程中始终存在且不会被 HMR 重置,
//   所以它天然适合作为跨 HMR 的单例存储
//
//   简单说: globalForAgent = HMR 安全的单例存储 + TypeScript 类型体操

const globalForAgent = global as unknown as {
    TODO: TodoManager;
    TASK_MGR: TaskManager;
    BG_MGR: BackgroundManager;
    CRON_MGR: CronManager;
    SKILLS: SkillLoader;
    BUS: MessageBus;
    TEAM_MGR: TeammateManager;
    WORKTREE_MGR: WorktreeManager;
    ARTIFACT_MGR: ArtifactManager;
    SESSION_MGR: SessionManager;
    KNOWLEDGE_MGR: KnowledgeManager;
    MCP_MGR: McpManager;
};

// 导出单例 — 全局唯一实例, 其他模块直接 import 使用
export const TODO = globalForAgent.TODO || new TodoManager();
export const TASK_MGR = globalForAgent.TASK_MGR || new TaskManager();
export const BG_MGR = globalForAgent.BG_MGR || new BackgroundManager();
export const CRON_MGR = globalForAgent.CRON_MGR || new CronManager();
export const SKILLS = globalForAgent.SKILLS || new SkillLoader(path.join(process.cwd(), 'skills'));
export const BUS = globalForAgent.BUS || new MessageBus();
export const TEAM_MGR = globalForAgent.TEAM_MGR || new TeammateManager();
export const WORKTREE_MGR = globalForAgent.WORKTREE_MGR || new WorktreeManager();
export const ARTIFACT_MGR = globalForAgent.ARTIFACT_MGR || new ArtifactManager();
export const SESSION_MGR = globalForAgent.SESSION_MGR || new SessionManager();
export const KNOWLEDGE_MGR = globalForAgent.KNOWLEDGE_MGR || new KnowledgeManager();
export const MCP_MGR = globalForAgent.MCP_MGR || new McpManager();

// 开发模式: 将实例挂回 global, 下次 HMR 时复用

if (process.env.NODE_ENV !== 'production') {
    globalForAgent.TODO = TODO;
    globalForAgent.TASK_MGR = TASK_MGR;
    globalForAgent.BG_MGR = BG_MGR;
    globalForAgent.CRON_MGR = CRON_MGR;
    globalForAgent.SKILLS = SKILLS;
    globalForAgent.BUS = BUS;
    globalForAgent.TEAM_MGR = TEAM_MGR;
    globalForAgent.WORKTREE_MGR = WORKTREE_MGR;
    globalForAgent.ARTIFACT_MGR = ARTIFACT_MGR;
    globalForAgent.SESSION_MGR = SESSION_MGR;
    globalForAgent.KNOWLEDGE_MGR = KNOWLEDGE_MGR;
    globalForAgent.MCP_MGR = MCP_MGR;
}

/**
 * 上下文微压缩 — 每轮 Agent 循环开始时执行
 * 策略: 保留最近 targetRecent 条工具结果, 旧结果替换为 [Previous: used {toolName}]
 * 特殊: read_file 结果永不压缩 (后续步骤可能依赖)
 * @returns 实际压缩的消息数
 */
export function microCompact(messages: any[], targetRecent = 3): number {
    const PRESERVE_RESULT_TOOLS = new Set(['read_file']);
    const toolResults = messages.filter(m => m.role === 'tool');
    if (toolResults.length <= targetRecent) return 0;

    const toCompress = toolResults.slice(0, -targetRecent);
    let compressed = 0;
    for (const msg of toCompress) {
        if (typeof msg.content === 'string' && msg.content.length > 100) {
            const toolName = msg.name || 'unknown';
            if (PRESERVE_RESULT_TOOLS.has(toolName)) continue;
            msg.content = `[Previous: used ${toolName}]`;
            compressed++;
        }
    }
    return compressed;
}
