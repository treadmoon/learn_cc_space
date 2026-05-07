import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exec, execSync } from 'node:child_process';
import { mkdirSync } from './tools';

const WORKDIR = process.cwd();
const TODOS_FILE = path.join(WORKDIR, '.todos.json');
const TASKS_DIR = path.join(WORKDIR, '.tasks');
const AUDIT_FILE = path.join(TASKS_DIR, 'audit.jsonl');
const TEAM_DIR = path.join(WORKDIR, '.team');
const INBOX_DIR = path.join(TEAM_DIR, 'inbox');

export interface TodoItem {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
}

export class TodoManager {
    public items: TodoItem[];

    constructor() {
        this.items = this._load();
    }

    private _load(): TodoItem[] {
        try {
            if (!fs.existsSync(TODOS_FILE)) return [];
            return JSON.parse(fs.readFileSync(TODOS_FILE, 'utf8'));
        } catch {
            return [];
        }
    }

    private _save() {
        fs.writeFileSync(TODOS_FILE, JSON.stringify(this.items, null, 2), 'utf8');
    }

    update(items: any[]): string {
        const validated: TodoItem[] = [];
        let inProgressCount = 0;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const content = String(item.content || '').trim();
            const status = String(item.status || 'pending').toLowerCase() as any;
            const activeForm = String(item.activeForm || '').trim();

            if (!content) throw new Error(`Item ${i}: content required`);
            if (!['pending', 'in_progress', 'completed'].includes(status)) {
                throw new Error(`Item ${i}: invalid status '${status}'`);
            }
            if (!activeForm) throw new Error(`Item ${i}: activeForm required`);
            if (status === 'in_progress') inProgressCount++;

            validated.push({ content, status, activeForm });
        }

        if (validated.length > 20) throw new Error('Max 20 todos');
        if (inProgressCount > 1) throw new Error('Only one in_progress allowed');

        this.items = validated;
        this._save();
        return this.render();
    }

    render(): string {
        if (!this.items.length) return 'No todos.';
        const statusMap: Record<string, string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };
        const lines = this.items.map(item => {
            const mark = statusMap[item.status] || '[?]';
            const suffix = item.status === 'in_progress' ? ` <- ${item.activeForm}` : '';
            return `${mark} ${item.content}${suffix}`;
        });
        const done = this.items.filter((t: TodoItem) => t.status === 'completed').length;
        lines.push(`\n(${done}/${this.items.length} completed)`);
        return lines.join('\n');
    }

    hasOpenItems(): boolean {
        return this.items.some((item: TodoItem) => item.status !== 'completed');
    }
}

export interface TaskFilter {
    status?: string;
    owner?: string;
    keyword?: string;
}

export class TaskManager {
    constructor() {
        mkdirSync(TASKS_DIR);
    }

    private _audit(action: string, taskId: number, actor: string = 'agent', details: Record<string, unknown> = {}) {
        const entry = { ts: new Date().toISOString(), action, taskId, actor, details };
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8');
    }

    getAuditLog(taskId?: number, limit: number = 50): Array<{ ts: string; action: string; taskId: number; actor: string; details: Record<string, unknown> }> {
        try {
            if (!fs.existsSync(AUDIT_FILE)) return [];
            const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(l => l);
            let entries = lines.map(l => JSON.parse(l));
            if (taskId !== undefined) {
                entries = entries.filter((e: { taskId: number }) => e.taskId === taskId);
            }
            return entries.slice(-limit).reverse();
        } catch {
            return [];
        }
    }

    private _nextId(): number {
        const ObjectFiles = fs.readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json'));
        if (!ObjectFiles.length) return 1;
        const ids = ObjectFiles.map(f => parseInt(f.replace('task_', '').replace('.json', '')) || 0);
        return Math.max(...ids) + 1;
    }

    private _load(tid: string | number): any {
        const p = path.join(TASKS_DIR, `task_${tid}.json`);
        if (!fs.existsSync(p)) throw new Error(`Task ${tid} not found`);
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }

    private _save(task: any) {
        const p = path.join(TASKS_DIR, `task_${task.id}.json`);
        fs.writeFileSync(p, JSON.stringify(task, null, 2), 'utf8');
    }

    create(subject: string, description: string = '', actor: string = 'agent'): string {
        const task = {
            id: this._nextId(),
            subject,
            description,
            status: 'pending',
            owner: null,
            blockedBy: [],
            blocks: []
        };
        this._save(task);
        this._audit('create', task.id, actor, { subject });
        return JSON.stringify(task, null, 2);
    }

