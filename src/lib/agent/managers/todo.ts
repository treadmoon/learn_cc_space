import * as fs from 'node:fs';
import * as path from 'node:path';

const WORKDIR = process.cwd();
const TODOS_FILE = path.join(WORKDIR, '.todos.json');

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
