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
     * 更新待办列表 — 全量替换
     * 规则: 最多 20 项, 最多 1 个 in_progress, 每项必须有 content 和 activeForm
     * 存储: .todos.json (原子写入)
     */
    update(items: any[]): string {
        const validated: TodoItem[] = [];
        let inProgressCount = 0;

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

        if (validated.length > 20) throw new Error('Max 20 todos');
        if (inProgressCount > 1) throw new Error('Only one in_progress allowed');

        this.items = validated;
        this._save();
        return this.render();
    }

    render(): string {
        if (!this.items.length) return 'No todos.';
        const statusMap: Record<string, string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };
        const lines = this.items.map(item => {
            const mark = statusMap[item.status] || '[?]';
            const suffix = item.status === 'in_progress' ? ` <- ${item.activeForm}` : '';
            return `${mark} ${item.content}${suffix}`;
        });
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

    private _audit(action: string, taskId: number, actor: string = 'agent', details: Record<string, unknown> = {}) {
        const entry = { ts: new Date().toISOString(), action, taskId, actor, details };
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8');
    }

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

    private _nextId(): number {
        const ObjectFiles = fs.readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json'));
        if (!ObjectFiles.length) return 1;
        const ids = ObjectFiles.map(f => parseInt(f.replace('task_', '').replace('.json', '')) || 0);
        return Math.max(...ids) + 1;
    }

    private _load(tid: string | number): any {
        const p = path.join(TASKS_DIR, `task_${tid}.json`);
        if (!fs.existsSync(p)) throw new Error(`Task ${tid} not found`);
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }

    private _save(task: any) {
        const p = path.join(TASKS_DIR, `task_${task.id}.json`);
        fs.writeFileSync(p, JSON.stringify(task, null, 2), 'utf8');
    }

    /**
     * 创建持久化任务
     * 存储: .tasks/task_{id}.json (自增 ID)
     * 附带: 写入审计日志 .tasks/audit.jsonl
     */
    create(subject: string, description: string = '', actor: string = 'agent', meta?: Record<string, unknown>): string {
        const task = {
            id: this._nextId(),
            subject,
            description,
            status: 'pending',
            owner: null,
            blockedBy: [],
            blocks: []
        };
        this._save(task);
        this._audit('create', task.id, actor, { subject, ...meta });
        return JSON.stringify(task, null, 2);
    }

    get(tid: string | number): string {
        return JSON.stringify(this._load(tid), null, 2);
    }

    /**
     * 更新任务状态或依赖关系
     * 特殊逻辑:
     *   - 设为 completed 时, 自动从其他任务的 blockedBy 中移除本任务 (解锁下游)
     *   - 设为 deleted 时, 删除文件并记录审计日志
     *   - addBlockedBy/addBlocks 与现有值合并去重
     */
    update(tid: string | number, status: string | null = null, addBlockedBy: number[] | null = null, addBlocks: number[] | null = null, actor: string = 'agent'): string {
        const task = this._load(tid);
        if (status) {
            task.status = status;
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
            if (status === 'deleted') {
                const p = path.join(TASKS_DIR, `task_${tid}.json`);
                if (fs.existsSync(p)) fs.unlinkSync(p);
                this._audit('delete', Number(tid), actor);
                return `Task ${tid} deleted`;
            }
            this._audit('update', Number(tid), actor, { status });
        }
        if (addBlockedBy) task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
        if (addBlocks) task.blocks = [...new Set([...task.blocks, ...addBlocks])];
        this._save(task);
        if (addBlockedBy || addBlocks) {
            this._audit('update', Number(tid), actor, { addBlockedBy, addBlocks });
        }
        return JSON.stringify(task, null, 2);
    }

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
     * 列出所有任务 (结构化) — 供 /api/state 返回给前端
     * 支持按 status / owner / keyword 过滤
     */
    listAllStructured(filter?: TaskFilter): Array<{ id: number; subject: string; description: string; status: string; owner: string | null; blockedBy: number[]; blocks: number[] }> {
        const files = fs.readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json')).sort();
        let tasks = files.map(file => {
            const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
            return { id: t.id, subject: t.subject, description: t.description || '', status: t.status, owner: t.owner || null, blockedBy: t.blockedBy || [], blocks: t.blocks || [] };
        });

        if (filter) {
            if (filter.status) {
                tasks = tasks.filter(t => t.status === filter.status);
            }
            if (filter.owner) {
                const ownerLower = filter.owner.toLowerCase();
                tasks = tasks.filter(t => t.owner && t.owner.toLowerCase() === ownerLower);
            }
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
    public skills: Record<string, { meta: any; body: string }> = {};

    constructor(skillsDir: string) {
        this._loadSkills(skillsDir);
    }

    private _loadSkills(skillsDir: string) {
        if (!fs.existsSync(skillsDir)) return;
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        const skillFiles = entries.filter(e => e.isDirectory())
             .map(e => path.join(skillsDir, e.name, 'SKILL.md'))
             .filter(p => fs.existsSync(p));

        for (const file of skillFiles.sort()) {
            const text = fs.readFileSync(file, 'utf8');
            const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
            let meta: any = {};
            let body = text;

            if (match) {
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

            const name = meta.name || path.basename(path.dirname(file));
            this.skills[name] = { meta, body };
        }
    }

    descriptions(): string {
        if (!Object.keys(this.skills).length) return '(no skills)';
        return Object.entries(this.skills)
            .map(([n, s]) => `  - ${n}: ${s.meta.description || '-'}`)
            .join('\n');
    }

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
}

/**
 * TeammateManager — 团队成员管理
 *
 * 存储: .team/config.json (JSON 配置文件)
 * 成员状态: working(执行中) / idle(空闲)
 *
 * 生命周期:
 *   spawn(name, role) → 注册成员 + 设为 working
 *   setStatus(name, 'idle') → 标记为空闲
 *
 * 与子 Agent 的协作流程:
 *   1. 主 Agent 调用 spawn() 注册子 Agent
 *   2. 子 Agent 通过 MessageBus 收发消息
 *   3. 任务完成后 setStatus('idle')
 */
export class TeammateManager {
    public configPath: string;

    constructor() {
        mkdirSync(TEAM_DIR);
        this.configPath = path.join(TEAM_DIR, 'config.json');
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
     * 派生/唤醒子 Agent — 注册成员并设为 working 状态
     * 若成员已存在则更新 role 并唤醒, 否则新建
     * 存储: .team/config.json
     */
    spawn(name: string, role: string) {
        const config = this._load();
        let member = config.members.find((m: any) => m.name === name);
        if (member) {
            member.status = 'working';
            member.role = role;
        } else {
            config.members.push({ name, role, status: 'working' });
        }
        this._save(config);
        return `Spawned/woke '${name}' (role: ${role})`;
    }
    
    /**
     * 更新子 Agent 状态 — 如 'working' → 'idle'
     * 静默失败: 成员不存在时不报错
     */
    setStatus(name: string, status: string) {
        const config = this._load();
        const member = config.members.find((m: any) => m.name === name);
        if (member) {
            member.status = status;
            this._save(config);
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
// Next.js 开发模式下 HMR 会重新执行模块代码, 如果直接 new XXX()
// 每次 HMR 都会创建新实例, 丢失内存状态 (如 BackgroundManager 的任务列表)
// 解决: 将实例挂在 global 对象上, HMR 时优先复用已有实例

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
