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

const globalForAgent = global as unknown as {
    BG_MGR: { run: (command: string, timeout?: number) => string };
};

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
