# Terminal Agent Dashboard — 技术设计文档

## 1. 项目概述

基于 Next.js 16 + React 19 的全栈 AI Agent 控制台。Agent 具备 bash 执行、文件操作、任务管理、后台进程、定时调度、RAG 知识召回等能力，UI 提供实时流式可视化展示 Agent 的推理和工具执行过程。

---

## 2. 系统架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Browser (Client)                            │
│  ┌───────────┐  ┌──────────────────────────┐  ┌──────────────────┐ │
│  │ LeftPanel  │  │       ChatPanel          │  │   RightPanel     │ │
│  │ ·Todos     │  │ ·FlowGraph (overlay)     │  │ ·Telemetry       │ │
│  │ ·Tasks     │  │ ·Messages (markdown)     │  │ ·Teammates       │ │
│  │ ·Artifacts │  │ ·Slash commands          │  │ ·Processes       │ │
│  │ ·Worktrees │  │ ·Attachments             │  │ ·Daemons         │ │
│  └───────────┘  │ ·Session selector         │  │ ·Knowledge stats │ │
│                  └───────────┬──────────────┘  │ ·Flow/Logs/Time  │ │
│                              │                  └──────────────────┘ │
│                    SSE stream│  2s polling                           │
├──────────────────────────────┼──────────────────────────────────────┤
│                         Next.js Server                              │
│  ┌───────────────────────────▼──────────────────────────────────┐  │
│  │                    POST /api/chat                             │  │
│  │              Agent Loop (max 15 iterations)                   │  │
│  │  ┌─────────┐  ┌──────────┐  ┌────────────┐  ┌────────────┐ │  │
│  │  │compact()│→ │ LLM call │→ │ tool exec  │→ │ SSE events │ │  │
│  │  └─────────┘  └──────────┘  └─────┬──────┘  └────────────┘ │  │
│  └────────────────────────────────────┼─────────────────────────┘  │
│                                       │                             │
│  ┌────────────────────────────────────▼─────────────────────────┐  │
│  │                     Tool System (19 tools)                    │  │
│  │  ┌──────┐ ┌────────┐ ┌──────┐ ┌────────┐ ┌───────────────┐ │  │
│  │  │ bash │ │ r/w/e  │ │ todo │ │ task   │ │ knowledge     │ │  │
│  │  │      │ │ file   │ │      │ │ mgr    │ │ ingest/search │ │  │
│  │  └──────┘ └────────┘ └──────┘ └────────┘ └───────────────┘ │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                   Manager Singletons                          │  │
│  │  TODO · TASK_MGR · BG_MGR · CRON_MGR · SKILLS · BUS         │  │
│  │  TEAM_MGR · WORKTREE_MGR · ARTIFACT_MGR · SESSION_MGR        │  │
│  │  KNOWLEDGE_MGR                                                │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                   File-based Storage                          │  │
│  │  .todos.json · .tasks/ · .sessions/ · .knowledge/            │  │
│  │  .artifacts/ · .team/ · skills/                               │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 组件层级

```
RootLayout
  └── Home (page.tsx) — 集中式状态管理
        ├── LeftPanel
        │     ├── Section: Worktrees
        │     ├── Section: Todos
        │     ├── Section: Tasks (创建/过滤/状态控制)
        │     └── Section: Artifacts
        ├── ChatPanel
        │     ├── FlowGraph (absolute overlay, agent 活跃时显示)
        │     │     ├── ThinkingNode    — 紫色圆角矩形
        │     │     ├── ToolNode        — 多形状(矩形/菱形/六边形/平行四边形)
        │     │     ├── ResponseNode    — 绿色胶囊形
        │     │     ├── ErrorNode       — 红色虚线矩形
        │     │     └── RetrievalNode   — 琥珀色虚线(RAG)
        │     ├── Session selector
        │     ├── Message list (ReactMarkdown)
        │     ├── Slash command menu (/clear /new /compress /tasks /help)
        │     └── Input area (textarea + 文件拖拽)
        └── RightPanel
              ├── Telemetry metrics
              ├── Section: Teammates
              ├── Section: Active Processes
              ├── Section: Daemons
              ├── Section: Audit Log
              ├── Section: Knowledge Base
              └── Tabbed: Flow | Logs | Timeline
```

**响应式**: 左右面板在移动端变为滑出抽屉 (`hidden md:flex` / `hidden lg:flex`)。

---

## 4. 数据流: 端到端请求生命周期

```
用户输入消息
  → ChatPanel.handleSend()
    → POST /api/chat { message, history, attachments }
      → SSE 流开启
        → Agent 循环 (最多 15 轮):
            1. microCompact() 压缩旧工具结果
            2. BG_MGR.drain() 注入后台任务通知
            3. LLM 调用 (带重试: 429/500/503 → 指数退避)
            4. 发送 SSE 事件: state → log → message → telemetry
            5. 若 tool_calls: 执行工具 → 推入结果 → 继续循环
            6. 若文本回复: 跳出循环
        → SSE 'done' 事件
      → 流关闭
    → 客户端解析 SSE, 更新 messages/logs/status/telemetry
    → PATCH /api/sessions 自动保存会话
  → 2 秒轮询 GET /api/state 更新 globalState
```

### SSE 协议

| 事件 | 数据 | 说明 |
|------|------|------|
| `state` | `{ status: "thinking" \| "executing_tools" }` | Agent 状态变化 |
| `log` | `{ msg, reqId, toolName?, toolArgs?, toolOutput? }` | 工具执行日志 |
| `message` | `{ role: "assistant", content }` | Assistant 文本内容 |
| `telemetry` | `{ total_tokens, prompt_tokens, completion_tokens }` | Token 用量 |
| `done` | `{ status: "finished", reqId }` | 流完成 |
| `error` | `{ message }` | 致命错误 |

---

## 5. Agent 工具系统

### 5.1 架构总览

工具系统由三层构成: **声明层** (TOOLS) → **路由层** (toolHandlers + MCP) → **执行层** (Manager/函数)

