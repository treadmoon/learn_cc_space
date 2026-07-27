/**
 * LLM Client — OpenAI SDK 单例
 *
 * 从 route.ts 提取, 供 route.ts 和 subagent.ts 共享复用。
 * 使用 OpenAI 兼容接口, 支持 Anthropic Claude / 火山引擎 Ark 等第三方服务。
 * baseURL 和 apiKey 从环境变量读取。
 *
 * DEMO_MODE: 当 DEMO_MODE=true 时, monkey-patch chat.completions.create,
 * 所有 LLM 调用返回预录 mock 数据, 不消耗真实 Token。
 */
import OpenAI from 'openai';
import { getDemoResponse } from './mock-responses';

export const DEMO_MODE = process.env.DEMO_MODE === 'true';

export const client = new OpenAI({
    baseURL: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_API_KEY || 'sk-none',
});

export const MODEL = process.env.MODEL_ID || 'claude-3-5-sonnet-20241022';

// ─── DEMO_MODE 拦截 ──────────────────────────────────────────────
// 替换 chat.completions.create 为 mock 实现
// 覆盖 route.ts 和 subagent.ts 两处 LLM 调用 (共享同一 client 单例)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkey-patch requires bypassing SDK's APIPromise type
if (DEMO_MODE) {
    (client.chat.completions as any).create = async (params: OpenAI.Chat.Completions.ChatCompletionCreateParams) => {
        return getDemoResponse(params.messages, params.tools ?? []);
    };
}