    get(tid: string | number): string {
        return JSON.stringify(this._load(tid), null, 2);
    }

    update(tid: string | number, status: string | null = null, addBlockedBy: number[] | null = null, addBlocks: number[] | null = null, actor: string = 'agent'): string {
        const task = this._load(tid);
        if (status) {
            task.status = status;
            if (status === 'completed') {
                const files = fs.readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json'));
                for (const file of files) {
                    const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
                    if (t.blockedBy && t.blockedBy.includes(Number(tid))) {
                        t.blockedBy = t.blockedBy.filter((id: number) => id !== Number(tid));
                        this._save(t);
                    }
                }
            }
            if (status === 'deleted') {
                const p = path.join(TASKS_DIR, `task_${tid}.json`);
                if (fs.existsSync(p)) fs.unlinkSync(p);
                this._audit('delete', Number(tid), actor);
                return `Task ${tid} deleted`;
            }
            this._audit('update', Number(tid), actor, { status });
        }
        if (addBlockedBy) task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
        if (addBlocks) task.blocks = [...new Set([...task.blocks, ...addBlocks])];
        this._save(task);
        if (addBlockedBy || addBlocks) {
            this._audit('update', Number(tid), actor, { addBlockedBy, addBlocks });
        }
        return JSON.stringify(task, null, 2);
    }

    listAll(): string {
        const files = fs.readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json')).sort();
        if (!files.length) return 'No tasks.';
        const statusMap: Record<string, string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]', expired: '[!]' };
        const lines = files.map(file => {
            const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
            const mark = statusMap[t.status] || '[?]';
            const owner = t.owner ? ` @${t.owner}` : '';
            const blocked = t.blockedBy && t.blockedBy.length ? ` (blocked by: ${t.blockedBy})` : '';
            return `${mark} #${t.id}: ${t.subject}${owner}${blocked}`;
        });
        return lines.join('\n');
    }

    listAllStructured(filter?: TaskFilter): Array<{ id: number; subject: string; description: string; status: string; owner: string | null; blockedBy: number[]; blocks: number[] }> {
        const files = fs.readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json')).sort();
        let tasks = files.map(file => {
            const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'));
            return { id: t.id, subject: t.subject, description: t.description || '', status: t.status, owner: t.owner || null, blockedBy: t.blockedBy || [], blocks: t.blocks || [] };
        });

        if (filter) {
            if (filter.status) {
                tasks = tasks.filter(t => t.status === filter.status);
            }
            if (filter.owner) {
                const ownerLower = filter.owner.toLowerCase();
                tasks = tasks.filter(t => t.owner && t.owner.toLowerCase() === ownerLower);
            }
            if (filter.keyword) {
                const kw = filter.keyword.toLowerCase();
                tasks = tasks.filter(t =>
                    t.subject.toLowerCase().includes(kw) ||
                    t.description.toLowerCase().includes(kw)
                );
            }
        }

        return tasks;
    }

    claim(tid: string | number, owner: string, actor: string = 'agent'): string {
        const task = this._load(tid);
        task.owner = owner;
        task.status = 'in_progress';
        this._save(task);
        this._audit('claim', Number(tid), actor, { owner });
        return `Claimed task #${tid} for ${owner}`;
    }
}

export class BackgroundManager {
    public tasks: Record<string, any>;
    public notifications: any[];
    private maxConcurrent = 5;

    constructor() {
        this.tasks = {};
        this.notifications = [];
    }

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

export class CronManager {
    public tasks: Record<string, { id: string; command: string; intervalMs: number; timer: NodeJS.Timeout | null; lastRun: string | null; count: number }>;
    
    constructor() {
        this.tasks = {};
    }

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

export class SkillLoader {
    public skills: Record<string, { meta: any; body: string }> = {};

    constructor(skillsDir: string) {
        this._loadSkills(skillsDir);
    }

    private _loadSkills(skillsDir: string) {
        if (!fs.existsSync(skillsDir)) return;
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        const skillFiles = entries.filter(e => e.isDirectory())
             .map(e => path.join(skillsDir, e.name, 'SKILL.md'))
             .filter(p => fs.existsSync(p));

        for (const file of skillFiles.sort()) {
            const text = fs.readFileSync(file, 'utf8');
            const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
            let meta: any = {};
            let body = text;

            if (match) {
                const frontmatter = match[1];
                for (const line of frontmatter.trim().split('\n')) {
                    const colonIdx = line.indexOf(':');
                    if (colonIdx !== -1) {
                        const key = line.slice(0, colonIdx).trim();
                        const value = line.slice(colonIdx + 1).trim();
                        meta[key] = value;
                    }
                }
                body = match[2].trim();
            }

            const name = meta.name || path.basename(path.dirname(file));
            this.skills[name] = { meta, body };
        }
    }