```
┌─────────────────────────────────────────────────────────────────┐
│  声明层: TOOLS 数组 (OpenAI function-calling 格式)              │
│  告诉 LLM "你有哪些工具可用", 含 name / description / parameters │
└───────────────────────────┬─────────────────────────────────────┘
                            │ LLM 返回 tool_calls
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  路由层: createToolHandlers() + loadMcpTools()                  │
│  按 tool name 查找 handler:                                     │
│    内置工具 → toolHandlers[name] (静态映射)                      │
│    MCP 工具 → MCP_MGR.callTool(name, args) (动态路由)           │
└───────────────────────────┬─────────────────────────────────────┘
                            │ handler(args)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  执行层: Manager 单例 / 独立函数                                 │
│  runBash(), KNOWLEDGE_MGR.search(), TASK_MGR.create() ...      │
│  返回 string 结果 → 注入 messages → 下一轮 LLM 参考             │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 工具声明: TOOLS 数组

每个工具遵循 OpenAI function-calling 规范:

```typescript
// src/app/api/chat/route.ts — TOOLS 数组
{
    type: 'function' as const,
    function: {
        name: 'knowledge_search',                              // 唯一标识, 用于路由分派
        description: 'Semantic search over the knowledge base', // 告诉 LLM 何时使用
        parameters: {                                          // JSON Schema, LLM 按此生成参数
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
                top_k: { type: 'number', description: 'Number of results (default 5)' }
            },
            required: ['query']
        }
    }
}
```

`description` 是 LLM 决策的关键 — 写得越精确, LLM 选工具越准确。

### 5.3 工具路由: createToolHandlers() 工厂

`createToolHandlers(messages, reqId)` 是模块级工厂函数, 返回 `Record<string, Function>` 映射表。

为什么用工厂而非静态对象? 因为有两个 handler 需要请求级参数:

| handler | 需要的参数 | 原因 |
|---------|-----------|------|
| `compress` | `messages` | 原地压缩当前对话的 messages 数组 |
| `task_create` | `reqId` | 写入审计日志时标记请求来源 |

```typescript
// 模块级定义 — 不依赖任何闭包变量
function createToolHandlers(messages: any[], reqId: string): Record<string, Function> {
    return {
        bash:       (kw) => runBash(kw.command),
        read_file:  (kw) => runRead(kw.path),
        // ... 其余 17 个纯静态委托
        compress:   ()  => compressMessages(messages),       // ← 需要 messages
        task_create:(kw) => TASK_MGR.create(kw.subject, '', 'agent', { reqId }), // ← 需要 reqId
    };
}

// 请求入口内调用 — 注入当前请求的 messages 和 reqId
const toolHandlers = createToolHandlers(messages, reqId);
```

### 5.4 工具执行: executeToolCalls() 函数

LLM 返回 `tool_calls` 后, `executeToolCalls()` 逐个执行:

```
for each block in tool_calls:
  ① 查找 handler — 内置 → MCP → fallback
  ② 解析 JSON 参数 — 失败则注入错误消息, 跳过执行
  ③ await handler(args) — 支持异步工具
  ④ 结果推入 messages — 供下一轮 LLM 参考
```

```typescript
// src/app/api/chat/route.ts
async function executeToolCalls(
    toolCalls,      // LLM 返回的 tool_calls 数组
    toolHandlers,   // 内置 handler 映射
    mcpToolNames,   // MCP 工具名集合
    messages,       // 结果注入目标
    reqId,          // 日志标记
    sendEvent       // SSE 推送
): Promise<void>
```

关键设计:
- 参数解析失败不抛异常, 而是注入错误文本让 LLM 自行修正
- 每个工具调用都通过 SSE 推送日志, 前端 FlowGraph 实时可视化
- `await` 支持异步工具 (如 `knowledge_ingest` 需要调用 Embedding API)

### 5.5 MCP 工具动态加载

除内置 19 个工具外, 还可通过 `.mcp.json` 配置 MCP Server, 动态注入外部工具:

```typescript
// src/app/api/chat/route.ts — loadMcpTools()
const { activeTools, mcpToolNames } = await loadMcpTools(TOOLS, reqId, sendEvent);
// activeTools = [...内置工具, ...MCP工具]
// mcpToolNames = Set<string> — 用于执行时判断走哪条路由
```

```
.mcp.json 配置
    ↓
McpManager.getTools() — 懒连接 MCP Server, 获取工具列表
    ↓
转换为 OpenAI function-calling 格式 (name 加 server 前缀)
    ↓
合并到 activeTools — LLM 同时看到内置 + MCP 工具
```

工具执行时的路由判断:

```typescript
const handler = toolHandlers[name] ?? (
    mcpToolNames.has(name)
        ? (kw) => MCP_MGR.callTool(name, kw)   // MCP 路由
        : () => 'Unknown tool'                   // fallback
);
```

### 5.6 工具清单 (19 个内置 + MCP 动态)

| 工具 | 类型 | 说明 |
|------|------|------|
| `bash` | 文件系统 | 执行 shell 命令, 120s 超时, 危险命令拦截 |
| `read_file` | 文件系统 | 读取文件, 截断 50000 字符 |
| `write_file` | 文件系统 | 原子写入 (tmp + rename) |
| `edit_file` | 文件系统 | 精确文本替换 |
| `TodoWrite` | 任务 | 更新待办列表 (最多 20 项) |
| `load_skill` | 知识 | 加载 Skill markdown 文件 |
| `compress` | 上下文 | 压缩对话历史, 保留最近 4 条 |
| `background_run` | 后台 | 后台执行命令 (最多 5 并发) |
| `check_background` | 后台 | 检查后台任务状态 |
| `task_create` | 任务 | 创建持久化任务 |
| `task_get` | 任务 | 获取任务详情 |
| `task_update` | 任务 | 更新状态/依赖 |
| `task_list` | 任务 | 列出所有任务 |
| `cron_schedule` | 定时 | 创建定时任务 |
| `cron_remove` | 定时 | 移除定时任务 |
| `artifact_save` | 制品 | 保存文件为任务制品 |
| `knowledge_ingest` | RAG | 导入文件/文本到知识库 |
| `knowledge_search` | RAG | 语义搜索知识库 |
| MCP 动态工具 | 外部 | `.mcp.json` 配置的 MCP Server 提供 |

### 5.7 安全机制

- `safePath()`: 路径沙箱, 防止目录穿越
- `BLOCKED_PATTERNS`: 拦截 `rm -rf /`, `sudo`, 反向 shell, fork bomb 等
- 大输出持久化到 `.task_outputs/tool-results/`, 避免撑爆 context

### 5.8 典型工具示例

#### 示例 1: `bash` — 纯委托型

最简单的模式: LLM 生成参数 → 直接委托给独立函数。

```typescript
// 声明 (TOOLS 数组)
{
    type: 'function',
    function: {
        name: 'bash',
        description: 'Run bash command.',
        parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command']
        }
    }
}

