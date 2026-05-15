/**
 * MCP (Model Context Protocol) Client Manager
 *
 * 管理与外部 MCP Server 的连接，将 MCP 工具桥接到 Agent 的 OpenAI function-calling 体系。
 *
 * 架构:
 *   .mcp.json 配置 → McpManager 读取 → 懒连接 MCP Server (stdio 子进程)
 *   → getTools() 返回 OpenAI 格式工具列表 → callTool() 路由到正确的 server
 *
 * 工具命名: {serverName}_{toolName}，避免与内置工具冲突
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const WORKDIR = process.cwd();
const MCP_CONFIG_FILE = path.join(WORKDIR, '.mcp.json');

/* ── Types ── */

/** .mcp.json 中单个 MCP Server 的配置 */
interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

/** .mcp.json 完整配置结构 */
interface McpConfig {
    mcpServers: Record<string, McpServerConfig>;
}

/** 单个 MCP Server 的连接状态 */
interface McpConnection {
    client: Client;
    transport: StdioClientTransport;
    /** 该 server 暴露的所有工具（含 prefixedName） */
    tools: Array<{
        name: string;          // MCP server 上的原始工具名
        prefixedName: string;  // serverName_toolName，用于 OpenAI 注册
        description: string;
        inputSchema: Record<string, unknown>;
    }>;
    connected: boolean;
    /** 正在连接的 Promise，防止并发重复连接 */
    connecting: Promise<void> | null;
}

/** OpenAI function-calling 格式的工具定义 */
export interface OpenAiTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

/* ── McpManager ── */

export class McpManager {
    private config: McpConfig;
    private connections: Map<string, McpConnection> = new Map();

    constructor() {
        this.config = this._loadConfig();
    }

    /**
     * 读取 .mcp.json 配置文件
     * 支持 env 中的 ${VAR} 环境变量插值
     * 文件不存在时返回空配置（不报错）
     */
    private _loadConfig(): McpConfig {
        try {
            if (!fs.existsSync(MCP_CONFIG_FILE)) {
                return { mcpServers: {} };
            }
            const raw = fs.readFileSync(MCP_CONFIG_FILE, 'utf8');
            const parsed = JSON.parse(raw);

            // 插值 env 中的 ${VAR} 引用
            if (parsed.mcpServers) {
                for (const [, server] of Object.entries(parsed.mcpServers)) {
                    const cfg = server as McpServerConfig;
                    if (cfg.env) {
                        for (const [key, val] of Object.entries(cfg.env)) {
                            if (typeof val === 'string') {
                                cfg.env[key] = val.replace(
                                    /\$\{(\w+)\}/g,
                                    (_, varName) => process.env[varName] || ''
                                );
                            }
                        }
                    }
                }
            }

            return parsed;
        } catch (e) {
            console.error('[McpManager] Failed to load .mcp.json:', e);
            return { mcpServers: {} };
        }
    }

    /**
     * 懒连接到指定 MCP Server
     * - 已连接: 直接返回
     * - 正在连接: 等待现有 Promise
     * - 未连接: 创建新连接
     * 使用 connecting Promise 防止并发请求触发重复连接
     */
    private async _ensureConnected(serverName: string): Promise<McpConnection> {
        const conn = this.connections.get(serverName);
        if (conn?.connected) return conn;

        if (conn?.connecting) {
            await conn.connecting;
            return conn;
        }

        // 首次连接 — 创建连接条目
        const serverConfig = this.config.mcpServers[serverName];
        if (!serverConfig) {
            throw new Error(`MCP server '${serverName}' not found in .mcp.json`);
        }

        const newConn: McpConnection = {
            client: new Client(
                { name: 'learn-cc-space-agent', version: '1.0.0' },
                { capabilities: {} }
            ),
            transport: new StdioClientTransport({
                command: serverConfig.command,
                args: serverConfig.args || [],
                env: { ...process.env, ...serverConfig.env } as Record<string, string>,
            }),
            tools: [],
            connected: false,
            connecting: null,
        };

        this.connections.set(serverName, newConn);

        // 存储 connecting Promise，让并发调用者共享同一个连接过程
        newConn.connecting = this._doConnect(serverName, newConn);
        await newConn.connecting;
        newConn.connecting = null;

        return newConn;
    }

