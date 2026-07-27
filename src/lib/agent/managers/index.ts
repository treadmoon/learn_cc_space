import * as path from 'node:path';

// ─── 类导入 ────────────────────────────────────────────────────────
import { TodoManager, type TodoItem } from './todo';
import { TaskManager, type TaskFilter } from './task';
import { BackgroundManager } from './background';
import { CronManager } from './cron';
import { SkillLoader } from './skill';
import { MessageBus } from './message-bus';
import { TeammateManager } from './teammate';
import { WorktreeManager } from './worktree';
import { ArtifactManager, type ArtifactFile, type ArtifactMeta } from './artifact';
import { SessionManager, type SessionData, type SessionSummary } from './session';
import { KnowledgeManager } from '../knowledge';
import { McpManager } from '../mcp';
import type { WorktreeInfo } from '../../types';

// ─── 重导出 (保持向后兼容) ──────────────────────────────────────────
export {
    TodoManager, type TodoItem,
    TaskManager, type TaskFilter,
    BackgroundManager,
    CronManager,
    SkillLoader,
    MessageBus,
    TeammateManager,
    WorktreeManager,
    ArtifactManager, type ArtifactFile, type ArtifactMeta,
    SessionManager, type SessionData, type SessionSummary,
};
export type { WorktreeInfo };

// ─── Singleton 注册 (globalForAgent 模式) ────────────────────────────
//
//   为什么需要 globalForAgent?
//
//   问题 1 — 跨模块共享:
//     每个 Manager 都是无状态工具, 需要全局唯一实例
//     直接 new 会导致多个实例各自持有独立状态
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