    descriptions(): string {
        if (!Object.keys(this.skills).length) return '(no skills)';
        return Object.entries(this.skills)
            .map(([n, s]) => `  - ${n}: ${s.meta.description || '-'}`)
            .join('\n');
    }

    load(name: string): string {
        const skill = this.skills[name];
        if (!skill) {
            return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(', ')}`;
        }
        return `<skill name="${name}">\n${skill.body}\n</skill>`;
    }
}

export class MessageBus {
    constructor() {
        mkdirSync(INBOX_DIR);
    }
    
    readInbox(name: string): any[] {
        const inboxPath = path.join(INBOX_DIR, `${name}.jsonl`);
        if (!fs.existsSync(inboxPath)) return [];
        const content = fs.readFileSync(inboxPath, 'utf8').trim();
        if (!content) return [];
        try {
            const msgs = content.split('\n').filter(l => l).map(l => JSON.parse(l));
            fs.writeFileSync(inboxPath, '', 'utf8'); // clear
            return msgs;
        } catch { return []; }
    }
}

export class TeammateManager {
    public configPath: string;
    
    constructor() {
        mkdirSync(TEAM_DIR);
        this.configPath = path.join(TEAM_DIR, 'config.json');
        if (!fs.existsSync(this.configPath)) {
            this._save({ team_name: 'default', members: [] });
        }
    }
    
    _load() {
        if (fs.existsSync(this.configPath)) {
            try {
                return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            } catch (e) {
                return { team_name: 'default', members: [] };
            }
        }
        return { team_name: 'default', members: [] };
    }
    
    _save(data: any) {
        fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf8');
    }
    
    listAll(): any[] {
        const config = this._load();
        return config.members || [];
    }
    
    spawn(name: string, role: string) {
        const config = this._load();
        let member = config.members.find((m: any) => m.name === name);
        if (member) {
            member.status = 'working';
            member.role = role;
        } else {
            config.members.push({ name, role, status: 'working' });
        }
        this._save(config);
        return `Spawned/woke '${name}' (role: ${role})`;
    }
    
    setStatus(name: string, status: string) {
        const config = this._load();
        const member = config.members.find((m: any) => m.name === name);
        if (member) {
            member.status = status;
            this._save(config);
        }
    }
}

export class WorktreeManager {
    list(): string {
        try {
            const output = execSync('git worktree list', { cwd: WORKDIR, encoding: 'utf8', stdio: 'pipe' });
            return output.trim();
        } catch (e: any) {
            return `Not a git repository, or worktree tracking unavailable.`;
        }
    }
}

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
};

export const TODO = globalForAgent.TODO || new TodoManager();
export const TASK_MGR = globalForAgent.TASK_MGR || new TaskManager();
export const BG_MGR = globalForAgent.BG_MGR || new BackgroundManager();
export const CRON_MGR = globalForAgent.CRON_MGR || new CronManager();
export const SKILLS = globalForAgent.SKILLS || new SkillLoader(path.join(process.cwd(), 'skills'));
export const BUS = globalForAgent.BUS || new MessageBus();
export const TEAM_MGR = globalForAgent.TEAM_MGR || new TeammateManager();
export const WORKTREE_MGR = globalForAgent.WORKTREE_MGR || new WorktreeManager();
export const ARTIFACT_MGR = globalForAgent.ARTIFACT_MGR || new ArtifactManager();

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
}

export function microCompact(messages: any[], targetRecent = 3) {
    const PRESERVE_RESULT_TOOLS = new Set(['read_file']);
    const toolResults = messages.filter(m => m.role === 'tool');
    if (toolResults.length <= targetRecent) return;

    const toCompress = toolResults.slice(0, -targetRecent);
    for (const msg of toCompress) {
        if (typeof msg.content === 'string' && msg.content.length > 100) {
            const toolName = msg.name || 'unknown';
            if (PRESERVE_RESULT_TOOLS.has(toolName)) continue;
            msg.content = `[Previous: used ${toolName}]`;
        }
    }
}
