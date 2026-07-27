import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdirSync } from '../tools/fs';

const WORKDIR = process.cwd();
const ARTIFACTS_DIR = path.join(WORKDIR, '.artifacts');

export interface ArtifactFile {
    name: string;
    createdAt: string;
    size: number;
    description: string;
}

export interface ArtifactMeta {
    taskId: number | null;
    files: ArtifactFile[];
}

/**
 * ArtifactManager — 制品归档管理
 *
 * 存储: .artifacts/
 *   .artifacts/task-{id}/     ← 关联到特定任务的制品
 *   .artifacts/shared/        ← 未关联任务的共享制品
 *   每个目录下有 _meta.json   ← 记录文件列表和元信息
 *
 * 用途: Agent 执行任务过程中产生的输出文件 (报告、代码、配置等)
 * 操作: save() 复制文件到归档目录 + 更新元信息
 */
export class ArtifactManager {
    constructor() {
        mkdirSync(ARTIFACTS_DIR);
    }

    private _dir(taskId?: number | null): string {
        const dir = taskId ? path.join(ARTIFACTS_DIR, `task-${taskId}`) : path.join(ARTIFACTS_DIR, 'shared');
        mkdirSync(dir);
        return dir;
    }

    private _metaPath(dir: string): string {
        return path.join(dir, '_meta.json');
    }

    private _loadMeta(dir: string): ArtifactMeta {
        const p = this._metaPath(dir);
        if (fs.existsSync(p)) {
            try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* ignore */ }
        }
        return { taskId: null, files: [] };
    }

    private _saveMeta(dir: string, meta: ArtifactMeta) {
        fs.writeFileSync(this._metaPath(dir), JSON.stringify(meta, null, 2), 'utf8');
    }

    save(filePath: string, taskId?: number | null, description?: string): string {
        const srcPath = path.resolve(WORKDIR, filePath);
        if (!fs.existsSync(srcPath)) return `Error: File not found: ${filePath}`;

        const dir = this._dir(taskId);
        const fileName = path.basename(filePath);
        const destPath = path.join(dir, fileName);

        fs.copyFileSync(srcPath, destPath);
        const stat = fs.statSync(destPath);

        const meta = this._loadMeta(dir);
        meta.taskId = taskId || null;
        meta.files = meta.files.filter(f => f.name !== fileName);
        meta.files.push({ name: fileName, createdAt: new Date().toISOString(), size: stat.size, description: description || '' });
        this._saveMeta(dir, meta);

        const loc = taskId ? `task-${taskId}` : 'shared';
        return `Saved ${fileName} to .artifacts/${loc}/ (${stat.size} bytes)`;
    }

    list(taskId?: number | null): ArtifactMeta[] {
        if (!fs.existsSync(ARTIFACTS_DIR)) return [];
        if (taskId !== undefined && taskId !== null) {
            const dir = path.join(ARTIFACTS_DIR, `task-${taskId}`);
            if (!fs.existsSync(dir)) return [];
            return [this._loadMeta(dir)];
        }
        const entries = fs.readdirSync(ARTIFACTS_DIR, { withFileTypes: true });
        return entries.filter(e => e.isDirectory()).map(e => this._loadMeta(path.join(ARTIFACTS_DIR, e.name)));
    }
}
