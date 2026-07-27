import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const WORKDIR = process.cwd();

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