// 路由 (toolHandlers)
bash: (kw) => runBash(kw.command)

// 执行 (src/lib/agent/tools.ts)
export function runBash(command: string): string {
    // 安全检查 → execSync → 截断输出 → 返回 string
}
```

LLM 调用流程:
```
LLM → tool_calls: [{ function: { name: 'bash', arguments: '{"command":"ls -la"}' } }]
    → executeToolCalls() 解析 JSON → toolHandlers['bash']({ command: 'ls -la' })
    → runBash('ls -la') → "total 48\ndrwxr-xr-x  ..."
    → messages.push({ role: 'tool', content: 'total 48\n...' })
    → LLM 读取结果, 继续推理
```

#### 示例 2: `knowledge_search` — 异步 RAG 型

涉及外部 API 调用 (Embedding), 需要 `async/await`:

```typescript
// 路由 (toolHandlers)
knowledge_search: async (kw) => await KNOWLEDGE_MGR.search(kw.query, kw.top_k)
```

执行流程 (5 步混合检索):
```
① Embed query → 1536 维向量 (调用 Embedding API)
② 遍历 chunks 计算余弦相似度 (向量匹配)
③ BM25 关键词评分 (精确匹配)
④ 归一化 + 加权融合 (0.7×向量 + 0.3×BM25)
⑤ 排序取 topK, 格式化返回
```

结果示例:
```
Found 3 relevant chunks:

[Result 1] (score: 0.892) source: docs/api.md#2
The authentication flow uses JWT tokens...

---

[Result 2] (score: 0.754) source: README.md#0
Setup requires setting ANTHROPIC_API_KEY...
```

#### 示例 3: `compress` — 闭包依赖型

唯一需要捕获 `messages` 引用的工具 — 原地修改对话历史:

```typescript
// 路由 (toolHandlers) — messages 来自 createToolHandlers 参数
compress: () => compressMessages(messages)
```

压缩策略:
```
保留最近 4 条 user/assistant 消息
旧消息替换为 [Context compressed: removed N messages]
工具结果 (role:tool) 全部保留 (后续步骤可能依赖)
```

#### 示例 4: MCP 工具 — 动态路由型

MCP 工具不在 `toolHandlers` 中注册, 而是通过 `mcpToolNames` 集合动态分派:

```typescript
// .mcp.json
{ "mcpServers": { "tavily": { "command": "npx", "args": ["-y", "tavily-mcp"] } } }

