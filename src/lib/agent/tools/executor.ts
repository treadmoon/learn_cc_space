import type OpenAI from 'openai';
import { MCP_MGR } from '../managers';

/**
 * 加载 MCP 工具 — 从 .mcp.json 配置的 MCP Server 动态获取工具列表
 *
 * 流程:
 *   1. 调用 MCP_MGR.getTools() 懒连接所有配置的 MCP Server 并获取工具列表
 *   2. 将 MCP 工具转换为 OpenAI function-calling 格式, 合并到内置 TOOLS 数组
 *   3. 构建 MCP 工具名集合 (mcpToolNames), 用于工具执行时判断是否走 MCP 路由
 *
 * 容错:
 *   - 单个 MCP Server 连接失败不影响其他 Server 和内置工具
 *   - 所有 Server 都失败时返回原始 TOOLS, Agent 正常工作
 *
 * @param builtInTools  内置工具数组 (TOOLS)
 * @param reqId         当前请求 ID, 用于日志
 * @param sendEvent     SSE 事件发送器, 用于推送加载状态
 * @returns activeTools  合并后的完整工具列表
 * @returns mcpToolNames MCP 工具名集合 (用于 handler 分发)
 */
export async function loadMcpTools(
    builtInTools: any[],
    reqId: string,
    sendEvent: (event: string, data: any) => void
): Promise<{ activeTools: any[]; mcpToolNames: Set<string> }> {
    let activeTools = [...builtInTools];

    try {
        const mcpTools = await MCP_MGR.getTools();
        if (mcpTools.length > 0) {
            activeTools = [...builtInTools, ...mcpTools];
            sendEvent('log', { msg: `[MCP] Loaded ${mcpTools.length} tools from MCP servers`, reqId });
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        sendEvent('log', { msg: `[MCP] Failed to load MCP tools: ${msg}`, reqId });
    }

    const mcpToolNames = new Set(
        activeTools
            .filter(t => !builtInTools.some(s => s.function.name === t.function.name))
            .map(t => t.function.name)
    );

    return { activeTools, mcpToolNames };
}

/**
 * 执行 LLM 返回的所有工具调用
 *
 * 对 tool_calls 数组逐个执行:
 *   1. 查找 handler — 内置工具 → MCP 工具 → fallback
 *   2. 解析 JSON 参数 — 解析失败时注入错误消息让 LLM 自行修正
 *   3. 执行 handler (await, 支持异步工具)
 *   4. 将结果作为 role:'tool' 消息推入 messages, 供下一轮 LLM 参考
 *
 * 每个工具调用都会通过 SSE 发送日志 (调用参数 + 执行结果), 供前端 FlowGraph 可视化
 *
 * @param toolCalls    LLM 返回的 tool_calls 数组 (可能为 undefined)
 * @param toolHandlers 内置工具 handler 映射表
 * @param mcpToolNames MCP 工具名集合 (命中时走 MCP_MGR.callTool 路由)
 * @param messages     消息数组 — 执行结果原地推入
 * @param reqId        请求 ID, 用于日志
 * @param sendEvent    SSE 事件发送器
 */
export async function executeToolCalls(
    toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
    toolHandlers: Record<string, Function>,
    mcpToolNames: Set<string>,
    messages: any[],
    reqId: string,
    sendEvent: (event: string, data: any) => void
): Promise<void> {
    for (const block of toolCalls || []) {
        if (block.type !== 'function') continue;

        const handler = toolHandlers[block.function.name] ?? (
            mcpToolNames.has(block.function.name)
                ? (kw: Record<string, unknown>) => MCP_MGR.callTool(block.function.name, kw)
                : () => 'Unknown tool'
        );

        let inputArgs: Record<string, any> = {};
        try {
            inputArgs = JSON.parse(block.function.arguments || '{}');
        } catch (e: any) {
            const output = `Error: Failed to parse tool arguments: ${e.message}. Raw: ${(block.function.arguments || '').slice(0, 200)}`;
            sendEvent('log', { msg: `[PARSE_ERROR] ${block.function.name}: ${e.message}`, reqId });
            messages.push({ role: 'tool', tool_call_id: block.id, name: block.function.name, content: output });
            continue;
        }

        sendEvent('log', { msg: `Tool: ${block.function.name} ${JSON.stringify(inputArgs).slice(0, 40)}...`, reqId, toolName: block.function.name, toolArgs: inputArgs });

        const output = await handler(inputArgs);

        sendEvent('log', { msg: `Result: ${String(output).slice(0, 80)}...`, reqId, toolName: block.function.name, toolOutput: String(output).slice(0, 2000) });

        messages.push({ role: 'tool', tool_call_id: block.id, name: block.function.name, content: String(output) });
    }
}
