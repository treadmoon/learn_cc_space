import * as path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import type { WorktreeInfo } from '../../types';

const WORKDIR = process.cwd();

/**
 * WorktreeManager — Git worktree 管理
 *
 * 能力:
 *   - list():          原始文本输出 (向后兼容)
 *   - listStructured(): 结构化数据 (前端卡片展示)
 *   - create(branch):  创建新 worktree
 *   - remove(target):  删除 worktree (按路径或分支名)
 */
export class WorktreeManager {
    /** 原始文本列表 — 向后兼容 */
    list(): string {
        try {
            const output = execSync('git worktree list', { cwd: WORKDIR, encoding: 'utf8', stdio: 'pipe' });
            return output.trim();
        } catch (e: any) {
            return `Not a git repository, or worktree tracking unavailable.`;
        }
    }

    /** 结构化列表 — 解析 `git worktree list --porcelain` 输出 */
    listStructured(): WorktreeInfo[] {
        try {
            const output = execSync('git worktree list --porcelain', { cwd: WORKDIR, encoding: 'utf8', stdio: 'pipe' });
            const worktrees: WorktreeInfo[] = [];
            let current: Partial<WorktreeInfo> = {};

            for (const line of output.split('\n')) {
                if (!line.trim()) {
                    // 空行 = 分隔符, 提交当前条目
                    if (current.path) {
                        worktrees.push(this._finalize(current));
                        current = {};
                    }
                    continue;
                }
                const [key, ...rest] = line.split(' ');
                const value = rest.join(' ');
                switch (key) {
                    case 'worktree': current.path = value; break;
                    case 'HEAD': current.head = value.slice(0, 8); break;
                    case 'branch': current.branch = value.replace('refs/heads/', ''); break;
                    case 'bare': current.bare = true; break;
                    case 'locked': current.locked = true; break;
                }
            }
            // 最后一个条目 (无尾部空行)
            if (current.path) worktrees.push(this._finalize(current));

            return worktrees;
        } catch {
            return [];
        }
    }

    private _finalize(partial: Partial<WorktreeInfo>): WorktreeInfo {
        return {
            path: partial.path || '',
            branch: partial.branch || '(detached)',
            head: partial.head || '?',
            bare: partial.bare || false,
            locked: partial.locked || false,
            isMain: partial.path === WORKDIR,
        };
    }

    /** 创建 worktree — git worktree add <path> <branch> */
    create(branch: string, worktreePath?: string): string {
        this._validateInput(branch);
        if (worktreePath) this._validateInput(worktreePath);
        try {
            const targetPath = worktreePath || path.join(path.dirname(WORKDIR), `${path.basename(WORKDIR)}-${branch}`);
            execFileSync('git', ['worktree', 'add', targetPath, branch], { cwd: WORKDIR, encoding: 'utf8', stdio: 'pipe' });
            return `Created worktree for '${branch}' at ${targetPath}`;
        } catch (e: any) {
            return `Error creating worktree: ${e.stderr || e.message}`;
        }
    }

    /** 删除 worktree — 支持传路径或分支名 */
    remove(target: string): string {
        this._validateInput(target);
        try {
            // 如果 target 不是绝对路径, 尝试按分支名查找
            let worktreePath = target;
            if (!path.isAbsolute(target)) {
                const found = this.listStructured().find(w => w.branch === target);
                if (!found) return `Error: No worktree found for branch '${target}'`;
                worktreePath = found.path;
            }
            execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: WORKDIR, encoding: 'utf8', stdio: 'pipe' });
            return `Removed worktree at ${worktreePath}`;
        } catch (e: any) {
            return `Error removing worktree: ${e.stderr || e.message}`;
        }
    }

    /** 输入校验 — 拒绝 shell 元字符 */
    private _validateInput(input: string): void {
        if (/[;&|`$()'"\\]/.test(input)) {
            throw new Error(`Invalid input: contains forbidden shell metacharacters`);
        }
    }
}
