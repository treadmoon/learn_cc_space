import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from '../tools/fs';

const WORKDIR = process.cwd();
const SESSIONS_DIR = path.join(WORKDIR, '.sessions');

export interface SessionData {
    id: string;
    title: string;
    messages: Array<{ role: string; content: string }>;
    createdAt: string;
    updatedAt: string;
}

export interface SessionSummary {
    id: string;
    title: string;
    messageCount: number;
    createdAt: string;
    updatedAt: string;
}

/**
 * SessionManager — 会话持久化管理
 *
 * 存储: .sessions/{uuid}.json (每个会话一个文件)
 * 数据结构:
 *   { id, title, messages: [{role, content}], createdAt, updatedAt }
 *
 * 保存时机: SSE 流收到 'done' 事件时, 客户端自动调用 PATCH /api/sessions
 * 注意: 保存的是完整 messages 数组 (含 tool 结果), 不受 compressMessages 影响
 *
 * 会话操作:
 *   create()      → 创建新会话 (UUID)
 *   list()        → 列出所有会话 (按 updatedAt 降序)
 *   get(id)       → 获取单个会话
 *   update(id, m) → 更新消息和标题
 *   delete(id)    → 删除会话
 *   getLatest()   → 获取最近的会话 (页面加载时恢复)
 */
export class SessionManager {
    constructor() {
        mkdirSync(SESSIONS_DIR);
    }

    private _path(id: string): string {
        return path.join(SESSIONS_DIR, `${id}.json`);
    }

    private _read(id: string): SessionData | null {
        const p = this._path(id);
        if (!fs.existsSync(p)) return null;
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
    }

    private _write(data: SessionData) {
        fs.writeFileSync(this._path(data.id), JSON.stringify(data, null, 2), 'utf8');
    }

    create(): SessionData {
        const now = new Date().toISOString();
        const data: SessionData = {
            id: randomUUID(),
            title: 'New Session',
            messages: [],
            createdAt: now,
            updatedAt: now,
        };
        this._write(data);
        return data;
    }

    list(): SessionSummary[] {
        if (!fs.existsSync(SESSIONS_DIR)) return [];
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
        const summaries: SessionSummary[] = [];
        for (const file of files) {
            try {
                const data: SessionData = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
                summaries.push({
                    id: data.id,
                    title: data.title,
                    messageCount: data.messages.length,
                    createdAt: data.createdAt,
                    updatedAt: data.updatedAt,
                });
            } catch { /* skip corrupt files */ }
        }
        return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    get(id: string): SessionData | null {
        return this._read(id);
    }

    update(id: string, messages: Array<{ role: string; content: string }>, title?: string): void {
        const data = this._read(id);
        if (!data) return;
        data.messages = messages;
        data.updatedAt = new Date().toISOString();
        if (title) data.title = title;
        this._write(data);
    }

    delete(id: string): boolean {
        const p = this._path(id);
        if (!fs.existsSync(p)) return false;
        fs.unlinkSync(p);
        return true;
    }

    getLatest(): SessionData | null {
        const list = this.list();
        if (!list.length) return null;
        return this._read(list[0].id);
    }
}