    /**
     * 执行实际连接：connect → listTools（含分页）→ 缓存工具列表
     */
    private async _doConnect(serverName: string, conn: McpConnection): Promise<void> {
        try {
            await conn.client.connect(conn.transport);

            // 列出所有工具（处理分页）
            const allTools: McpConnection['tools'] = [];
            let cursor: string | undefined;
            do {
                const result = await conn.client.listTools({ cursor });
                for (const tool of result.tools) {
                    allTools.push({
                        name: tool.name,
                        prefixedName: `${serverName}_${tool.name}`,
                        description: tool.description || '',
                        inputSchema: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
                    });
                }
                cursor = result.nextCursor;
            } while (cursor);

            conn.tools = allTools;
            conn.connected = true;
            console.error(`[McpManager] Connected to '${serverName}': ${allTools.length} tools loaded`);
        } catch (e) {
            conn.connected = false;
            console.error(`[McpManager] Failed to connect to '${serverName}':`, e);
            throw e;
        }
    }

    /**
     * 获取所有 MCP Server 的工具列表，转换为 OpenAI function-calling 格式
     * 并行连接所有 server，单个失败不影响其他
     * 返回空数组表示无 MCP 工具可用
     */
    async getTools(): Promise<OpenAiTool[]> {
        const serverNames = Object.keys(this.config.mcpServers);
        if (serverNames.length === 0) return [];

        const tools: OpenAiTool[] = [];

        // 并行连接所有 server，单个失败不阻塞
        const results = await Promise.allSettled(
            serverNames.map(name => this._ensureConnected(name))
        );

        for (const result of results) {
            if (result.status === 'fulfilled') {
                for (const tool of result.value.tools) {
                    tools.push({
                        type: 'function',
                        function: {
                            name: tool.prefixedName,
                            description: tool.description,
                            parameters: tool.inputSchema,
                        },
                    });
                }
            }
            // 失败的连接静默跳过 — server 不可用
        }

        return tools;
    }

    /**
     * 调用 MCP 工具
     * 通过 prefixedName (serverName_toolName) 查找所属 server 并分发调用
     * 返回工具执行结果的文本内容
     */
    async callTool(prefixedName: string, args: Record<string, unknown>): Promise<string> {
        // 遍历所有连接，找到拥有该工具的 server
        for (const [, conn] of this.connections) {
            const tool = conn.tools.find(t => t.prefixedName === prefixedName);
            if (tool) {
                try {
                    const result = await conn.client.callTool({
                        name: tool.name,
                        arguments: args,
                    });

                    // 提取文本内容
                    const content = result.content as Array<{ type: string; text?: string }>;
                    if (result.isError) {
                        const errorText = content
                            .filter(b => b.type === 'text')
                            .map(b => b.text)
                            .join('\n');
                        return `MCP tool error: ${errorText}`;
                    }

                    const textContent = content
                        .filter(b => b.type === 'text')
                        .map(b => b.text)
                        .join('\n');

                    return textContent || JSON.stringify(result.content);
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    return `MCP call error: ${msg}`;
                }
            }
        }

        return `Error: MCP tool '${prefixedName}' not found on any connected server`;
    }

    /**
     * 检查是否有配置的 MCP Server
     */
    hasServers(): boolean {
        return Object.keys(this.config.mcpServers).length > 0;
    }

    /**
     * 获取所有连接的状态信息（供诊断/UI 使用）
     */
    getStatus(): Record<string, { connected: boolean; toolCount: number }> {
        const status: Record<string, { connected: boolean; toolCount: number }> = {};
        for (const [name, conn] of this.connections) {
            status[name] = { connected: conn.connected, toolCount: conn.tools.length };
        }
        return status;
    }

    /**
     * 优雅关闭所有 MCP Server 连接
     */
    async closeAll(): Promise<void> {
        const closings: Promise<void>[] = [];
        for (const [name, conn] of this.connections) {
            if (conn.connected) {
                closings.push(
                    conn.client.close().catch(e => {
                        console.error(`[McpManager] Error closing '${name}':`, e);
                    })
                );
            }
        }
        await Promise.allSettled(closings);
        this.connections.clear();
    }
}
