import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { TASK_MGR, TODO, TEAM_MGR, WORKTREE_MGR, BG_MGR, CRON_MGR, ARTIFACT_MGR, KNOWLEDGE_MGR, type TaskFilter } from '@/lib/agent/managers';

export const runtime = 'nodejs';

/**
 * GET /api/state — 全局状态轮询端点
 * 每 2 秒被客户端调用, 返回 todos/tasks/teammates/bgTasks/cronTasks/artifacts/auditLog/knowledge
 * 使用 ETag 条件请求: 状态未变且无通知时返回 304 节省带宽
 */
export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const filter: TaskFilter = {
        status: url.searchParams.get('status') || undefined,
        owner: url.searchParams.get('owner') || undefined,
        keyword: url.searchParams.get('keyword') || undefined,
    };

    let tasksList = '';
    let tasksData: Array<{ id: number; subject: string; description: string; status: string; owner: string | null; blockedBy: number[]; blocks: number[] }> = [];
    try {
        tasksList = TASK_MGR.listAll();
        tasksData = TASK_MGR.listAllStructured(filter);
    } catch { tasksList = 'No tasks.'; }

    let worktrees = '';
    try { worktrees = WORKTREE_MGR.list(); } catch {}

    let teammates: Array<{ name: string; role: string; status: string }> = [];
    try { teammates = TEAM_MGR.listAll(); } catch {}

    const stableBody = {
        todos: TODO.items || [],
        tasksString: tasksList,
        tasks: tasksData,
        teammates,
        worktrees,
        artifacts: ARTIFACT_MGR.list(),
        bgTasks: BG_MGR.listActive(),
        cronTasks: CRON_MGR.listActive(),
        auditLog: TASK_MGR.getAuditLog(undefined, 20),
        knowledge: KNOWLEDGE_MGR.getStats(),
    };

    // ETag 仅基于稳定状态计算 (不含一次性通知)
    const stableJson = JSON.stringify(stableBody);
    const etag = `"${createHash('md5').update(stableJson).digest('hex').slice(0, 16)}"`;

    // 在 ETag 检查之后 drain 通知 — 确保 304 响应不会丢失通知
    const bgNotifs = BG_MGR.drain();

    if (req.headers.get('if-none-match') === etag && bgNotifs.length === 0) {
        return new NextResponse(null, { status: 304 });
    }

    return NextResponse.json({ ...stableBody, bgNotifs }, { headers: { 'ETag': etag } });
}
