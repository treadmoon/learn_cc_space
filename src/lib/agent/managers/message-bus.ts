import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdirSync } from '../tools/fs';

const WORKDIR = process.cwd();
const TEAM_DIR = path.join(WORKDIR, '.team');
const INBOX_DIR = path.join(TEAM_DIR, 'inbox');

/**
 * MessageBus — 成员间消息传递 (fire-and-forget inbox)
 *
 * 存储: .team/inbox/{name}.jsonl
 * 读取后即清空 — 不是持久化消息队列
 *
 * 与传统消息队列的区别:
 *   - 无持久化保留 (读完即删)
 *   - 无重试机制
 *   - 无确认机制
 *   - 适用场景: 子 Agent 间一次性结果传递
 */
export class MessageBus {
    constructor() {
        mkdirSync(INBOX_DIR);
    }

    /**
     * 读取指定成员的收件箱 — 破坏性读取 (读后清空)
     * 存储: .team/inbox/{name}.jsonl (每行一个 JSON 消息)
     * 语义: fire-and-forget, 消息被读取后即丢失
     */
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

    /**
     * 向指定成员收件箱写入消息 — 追加到 .team/inbox/{name}.jsonl
     * 每行一个 JSON 对象, 格式: { from, content, timestamp }
     *
     * 与 readInbox 的破坏性读取配对使用:
     *   sendInbox('tester', 'agent', '开始测试') → 写入 tester.jsonl
     *   readInbox('tester')                       → 读取并清空 tester.jsonl
     *
     * @param to      收件人名称 (对应 .team/inbox/{to}.jsonl)
     * @param from    发件人名称
     * @param content 消息内容
     * @returns       确认消息
     */
    sendInbox(to: string, from: string, content: string): string {
        const inboxPath = path.join(INBOX_DIR, `${to}.jsonl`);
        const msg = JSON.stringify({ from, content, timestamp: new Date().toISOString() });
        fs.appendFileSync(inboxPath, msg + '\n', 'utf8');

        // 唤醒目标子 Agent — 让它立即处理新消息, 无需等待 5s 轮询
        // TEAM_MGR 延迟导入避免循环依赖
        try { const { TEAM_MGR } = require('./index'); TEAM_MGR.wakeRunner(to); } catch { /* 目标不是子 Agent, 忽略 */ }

        return `Message sent to '${to}'`;
    }
}
