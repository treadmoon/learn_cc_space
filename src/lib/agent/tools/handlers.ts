import {
    TODO, BG_MGR, TASK_MGR, CRON_MGR, SKILLS, ARTIFACT_MGR,
    KNOWLEDGE_MGR, BUS, TEAM_MGR, WORKTREE_MGR
} from '../managers';
import { runBash, runRead, runWrite, runEdit } from './fs';
import { compressMessages } from './message';

/**
 * 工具处理器工厂 — 创建当前请求的 handler 映射表
 * 绝大多数 handler 是纯静态的 (直接委托 Manager 单例),
 * 仅 compress 和 task_create 需要注入请求级参数:
 *   - compress: 需要 messages 引用以原地压缩上下文
 *   - task_create: 需要 reqId 写入审计日志
 */
export function createToolHandlers(messages: any[], reqId: string): Record<string, Function> {
    return {
        // ── 文件系统 → fs.ts ──
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

        // ── Worktree ──
        worktree_list:   () => JSON.stringify(WORKTREE_MGR.listStructured(), null, 2),
        worktree_add:    (kw: any) => WORKTREE_MGR.create(kw.branch, kw.path),
        worktree_remove: (kw: any) => WORKTREE_MGR.remove(kw.target),

        // ── RAG 知识库 (异步) ──
        knowledge_ingest: async (kw: any) => {
            if (kw.path) return await KNOWLEDGE_MGR.ingest(kw.path);
            if (kw.text) return await KNOWLEDGE_MGR.ingestText(kw.text, kw.source || 'inline');
            return 'Error: Provide either path or text';
        },
        knowledge_search: async (kw: any) => await KNOWLEDGE_MGR.search(kw.query, kw.top_k),
    };
}
