/**
 * 共享类型定义
 *
 * 本文件集中定义跨层共享的接口，避免同一类型在多处重复定义导致的漂移风险。
 * 层级: API (route.ts) → State (state/route.ts) → Hook (useGlobalState.ts) → Component (LeftPanel/RightPanel)
 */

/** Worktree 结构化信息 — 来自 git worktree list --porcelain */
export interface WorktreeInfo {
    path: string;       // worktree 绝对路径
    branch: string;     // 分支名 (不含 refs/heads/ 前缀)
    head: string;       // commit hash (短)
    bare: boolean;      // 是否 bare worktree
    locked: boolean;    // 是否锁定
    isMain: boolean;    // 是否主 worktree (与 process.cwd() 相同)
}
