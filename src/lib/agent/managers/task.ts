import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdirSync } from '../tools/fs';

const WORKDIR = process.cwd();
const TASKS_DIR = path.join(WORKDIR, '.tasks');
const AUDIT_FILE = path.join(TASKS_DIR, 'audit.jsonl');

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
