/**
 * Mock 响应模块 — DEMO_MODE 下替代真实 LLM 调用
 *
 * 提供两个能力:
 *   1. getDemoResponse() — 模拟 chat.completions.create 返回
 *   2. getDemoEmbedding() — 模拟 embeddings.create 返回
 *
 * Mock 对话流程 (3 轮):
 *   轮次 0: 工具调用 bash("ls -la")       → finish_reason: 'tool_calls'
 *   轮次 1: 工具调用 read_file("package.json") → finish_reason: 'tool_calls'
 *   轮次 2: 文本总结回复                    → finish_reason: 'stop'
 *   轮次 3+: 提示 demo 循环已完成           → finish_reason: 'stop'
 *
 * 工具会真实执行 (ls, read_file 仍会运行), mock 只替换 LLM 的"思考"部分。
 */
import type OpenAI from 'openai';

// 生成随机 ID (模拟 tool_call ID)
function randomId(): string {
    return 'call_' + Math.random().toString(36).slice(2, 14);
}

// 构造 usage 对象
function makeUsage(prompt: number, completion: number): OpenAI.CompletionUsage {
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

// 简单 hash — 将字符串映射为 32 位整数 (用于确定性 embedding 种子)
function hashStr(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return h;
}

// 确定性伪随机数生成器 (xorshift32)
function seededRandom(seed: number): () => number {
    let s = seed || 1;
    return () => {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        return (s >>> 0) / 4294967296;
    };
}

/**
 * 根据当前对话轮次返回 mock 响应
 * 判断逻辑: 统计 messages 中 role='tool' 的数量 = 已完成的工具调用数 = 当前轮次
 */
export function getDemoResponse(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    _tools: OpenAI.Chat.Completions.ChatCompletionTool[]
) {
    const toolResultCount = messages.filter(m => m.role === 'tool').length;

    if (toolResultCount === 0) {
        // 轮次 0: 调用 bash 探索项目结构
        return {
            id: 'chatcmpl-demo-' + randomId(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'demo-mode',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: null,
                    refusal: null,
                    tool_calls: [{
                        id: randomId(),
                        type: 'function',
                        function: {
                            name: 'bash',
                            arguments: JSON.stringify({ command: 'ls -la' }),
                        },
                    }],
                },
                finish_reason: 'tool_calls',
            }],
            usage: makeUsage(320, 45),
        };
    }

    if (toolResultCount === 1) {
        // 轮次 1: 调用 read_file 查看 package.json
        return {
            id: 'chatcmpl-demo-' + randomId(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'demo-mode',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: null,
                    refusal: null,
                    tool_calls: [{
                        id: randomId(),
                        type: 'function',
                        function: {
                            name: 'read_file',
                            arguments: JSON.stringify({ path: 'package.json' }),
                        },
                    }],
                },
                finish_reason: 'tool_calls',
            }],
            usage: makeUsage(580, 38),
        };
    }

    if (toolResultCount === 2) {
        // 轮次 2: 最终文本回复
        return {
            id: 'chatcmpl-demo-' + randomId(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'demo-mode',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    refusal: null,
                    content: [
                        '这是一个基于 **Next.js** 构建的 AI Agent 框架项目，核心特性包括：',
                        '',
                        '1. **多工具调用** — 支持 bash、文件读写、任务管理、知识库检索等 28+ 工具',
                        '2. **子 Agent 协作** — 通过 TeammateManager 实现多 Agent 并行协作',
                        '3. **Git Worktree 集成** — 支持多工作树并行开发',
                        '4. **RAG 知识库** — 内置向量检索，支持文件导入和语义搜索',
                        '5. **SSE 流式响应** — 实时推送 Agent 状态、工具执行日志到前端',
                        '',
                        '技术栈：Next.js 15 + React + TypeScript + OpenAI SDK + Tailwind CSS',
                        '',
                        '*当前运行在 DEMO 模式，所有响应为模拟数据。*',
                    ].join('\n'),
                },
                finish_reason: 'stop',
            }],
            usage: makeUsage(1200, 180),
        };
    }

    // 轮次 3+: demo 循环已完成，提示用户
    return {
        id: 'chatcmpl-demo-' + randomId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'demo-mode',
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                refusal: null,
                content: '**[DEMO] 演示循环已完成** — 当前为演示模式，仅展示 3 轮 Agent 交互流程。如需完整体验，请配置真实 API Key 并关闭 `DEMO_MODE`。',
            },
            finish_reason: 'stop',
        }],
        usage: makeUsage(80, 25),
    };
}

/**
 * 生成确定性 1536 维嵌入向量 (模拟 text-embedding-v3 输出)
 * 相同文本 → 相同向量, 保证语义搜索结果可复现
 * 使用 xorshift32 伪随机 + 文本 hash 作为种子
 */
export function getDemoEmbedding(text: string): number[] {
    const dim = 1536;
    const rng = seededRandom(hashStr(text));
    const vec = new Array(dim);
    for (let i = 0; i < dim; i++) {
        vec[i] = (rng() - 0.5) * 2;
    }
    // 归一化
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < dim; i++) vec[i] /= norm;
    return vec;
}