// McpManager 连接后, 工具自动注册:
// tavily_tavily-search → MCP_MGR.callTool('tavily_tavily-search', args)
// tavily_tavily-extract → MCP_MGR.callTool('tavily_tavily-extract', args)
```

路由判断:
```typescript
// executeToolCalls() 中
const handler = toolHandlers[name] ?? (
    mcpToolNames.has(name)
        ? (kw) => MCP_MGR.callTool(name, kw)   // ← MCP 路由
        : () => 'Unknown tool'
);
```

MCP 工具对 LLM 来说与内置工具无异 — 同样的 `tool_calls` 格式, 同样的结果注入。

---

## 6. Manager 单例模式

所有 Manager 通过全局对象实现单例, 避免 Next.js HMR 丢失状态:

```typescript
const globalForAgent = global as unknown as { TODO: TodoManager; /* ... */ };
export const TODO = globalForAgent.TODO || new TodoManager();
if (process.env.NODE_ENV !== 'production') {
    globalForAgent.TODO = TODO;
}
```

### Manager 清单

| Manager | 存储 | 职责 |
|---------|------|------|
| `TodoManager` | `.todos.json` | 短期待办, 最多 20 项, 1 个 in_progress |
| `TaskManager` | `.tasks/task_{id}.json` + `audit.jsonl` | 持久化任务, 支持依赖 (blockedBy/blocks), 审计日志 |
| `BackgroundManager` | 内存 | 后台 shell 命令, 最多 5 并发, 通知队列 |
| `CronManager` | 内存 | 定时调度, 委托 BG_MGR 执行 |
| `SkillLoader` | `skills/*/SKILL.md` | 加载 YAML frontmatter 的 Skill 文件 |
| `MessageBus` | `.team/inbox/*.jsonl` | Agent 间消息传递 |
| `TeammateManager` | `.team/config.json` | 团队成员管理 |
| `WorktreeManager` | Git 状态 | 列出 git worktree |
| `ArtifactManager` | `.artifacts/` | 保存/列出任务制品 |
| `SessionManager` | `.sessions/*.json` | 会话 CRUD |
| `KnowledgeManager` | `.knowledge/` | RAG 管道 (见下文) |

### 上下文压缩

`microCompact()` 在每轮循环中执行:
- 保留最近 3 条工具结果
- 旧结果替换为 `[Previous: used {toolName}]`
- `read_file` 结果永不压缩

### TaskManager: 存储与审计

TaskManager 是最复杂的 Manager, 提供跨会话的持久化任务管理, 支持依赖关系和审计追踪。

#### 存储结构

```
.tasks/
├── task_1.json          # 任务 1
├── task_2.json          # 任务 2
├── task_3.json          # 任务 3
└── audit.jsonl          # 审计日志 (所有任务共享)
```

每个任务是一个独立的 JSON 文件, 文件名即 ID (`task_{id}.json`)。
ID 自增: 扫描目录中已有文件取最大值 +1, 无需额外的计数器文件。

#### 任务数据结构

```json
// .tasks/task_1.json
{
    "id": 1,
    "subject": "实现 WebSocket 推送",
    "description": "为 Agent 添加实时状态推送能力",
    "status": "pending",
    "owner": null,
    "blockedBy": [2],
    "blocks": [3, 4]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | number | 自增 ID, 文件名决定 |
| `subject` | string | 任务主题 (必填, 简短) |
| `description` | string | 任务详情 (可选) |
| `status` | string | pending → in_progress → completed / deleted |
| `owner` | string/null | 认领者 (子 Agent 名称, 如 'ws-engineer') |
| `blockedBy` | number[] | 上游依赖: 这些任务完成后才能开始本任务 |
| `blocks` | number[] | 下游依赖: 本任务完成后解锁这些任务 |

#### 状态机

```
                    ┌──────────┐
                    │ pending  │ ← 初始状态
                    └────┬─────┘
                         │ claim()
                         ▼
                   ┌─────────────┐
                   │ in_progress │
                   └──┬──────┬───┘
                      │      │
            update()  │      │  update()
                      ▼      ▼
              ┌──────────┐  ┌─────────┐
              │completed │  │ deleted │ ← 物理删除文件
              └──────────┘  └─────────┘
```

#### 依赖关系: blockedBy / blocks

依赖关系是双向的, 但从语义上理解只需关注一个方向:

```
任务 A: blocks: [B, C]      ← A 完成后解锁 B 和 C
任务 B: blockedBy: [A]      ← B 需要等 A 完成才能开始
任务 C: blockedBy: [A]      ← C 需要等 A 完成才能开始
```

**completed 时的自动解锁:**

当任务 A 被标记为 completed 时, TaskManager 遍历所有任务文件:
```
for each task in .tasks/:
    if task.blockedBy contains A.id:
        task.blockedBy.remove(A.id)   ← 自动解锁
        save(task)
```

这确保下游任务的 blockedBy 在上游完成后自动清空, 无需手动维护。

#### 审计日志

审计日志 `.tasks/audit.jsonl` 是追加写入的 JSONL 文件, 每行一个 JSON 记录:

```jsonl
{"ts":"2026-05-15T10:00:00Z","action":"create","taskId":1,"actor":"agent","details":{"subject":"实现 WebSocket"}}
{"ts":"2026-05-15T10:01:00Z","action":"claim","taskId":1,"actor":"agent","details":{"owner":"ws-engineer"}}
{"ts":"2026-05-15T10:05:00Z","action":"update","taskId":1,"actor":"ws-engineer","details":{"status":"in_progress"}}
{"ts":"2026-05-15T10:10:00Z","action":"update","taskId":1,"actor":"ws-engineer","details":{"addBlockedBy":[2]}}
{"ts":"2026-05-15T10:30:00Z","action":"update","taskId":1,"actor":"agent","details":{"status":"completed"}}
{"ts":"2026-05-15T10:31:00Z","action":"delete","taskId":2,"actor":"agent","details":{}}
```

| action | 触发时机 | 写入内容 |
|--------|---------|---------|
| `create` | `create()` | subject + 自定义 meta (如 reqId) |
| `claim` | `claim()` | owner 名称 |
| `update` | `update()` | status 变更 或 addBlockedBy/addBlocks 变更 |
| `delete` | `update(status='deleted')` | 仅 taskId (文件已物理删除) |

**审计日志的特性:**
- 追加写入 (appendFileSync), 永不覆盖
- 即使任务被 delete, 审计记录仍然保留 (可追溯)
- 供前端 RightPanel "审计日志" 区域展示 (通过 /api/state 的 auditLog 字段)

#### CRUD 操作流程

**Create — 创建任务:**
```
LLM 调用 task_create(subject, description)
  → TaskManager.create()
  → _nextId() 扫描目录取最大 ID +1
  → _save() 写入 .tasks/task_{id}.json
  → _audit('create') 追加审计记录
  → 返回 JSON 字符串
```

**Read — 读取任务:**
```
LLM 调用 task_get(task_id)
  → TaskManager.get(tid)
  → _load() 读取 .tasks/task_{tid}.json
  → 返回 JSON 字符串

前端轮询 /api/state
  → TaskManager.listAllStructured(filter)
  → 读取所有 task_*.json → 过滤 → 返回结构化数组
```

**Update — 更新任务:**
```
LLM 调用 task_update(task_id, status, add_blocked_by, add_blocks)
  → TaskManager.update()
  → _load() 读取现有任务
  → 更新 status / 合并依赖 (Set 去重)
  → 若 status='completed': 遍历所有任务, 从 blockedBy 中移除本任务
  → 若 status='deleted': 物理删除文件, 记录审计, 提前返回
  → _save() 写回文件
  → _audit('update') 追加审计记录
  → 返回 JSON 字符串
```

**Claim — 认领任务:**
```
主 Agent 调用 task_update(task_id) 或 TaskManager.claim(tid, owner)
  → 设置 owner + status = 'in_progress'
  → _save() + _audit('claim')
  → 返回确认消息
```

#### 与 TodoManager 的对比

| 维度 | TodoManager | TaskManager |
|------|-------------|-------------|
| 生命周期 | 会话级 (切换会话后清空) | 跨会话 (文件持久化) |
| 存储 | `.todos.json` (单文件全量) | `.tasks/task_{id}.json` (多文件独立) |
| ID | 无 ID (全量替换) | 自增 ID (文件名) |
| 依赖关系 | 无 | blockedBy / blocks |
| 审计 | 无 | audit.jsonl (追加写入) |
| 更新方式 | 全量覆盖 | 增量更新 (单字段) |
| 使用场景 | 轻量任务清单 (20 项内) | 复杂任务编排 (依赖/分配/追踪) |

---

## 7. RAG 知识召回管道

### 7.1 架构

```
导入流程:
  File/Text → chunkText() → _embed() → ChunkRecord[] → .knowledge/db/chunks.json

检索流程:
  Query → _embed() → cosineSim + bm25Score → 混合排序 → top-K 结果
```

### 7.2 分块策略

```
┌─────────────────────────────────────────┐
│ 原始文档                                │
│                                         │
│ 段落1\n\n段落2\n\n段落3\n\n段落4         │
│                                         │
│ ↓ 按双换行分割                           │
│                                         │
│ [段落1] [段落2] [段落3] [段落4]           │
│                                         │
│ ↓ 合并短段落 (≤500字符) + 重叠窗口(50字符) │
│                                         │
│ [Chunk1: 段落1+段落2]                    │
│ [Chunk2: 段落2尾+段落3]                  │
│ [Chunk3: 段落3尾+段落4]                  │
└─────────────────────────────────────────┘
```

- 按段落 (双换行) 分割
- 短段落合并, 长段落按句子拆分
- 相邻 chunk 保留 50 字符重叠

### 7.3 混合检索

```
┌──────────┐     ┌──────────┐
│  Query   │     │  Query   │
└────┬─────┘     └────┬─────┘
     │                │
     ▼                ▼
┌──────────┐     ┌──────────┐
│ Embedding│     │ Tokenize │
│ (API)    │     │ (本地)   │
└────┬─────┘     └────┬─────┘
     │                │
     ▼                ▼
┌──────────┐     ┌──────────┐
│ Cosine   │     │  BM25    │
│ Similarity│    │ Scoring  │
│ (向量)   │     │ (关键词) │
└────┬─────┘     └────┬─────┘
     │                │
     ▼                ▼
┌─────────────────────────────┐
│  Score Fusion               │
│  0.7 × vector + 0.3 × BM25 │
└─────────────┬───────────────┘
              │
              ▼
        ┌──────────┐
        │  Top-K   │
        │ Results  │
        └──────────┘
```

- **向量检索**: 余弦相似度, 归一化到 [0,1]
- **BM25 关键词**: k1=1.5, b=0.75, 支持 CJK 分词
- **融合权重**: 向量 0.7 + BM25 0.3
- **返回**: top-K 结果 + 来源 + 分数

---

## 8. 后台任务系统

### 8.1 架构概览

后台任务系统允许 Agent 异步执行长时间运行的 shell 命令，不阻塞主对话流。

```
┌──────────────────────────────────────────────────────────────────┐
│                    BackgroundManager (内存)                       │
│                                                                  │
│  tasks: Record<tid, { status, command, result }>                 │
│  notifications: Array<{ task_id, status, result }>               │
│  maxConcurrent: 5                                                │
│                                                                  │
│  ┌─────────┐    ┌──────────┐    ┌───────────┐                   │
│  │  run()  │───▶│  exec()  │───▶│ callback  │                   │
│  │ 创建任务 │    │ 子进程   │    │ 更新状态  │                   │
│  └─────────┘    └──────────┘    └─────┬─────┘                   │
│                                       │                          │
│                                       ▼                          │
│                              ┌────────────────┐                  │
│                              │  notifications  │                  │
│                              │     .push()     │                  │
│                              └───────┬────────┘                  │
│                                      │                           │
│                          ┌───────────┴───────────┐               │
│                          ▼                       ▼               │
│                   ┌────────────┐          ┌────────────┐         │
│                   │ drain() ×1 │          │ drain() ×2 │         │
│                   │ Agent 循环 │          │ /api/state │         │
│                   └────────────┘          └────────────┘         │
└──────────────────────────────────────────────────────────────────┘
```

### 8.2 任务生命周期

```
background_run(command)
    │
    ├── 并发检查: running tasks >= 5? → 拒绝
    │
    ├── 生成 tid = randomUUID().slice(0, 8)
    │
    ├── tasks[tid] = { status: 'running', command, result: null }
    │
    └── exec(command, { cwd, timeout, shell })
          │
          ├── 成功 → status: 'completed', result: stdout+stderr
          │
          ├── 错误 → status: 'error', result: error.message
          │
          └── 超时 → status: 'timeout', result: stdout+stderr
          │
          └──→ notifications.push({ task_id, status, result })
```

### 8.3 通知 Drain 机制

#### 什么是 drain？

后台任务通过 `child_process.exec` 异步执行，主 Agent 循环不会等待它完成。那任务完成后，结果怎么送达？答案是 **drain 通知队列**。

`drain()` 的语义是"排空"——取出队列中所有通知（拷贝），然后**立即清空**队列。取一次就没了，不会重复消费。

```
后台任务完成 → push 到 notifications[] → 等待消费者 drain()
                                           ↓
                                    取出 + 清空队列
```

#### 为什么不用发布/订阅？

这个场景足够简单：
- 通知是**一次性的**（任务完成就完了，不需要重放）
- 消费者数量固定（2 个：Agent 循环 + State API）
- 不需要 topic/subscription 抽象

一个数组 + `drain()` 就是最小够用的方案。

#### 两个消费者

通知采用**一次性消费**模式，`drain()` 取出所有待处理通知后立即清空队列。

```
两个消费者 (竞争关系):

┌─────────────────────────────────────────────────┐
│ 消费者 1: Agent 循环 (route.ts)                  │
│                                                 │
│ 每轮 LLM 迭代前调用 drain()                      │
│ 注入为合成 user 消息:                            │
│ <background-results>                            │
│   [bg:a1b2c3d4] completed: output...            │
│ </background-results>                           │
│ → LLM 可见，可据此继续推理                       │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ 消费者 2: State API (/api/state)                 │
│                                                 │
│ ETag 计算后调用 drain()                          │
│ 通知作为 bgNotifs 字段返回给客户端               │
│ 304 响应仅在 ETag 匹配且无通知时返回             │
│ → UI 渲染为 assistant 消息                       │
└─────────────────────────────────────────────────┘

执行顺序:
  Agent 活跃时 → Agent 循环先 drain (LLM 消费)
  Agent 空闲时 → State API drain (UI 消费)
```

### 8.4 与 CronManager 的集成

CronManager 内部委托 BG_MGR 执行定时命令:

```
CronManager.schedule(name, command, intervalMs)
    │
    └── setInterval(() => {
            BG_MGR.run(command, 120)  // 每次 tick 创建一个后台任务
        }, intervalMs)
```

定时任务的结果与普通后台任务共享同一套通知/drain 管道。

### 8.5 工具定义

| 工具 | 参数 | 说明 |
|------|------|------|
| `background_run` | `command: string, timeout?: int` | 后台执行命令, 120s 默认超时 |
| `check_background` | `task_id?: string` | 查询指定任务或列出所有任务 |
| `cron_schedule` | `name, command, interval_ms` | 创建定时任务 |
| `cron_remove` | `name` | 移除定时任务 |

### 8.6 UI 展示

| 区域 | 数据源 | 内容 |
|------|--------|------|
| RightPanel "活跃进程" | `bgTasks` (2s 轮询) | 运行中的后台任务, 自动展开 |
| RightPanel "驻留调度" | `cronTasks` (2s 轮询) | 定时任务列表, 显示间隔和执行次数 |
| ChatPanel 消息列表 | `bgNotifs` (drain 结果) | 完成的后台任务作为 assistant 消息 |

---

## 9. 团队协作系统

### 9.1 架构概览

团队协作系统提供多 Agent 协同工作的基础设施, 包括成员管理和消息传递。

```
┌─────────────────────────────────────────────────────────────┐
│                      .team/ 目录结构                         │
│                                                             │
│  .team/                                                     │
│  ├── config.json          ← 团队成员配置                    │
│  └── inbox/                                                │
│      ├── researcher.jsonl ← 各成员收件箱 (JSONL)            │
│      ├── coder.jsonl                                        │
│      └── reviewer.jsonl                                     │
└─────────────────────────────────────────────────────────────┘
```

### 9.2 TeammateManager

管理团队成员的注册、状态和生命周期。

```typescript
interface TeamMember {
    name: string;     // 成员唯一标识
    role: string;     // 职责描述 (如 "researcher", "coder")
    status: string;   // 'working' | 'idle' | 其他自定义状态
}

interface TeamConfig {
    team_name: string;
    members: TeamMember[];
}
```

**核心方法:**

| 方法 | 说明 |
|------|------|
| `spawn(name, role)` | 创建或唤醒成员, 状态设为 `working` |
| `setStatus(name, status)` | 更新成员状态 |
| `listAll()` | 返回所有成员列表 |

**存储**: `.team/config.json` (原子写入)

### 9.3 MessageBus

基于文件的 Agent 间消息传递系统。

```
发送方 (外部进程/其他 Agent)
    │
    │  直接写入 JSONL 文件
    ▼
.team/inbox/{name}.jsonl
    │
    │  readInbox(name)
    ▼
接收方 Agent
    │
    └── 破坏性读取: 读后清空文件
        (fire-and-forget 语义)
```

**消息格式** (每行一个 JSON):
```json
{ "from": "researcher", "to": "coder", "content": "...", "ts": "..." }
```

### 9.4 当前状态

当前团队协作系统已实现:
- ✅ TeammateManager 单例注册 + SubAgentRunner 生命周期管理
- ✅ MessageBus 基础设施 (sendInbox + readInbox + 即时唤醒)
- ✅ 5 个 LLM 工具注册 (spawn_teammate / list_teammates / set_teammate_status / send_message / read_inbox)
- ✅ SubAgentRunner 独立执行引擎 (后台 LLM 循环)
- ✅ UI 展示 (RightPanel 成员列表 + 状态指示器)
- ✅ /api/state 暴露 teammates 数据

---

## 10. 子任务 (Subagent) 系统

### 10.1 概述

子任务系统让主 Agent 可以派生子 Agent 执行独立任务。每个子 Agent 拥有独立的 LLM 上下文、工具集和后台执行循环, 通过 MessageBus 与主 Agent 通信。

```
┌──────────────────────────────────────────────────────────┐
│                   主 Agent (route.ts)                      │
│                                                          │
│  1. 分析任务 → 拆解为子任务                               │
│  2. spawn_teammate("researcher", "搜索相关文档")          │
│  3. send_message({to:"researcher", content:"搜索..."})   │
│  4. 继续处理其他工作...                                   │
│  5. read_inbox({name:"agent"}) → 收集子 Agent 结果       │
│  6. 综合结果 → 生成最终回复                               │
└──────────────────────────────────────────────────────────┘
        │                    │
        ▼                    ▼
┌──────────────┐    ┌──────────────┐
│  SubAgentRunner│    │ SubAgentRunner│
│  researcher   │    │  coder        │
│              │    │              │
│ · 独立 LLM   │    │ · 独立 LLM   │
│ · 独立上下文  │    │ · 独立上下文  │
│ · 全量工具集  │    │ · 全量工具集  │
│ · 后台循环    │    │ · 后台循环    │
└──────────────┘    └──────────────┘
```

### 10.2 文件结构

| 文件 | 职责 |
|------|------|
| `src/lib/agent/subagent.ts` | SubAgentRunner 类 + runAgentLoop() |
| `src/lib/agent/llm-client.ts` | OpenAI client 单例 (共享) |
| `src/lib/agent/managers.ts` | TeammateManager (生命周期) + MessageBus (通信) |
| `src/app/api/chat/route.ts` | 5 个 LLM 工具注册 |

### 10.3 执行引擎: runAgentLoop()

从 route.ts 提取的可复用 Agent 循环, 供主 Agent 和子 Agent 共享:

```typescript
// src/lib/agent/subagent.ts
export async function runAgentLoop(params: {
    messages: any[];          // 初始消息 (原地修改)
    systemPrompt: string;     // 系统提示词
    tools: any[];             // 可用工具
    toolHandlers: Record<string, Function>;  // 工具处理器
    maxLoops?: number;        // 最大循环次数 (默认 10)
    onLog?: (msg: string) => void;          // 日志回调
}): Promise<any[]>
```

循环逻辑 (与 route.ts 主循环相同):
```
for (loop 0..maxLoops):
    1. microCompact(messages) — 压缩旧工具结果
    2. LLM call (client.chat.completions.create)
    3. push assistant message
    4. if finish_reason !== 'tool_calls' → break
    5. 执行 tool_calls → push tool results
return messages
```

### 10.4 SubAgentRunner 生命周期

```typescript
// src/lib/agent/subagent.ts
export class SubAgentRunner {
    constructor(name: string, role: string)
    start(): void    // 启动后台循环 (非阻塞)
    stop(): void     // 停止循环
    wake(): void     // 唤醒轮询 (即时响应)
}
```

内部循环 (`_loop()`):
```
while (running):
    1. 检查 TeammateManager 中 status, 如果 'idle' → 退出
    2. BUS.readInbox(name) — 破坏性读取收件箱
    3. 有消息 → 构建 messages → runAgentLoop() → 结果发回主 Agent
    4. 无消息 → 等待 wake() 或 5s 超时后再次轮询
    5. 连续 60s 无消息 → 自动 setStatus('idle') 并退出
```

### 10.5 完整数据流

```
主 Agent 调用 spawn_teammate("tester", "测试工程师")
    │
    ├── TeammateManager.spawn()
    │     ├── 写入 .team/config.json {name, role, status:'working'}
    │     ├── new SubAgentRunner("tester", "测试工程师")
    │     └── runner.start() → 启动后台 _loop()
    │
    ▼
主 Agent 调用 send_message({to:"tester", content:"测试登录模块"})
    │
    ├── MessageBus.sendInbox()
    │     ├── 写入 .team/inbox/tester.jsonl
    │     └── TEAM_MGR.wakeRunner("tester") → 即时唤醒
    │
    ▼
SubAgentRunner._loop() 被唤醒
    │
    ├── BUS.readInbox("tester") → 读取任务
    ├── 构建 messages [{role:'user', content:'测试登录模块'}]
    ├── runAgentLoop()
    │     ├── system prompt (基于角色定制)
    │     ├── LLM 调用 → 工具执行 → 结果注入 (最多 10 轮)
    │     └── 提取最终 assistant 回复
    │
    ├── BUS.sendInbox("tester", "agent", "测试结果: ...")
    │     └── 写入 .team/inbox/agent.jsonl
    │
    ▼
主 Agent 调用 read_inbox({name:"agent"})
    │
    ├── MessageBus.readInbox("agent") → 读取并清空
    └── 返回子 Agent 的执行结果

主 Agent 调用 set_teammate_status({name:"tester", status:"idle"})
    │
    ├── TeammateManager.setStatus()
    │     ├── 更新 .team/config.json → status:'idle'
    │     └── runner.stop() → 终止后台循环
    └── 子 Agent 生命周期结束
```

### 10.6 LLM 工具注册

route.ts 中注册的 5 个团队协作工具:

| 工具 | 参数 | Handler |
|------|------|---------|
| `spawn_teammate` | `name`, `role` | `TEAM_MGR.spawn()` → 写 config + 启动 SubAgentRunner |
| `list_teammates` | 无 | `TEAM_MGR.listAll()` → 返回成员列表 |
| `set_teammate_status` | `name`, `status` | `TEAM_MGR.setStatus()` → 更新状态 + 停止 runner |
| `send_message` | `to`, `content` | `BUS.sendInbox()` → 写 inbox + 唤醒 runner |
| `read_inbox` | `name` | `BUS.readInbox()` → 破坏性读取收件箱 |

### 10.7 子 Agent 工具集

子 Agent 继承主 Agent 的全量工具, **排除团队协作工具** (防止递归创建子 Agent):

| 类别 | 工具 |
|------|------|
| 文件系统 | `bash`, `read_file`, `write_file`, `edit_file` |
| 待办 | `TodoWrite` |
| 知识技能 | `load_skill` |
| 后台任务 | `background_run`, `check_background` |
| 持久化任务 | `task_create`, `task_get`, `task_update`, `task_list` |
| 定时调度 | `cron_schedule`, `cron_remove` |
| 制品 | `artifact_save` |
| RAG 知识库 | `knowledge_ingest`, `knowledge_search` |

### 10.8 与直接工具调用的区别

| 维度 | 直接工具调用 | 子任务模式 |
|------|------------|-----------|
| 上下文 | 共享主 Agent 上下文 | 独立上下文, 不互相干扰 |
| LLM 调用 | 主 Agent 的 LLM 循环 | 子 Agent 独立的 LLM 循环 |
| 并行 | 串行执行 | 可并行执行多个子任务 |
| 上下文窗口 | 占用主 Agent 窗口 | 独立窗口, 结果按需注入 |
| 通信 | 直接返回 | MessageBus 异步消息 |
| 适用场景 | 简单操作 | 复杂、独立、可并行的任务 |

### 10.9 通信机制: MessageBus

```
.team/inbox/
├── agent.jsonl      # 主 Agent 收件箱 (子 Agent 的回复)
├── tester.jsonl     # tester 收件箱 (主 Agent 的任务)
└── researcher.jsonl # researcher 收件箱
```

消息格式 (每行一个 JSON):
```json
{"from":"agent","content":"测试登录模块","timestamp":"2026-05-18T10:00:00Z"}
```

关键特性:
- **破坏性读取**: readInbox() 读取后清空文件 (fire-and-forget)
- **即时唤醒**: sendInbox() 后自动调用 wakeRunner(), 无需等待 5s 轮询
- **无重试**: 消息丢失不恢复 (适用于一次性任务结果传递)

### 10.10 UI 表现

子 Agent 在 RightPanel "在线协作智能体" 区域显示:

```
┌─ 在线协作智能体 ──────────────────┐
│ ● researcher  ← 绿色闪烁 (working) │
│ ○ coder       ← 灰色 (idle)        │
│                                    │
│ 悬浮提示:                          │
│  ┌──────────────────┐              │
│  │ researcher       │              │
│  │ working          │              │
│  └──────────────────┘              │
└────────────────────────────────────┘
```

---

## 11. 可视化系统

### 11.1 FlowGraph (React Flow + Dagre)

流程图覆盖层, 将 Agent 执行过程可视化为有向图:

```
节点类型:
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ┌─────────┐     ┌─────────┐     ┌─────────┐          │
│  │ 思考    │────▶│ 工具    │────▶│ 回复    │          │
│  │ Stadium │     │ 多形状  │     │ Pill    │          │
│  │ #818CF8 │     │ 按类型  │     │ #34D399 │          │
│  └─────────┘     └─────────┘     └─────────┘          │
│                                                         │
│  工具节点形状:                                           │
│  ┌──────────┐  ◇──────────◇  ⬡──────────⬡  ╱────────╲ │
│  │ 文件操作  │  │ 任务操作  │  │ 后台任务  │  │ Shell   ││
│  │ 矩形     │  │ 菱形      │  │ 六边形    │  │ 平行四边││
│  │ #38BDF8  │  │ #FBBF24   │  │ #818CF8   │  │ #2DD4BF ││
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘│
│                                                         │
│  特殊节点:                                               │
│  ┌─ ─ ─ ─ ─ ─ ─┐  ┌──────────────────┐                │
│  │ RAG 检索     │  │ 错误             │                │
│  │ 虚线琥珀色   │  │ 虚线红色         │                │
│  │ #FBBF24      │  │ #F87171          │                │
│  └─ ─ ─ ─ ─ ─ ─┘  └──────────────────┘                │
└─────────────────────────────────────────────────────────┘
```

### 11.2 数据转换管道

```
LogEntry[]
  → groupByRequest()        // 按 reqId 分组
  → parseLogsToSteps()      // 状态机解析为 WorkflowStep[]
  → stepsToFlow()           // 转换为 React Flow nodes + edges
  → layoutNodes()           // Dagre 自动布局 (TB, nodesep:80, ranksep:70)
  → ReactFlow 渲染
```

### 11.3 边样式

| 状态 | 样式 |
|------|------|
| 完成 | 实线, 颜色跟随目标节点 |
| 运行中 | 虚线 + 流动动画 |
| 错误 | 红色虚线 |

### 11.4 生命周期

- Agent 活跃时自动展开
- Agent 空闲 5 秒后自动最小化为浮动 pill
- Pill 显示进度 (completed/total) + 进度条
- 点击 pill 重新展开
- 支持缩放/平移/MiniMap

---

## 12. 状态管理

### 12.1 集中式状态 (page.tsx)

```
┌─────────────────────────────────────────────┐
│  Home (page.tsx) — useState                  │
│                                             │
│  messages: Message[]     ← 聊天消息          │
│  logs: LogEntry[]        ← Agent 执行日志    │
│  status: AgentStatus     ← idle/thinking/exec│
│  globalState:                              │
│    ├── todos[]           ← 短期待办          │
│    ├── tasks[]           ← 持久化任务        │
│    ├── teammates[]       ← 协作 Agent        │
│    ├── worktrees         ← Git worktree     │
│    ├── bgTasks[]         ← 后台任务          │
│    ├── cronTasks[]       ← 定时任务          │
│    ├── artifacts[]       ← 制品              │
│    ├── auditLog[]        ← 审计日志          │
│    └── knowledge         ← 知识库状态        │
│  telemetry:              ← Token 用量        │
│  sessions: SessionSummary[] ← 会话列表       │
│  currentSessionId        ← 当前会话          │
│  lang: 'zh' | 'en'      ← 语言              │
└─────────────────────────────────────────────┘
```

### 12.2 同步机制

- **SSE 流**: 实时更新 messages, logs, status, telemetry
- **2 秒轮询**: GET /api/state + ETag 条件请求 → 更新 globalState
- **messagesRef**: useRef 同步 messages, 解决流式循环中 useEffect 异步问题
- **后台通知**: BG_MGR.drain() 在每次轮询和循环迭代中消费

---

## 13. 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Next.js 16.2.4 (App Router, Turbopack) |
| UI | React 19.2.4, Tailwind CSS 4, Lucide Icons |
| 图表 | @xyflow/react 12, @dagrejs/dagre 3 |
| LLM | OpenAI SDK (兼容 Anthropic/火山引擎 Ark) |
| Markdown | react-markdown + remark-gfm |
| 存储 | 文件系统 (JSON), 无数据库 |
| 部署 | Node.js runtime |

---

## 14. 设计模式总结

| 模式 | 应用 |
|------|------|
| 全局单例 | Manager 类通过 global 对象存活 HMR |
| ETag 轮询 | /api/state 条件请求, 减少带宽 |
| 原子写入 | tmp + rename 防止崩溃损坏 |
| 沙箱安全 | safePath() 防目录穿越, BLOCKED_PATTERNS 拦截危险命令 |
| 上下文压缩 | microCompact() + compressMessages() 双层压缩 |
| 混合检索 | 向量 + BM25 融合排序 |
| 自动布局 | Dagre DAG 算法计算节点位置 |
| 双可视化 | FlowGraph (图) + FlowOverlay (时间线) |
