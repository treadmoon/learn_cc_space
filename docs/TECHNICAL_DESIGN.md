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

### 5.1 工具注册模式

```typescript
// route.ts — TOOLS 数组
{ type: 'function', function: { name: 'tool_name', description: '...', parameters: { ... } } }

// route.ts — toolHandlers 映射
tool_name: (kw: any) => MANAGER.method(kw.arg1, kw.arg2)
```

### 5.2 工具清单 (19 个)

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

### 5.3 安全机制

- `safePath()`: 路径沙箱, 防止目录穿越
- `BLOCKED_PATTERNS`: 拦截 `rm -rf /`, `sudo`, 反向 shell, fork bomb 等
- 大输出持久化到 `.task_outputs/tool-results/`, 避免撑爆 context

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

### 9.4 当前状态与扩展

当前团队协作系统已实现:
- ✅ TeammateManager 单例注册
- ✅ MessageBus 基础设施
- ✅ UI 展示 (RightPanel 成员列表 + 状态指示器)
- ✅ /api/state 暴露 teammates 数据

待扩展 (工具未接线):
- ⬜ `team_spawn` 工具 — Agent 通过工具调用创建子 Agent
- ⬜ `team_message` 工具 — Agent 间发送消息
- ⬜ `team_read_inbox` 工具 — 读取收件箱消息

---

## 10. 子任务 (Subagent) 系统

### 10.1 概述

子任务系统基于 TeammateManager + MessageBus 构建, 实现主 Agent 派生子 Agent 执行专项任务的模式。

```
┌──────────────────────────────────────────────────────────┐
│                   主 Agent (Lead)                         │
│                                                          │
│  1. 分析任务 → 拆解为子任务                               │
│  2. team_spawn("researcher", "搜索相关文档")              │
│  3. team_spawn("coder", "实现核心逻辑")                   │
│  4. 继续处理其他工作...                                   │
│  5. team_read_inbox() → 收集子 Agent 结果                 │
│  6. 综合结果 → 生成最终回复                               │
└──────────────────────────────────────────────────────────┘
        │                    │
        ▼                    ▼
┌──────────────┐    ┌──────────────┐
│  子 Agent 1   │    │  子 Agent 2   │
│  researcher   │    │  coder        │
│              │    │              │
│ · 独立上下文  │    │ · 独立上下文  │
│ · 专用工具集  │    │ · 专用工具集  │
│ · 结果写入    │    │ · 结果写入    │
│   inbox      │    │   inbox      │
└──────────────┘    └──────────────┘
```

### 10.2 数据流

```
主 Agent 调用 team_spawn(name, role)
    │
    ├── TeammateManager.spawn() → 注册成员, status: 'working'
    │
    ├── 启动独立 Agent 会话 (独立 messages 上下文)
    │
    └── 子 Agent 执行任务
          │
          ├── 使用工具 (bash, file, knowledge 等)
          │
          ├── 完成后写入结果到 .team/inbox/{name}.jsonl
          │
          └── TeammateManager.setStatus(name, 'idle')
                │
                ▼
主 Agent 调用 team_read_inbox()
    │
    ├── MessageBus.readInbox(name) → 读取并清空
    │
    └── 将结果注入对话上下文 → 继续推理
```

### 10.3 与直接工具调用的区别

| 维度 | 直接工具调用 | 子任务模式 |
|------|------------|-----------|
| 上下文 | 共享主 Agent 上下文 | 独立上下文, 不互相干扰 |
| 并行 | 串行执行 | 可并行执行多个子任务 |
| 上下文窗口 | 占用主 Agent 窗口 | 独立窗口, 结果按需注入 |
| 适用场景 | 简单操作 | 复杂、独立、可并行的任务 |

### 10.4 UI 表现

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
