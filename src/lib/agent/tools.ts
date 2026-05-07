import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WORKDIR = process.cwd();
const CONTEXT_TRUNCATE_CHARS = 50000;
const TASK_OUTPUT_DIR = path.join(WORKDIR, '.task_outputs');
const TOOL_RESULTS_DIR = path.join(TASK_OUTPUT_DIR, 'tool-results');
const PERSIST_OUTPUT_TRIGGER_CHARS_DEFAULT = 50000;
const PERSIST_OUTPUT_TRIGGER_CHARS_BASH = 30000;
const PERSISTED_PREVIEW_CHARS = 2000;
const PERSISTED_OPEN = '<persisted-output>';
const PERSISTED_CLOSE = '</persisted-output>';

export function safePath(p: string): string {
    const resolved = path.resolve(WORKDIR, p);
    if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR) {
        throw new Error(`Path escapes workspace: ${p}`);
    }
    return resolved;
}

export function mkdirSync(dir: string) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function persistToolResult(toolUseId: string, content: string) {
    mkdirSync(TOOL_RESULTS_DIR);
    const safeId = toolUseId.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'unknown';
    const filePath = path.join(TOOL_RESULTS_DIR, `${safeId}.txt`);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, content, 'utf8');
    }
    return path.relative(WORKDIR, filePath);
}

function formatSize(size: number) {
    if (size < 1024) return `${size}B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
    return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

function previewSlice(text: string, limit: number) {
    if (text.length <= limit) return { text, hasMore: false };
    const idx = text.lastIndexOf('\n', limit);
    const cut = idx > limit * 0.5 ? idx : limit;
    return { text: text.slice(0, cut), hasMore: true };
}

export function maybePersistOutput(toolUseId: string, output: string, triggerChars: number | null = null) {
    if (typeof output !== 'string') return String(output);
    const trigger = triggerChars !== null ? triggerChars : PERSIST_OUTPUT_TRIGGER_CHARS_DEFAULT;
    if (output.length <= trigger) return output;
    
    const storedPath = persistToolResult(toolUseId, output);
    const { text: preview, hasMore } = previewSlice(output, PERSISTED_PREVIEW_CHARS);
    let marker = `${PERSISTED_OPEN}\n`;
    marker += `Output too large (${formatSize(output.length)}). `;
    marker += `Full output saved to: ${storedPath}\n\n`;
    marker += `Preview (first ${formatSize(PERSISTED_PREVIEW_CHARS)}):\n`;
    marker += preview;
    if (hasMore) marker += '\n...';
    marker += `\n${PERSISTED_CLOSE}`;
    return marker;
}

const BLOCKED_PATTERNS = [
    /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(?!\S*\.)/i,  // rm -rf / or rm /
    /\bsudo\b/i,
    /\bsu\s+/i,
    /\b(shutdown|reboot|halt|poweroff)\b/i,
    /\bmkfs\b/i,
    /\bdd\s+.*of=\/dev\//i,
    />\s*\/dev\/sd/i,
    /\bcurl\b.*\|\s*(ba)?sh/i,                          // curl | sh
    /\bwget\b.*\|\s*(ba)?sh/i,
    /\b(nc|ncat|netcat)\b.*-[elp]/i,                    // reverse shells
    /\bchmod\s+[0-7]*777\s+\//i,                        // chmod 777 /
    /\bchown\b.*\s+\//i,
    /:\(\)\s*\{.*:\|:.*&\s*\}\s*;/,                       // fork bomb
];

export function runBash(command: string, toolUseId: string = ''): string {
    if (BLOCKED_PATTERNS.some(p => p.test(command))) {
        return `Error: Dangerous command blocked: ${command.slice(0, 60)}`;
    }
    try {
        const result = spawnSync('sh', ['-c', command], {
            cwd: WORKDIR,
            timeout: 120 * 1000,
            encoding: 'utf8'
        });
        
        const { stdout, stderr, error } = result;
        if (error) {
            return `Error: ${error.message}`;
        }
        
        let out = (stdout || '').trim() + (stderr || '').trim();
        if (!out) return '(no output)';
        out = maybePersistOutput(toolUseId, out, PERSIST_OUTPUT_TRIGGER_CHARS_BASH);
        return out.slice(0, CONTEXT_TRUNCATE_CHARS);
    } catch (e: any) {
        if (e.message && e.message.includes('timeout')) return 'Error: Timeout (120s)';
        return `Error: ${e.message}`;
    }
}

export function runRead(filePath: string, toolUseId: string = '', limit: number | null = null): string {
    try {
        const fullPath = safePath(filePath);
        let content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');
        if (limit && lines.length > limit) {
            lines.splice(limit, lines.length - limit, `... (${lines.length - limit} more)`);
            content = lines.join('\n');
        }
        content = maybePersistOutput(toolUseId, content);
        return content.slice(0, CONTEXT_TRUNCATE_CHARS);
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}

export function runWrite(filePath: string, content: string): string {
    try {
        const fullPath = safePath(filePath);
        mkdirSync(path.dirname(fullPath));
        const tmpPath = fullPath + `.tmp.${Date.now()}`;
        fs.writeFileSync(tmpPath, content, 'utf8');
        try {
            fs.renameSync(tmpPath, fullPath);
        } catch {
            // rename can fail across filesystems; fall back to direct write
            try { fs.unlinkSync(tmpPath); } catch {}
            fs.writeFileSync(fullPath, content, 'utf8');
        }
        return `Wrote ${content.length} bytes to ${filePath}`;
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}

export function runEdit(filePath: string, oldText: string, newText: string): string {
    try {
        const fullPath = safePath(filePath);
        let content = fs.readFileSync(fullPath, 'utf8');
        const count = content.split(oldText).length - 1;
        if (count === 0) return `Error: Text not found in ${filePath}`;
        if (count > 1) return `Error: Text matches ${count} locations in ${filePath}. Provide more context to match uniquely.`;
        content = content.replace(oldText, newText);
        const tmpPath = fullPath + `.tmp.${Date.now()}`;
        fs.writeFileSync(tmpPath, content, 'utf8');
        try {
            fs.renameSync(tmpPath, fullPath);
        } catch {
            try { fs.unlinkSync(tmpPath); } catch {}
            fs.writeFileSync(fullPath, content, 'utf8');
        }
        return `Edited ${filePath}`;
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}
