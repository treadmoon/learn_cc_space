/**
 * LLM Client — OpenAI SDK 单例
 *
 * 从 route.ts 提取, 供 route.ts 和 subagent.ts 共享复用。
 * 使用 OpenAI 兼容接口, 支持 Anthropic Claude / 火山引擎 Ark 等第三方服务。
 * baseURL 和 apiKey 从环境变量读取。
 */
import OpenAI from 'openai';

export const client = new OpenAI({
    baseURL: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_API_KEY || 'sk-none',
});

export const MODEL = process.env.MODEL_ID || 'claude-3-5-sonnet-20241022';
