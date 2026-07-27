/**
 * 压缩对话上下文 — 移除旧消息, 仅保留最近 KEEP_RECENT 条
 * 被 Agent 通过 compress 工具主动调用, 或在上下文接近窗口限制时触发
 *
 * 策略:
 *   1. splice 移除前 N-KEEP_RECENT 条消息
 *   2. 在头部插入一条压缩摘要消息 (role: user)
 *   3. 统计被移除的 user/assistant/tool 消息数量
 *
 * @param msgs  messages 数组 (原地修改)
 * @returns     压缩结果描述
 */
export function compressMessages(msgs: any[]): string {
    const KEEP_RECENT = 4;
    if (msgs.length <= KEEP_RECENT + 1) return 'Context is already small, no compression needed.';

    const removed = msgs.splice(0, msgs.length - KEEP_RECENT);
    const toolCount = removed.filter((m: any) => m.role === 'tool').length;
    const userCount = removed.filter((m: any) => m.role === 'user').length;
    const assistantCount = removed.filter((m: any) => m.role === 'assistant').length;

    msgs.unshift({
        role: 'user',
        content: `<context-compression>\nPrevious conversation compressed. Removed ${removed.length} messages (${userCount} user, ${assistantCount} assistant, ${toolCount} tool results). Continue from the most recent context.\n</context-compression>`
    });

    return `Compressed: removed ${removed.length} old messages, kept ${KEEP_RECENT} recent.`;
}

/**
 * 构建用户消息 — 将文本和附件转换为 LLM 可理解的多模态消息格式
 * 图片 → base64 data URL, 文本文件 → 解码截断注入, 其他 → 元信息占位
 * 无输入时返回 null
 */
export function buildUserMessage(
    message: string | undefined,
    attachments: Array<{ type?: string; name?: string; data: string; size?: number }> | undefined
): { role: 'user'; content: any } | null {
    if (!message && !attachments?.length) return null;

    if (!attachments?.length) {
        return { role: 'user', content: message || '' };
    }

    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    if (message) parts.push({ type: 'text', text: message });

    const TEXT_FILE_RE = /\.(md|json|txt|csv|xml|yaml|yml|ts|js|tsx|jsx|py|go|rs|java|c|cpp|h|css|html|sql|sh)$/i;

    for (const att of attachments) {
        if (att.type?.startsWith('image/')) {
            parts.push({ type: 'image_url', image_url: { url: `data:${att.type};base64,${att.data}` } });
        } else if (att.type?.startsWith('text/') || att.name?.match(TEXT_FILE_RE)) {
            const textContent = Buffer.from(att.data, 'base64').toString('utf8').slice(0, 10000);
            parts.push({ type: 'text', text: `\n\n[File: ${att.name}]\n${textContent}` });
        } else {
            parts.push({ type: 'text', text: `\n\n[Attached: ${att.name} (${att.type}, ${att.size} bytes)]` });
        }
    }

    return { role: 'user', content: parts };
}
