import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { TASK_MGR, TODO, TEAM_MGR, WORKTREE_MGR, BG_MGR, CRON_MGR, ARTIFACT_MGR, type TaskFilter } from '@/lib/agent/managers';

export const runtime = 'nodejs';

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
        auditLog: TASK_MGR.getAuditLog(undefined, 20)
    };

    // ETag based on stable state only (excludes one-shot notifications)
    const stableJson = JSON.stringify(stableBody);
    const etag = `"${createHash('md5').update(stableJson).digest('hex').slice(0, 16)}"`;

    // Drain notifications AFTER ETag check to avoid losing them on 304
    const bgNotifs = BG_MGR.drain();

    if (req.headers.get('if-none-match') === etag && bgNotifs.length === 0) {
        return new NextResponse(null, { status: 304 });
    }

    return NextResponse.json({ ...stableBody, bgNotifs }, { headers: { 'ETag': etag } });
}
