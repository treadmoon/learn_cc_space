# 项目目录结构

## 总览

```
learn_cc_space/
├── src/                    # 源代码
│   ├── app/                # Next.js App Router (页面 + API)
│   ├── components/         # React 组件
│   ├── hooks/              # 自定义 Hooks
│   └── lib/                # 核心库 (Agent 逻辑)
├── docs/                   # 项目文档
├── skills/                 # Agent 技能文件 (SKILL.md)
├── tests/                  # 测试
├── datapipe/               # Python 数据管道 (独立模块)
├── public/                 # 静态资源
│
├── .tasks/                 # [运行时] 持久化任务存储
├── .sessions/              # [运行时] 会话持久化
├── .team/                  # [运行时] 团队协作数据
├── .knowledge/             # [运行时] RAG 知识库
├── .artifacts/             # [运行时] 制品归档
├── .mcp.json               # MCP Server 配置
├── .env                    # 环境变量
│
├── package.json            # 依赖配置
├── tsconfig.json           # TypeScript 配置
├── next.config.ts          # Next.js 配置
├── eslint.config.mjs       # ESLint 配置
├── postcss.config.mjs      # PostCSS 配置
├── AGENTS.md               # Claude Code 项目指令
└── CLAUDE.md               # Claude Code 入口 (引用 AGENTS.md)
```

---

## src/app/ — Next.js App Router

页面路由和 API 端点, 遵循 Next.js App Router 约定。

```
src/app/
├── page.tsx                # 主页面 — 集中式状态管理, SSE 流式对话
├── layout.tsx              # 根布局
├── globals.css             # 全局样式
├── favicon.ico
└── api/
    ├── chat/
    │   ├── route.ts        # POST /api/chat — Agent 核心对话入口
    │   └── abort/
    │       └── route.ts    # POST /api/chat/abort — 中止 Agent 循环
    ├── sessions/
    │   └── route.ts        # CRUD /api/sessions — 会话管理
    ├── state/
    │   └── route.ts        # GET /api/state — 全局状态轮询 (ETag)
    ├── tasks/
    │   └── route.ts        # CRUD /api/tasks — 持久化任务
    └── todos/
        └── route.ts        # GET /api/todos — 待办列表
```

| 文件 | 作用 |
|------|------|
| `page.tsx` | 前端主页面, 管理 SSE 连接、消息状态、会话切换 |
| `api/chat/route.ts` | **Agent 核心** — TOOLS 定义、LLM 调用、工具执行循环、MCP 集成 |
| `api/chat/abort/route.ts` | 中止正在进行的 Agent 循环 (AbortController) |
| `api/sessions/route.ts` | 会话 CRUD — 创建/列表/获取/更新/删除 |
| `api/state/route.ts` | 全局状态端点 — todos/tasks/teammates/bgTasks/cronTasks/artifacts/auditLog/knowledge, ETag 条件请求 |
| `api/tasks/route.ts` | 持久化任务的 REST API |
| `api/todos/route.ts` | 待办列表的只读 API |

---

## src/components/ — React 组件

前端 UI 组件, 按功能分组。

```
src/components/
├── ChatPanel.tsx           # 聊天面板 — 消息列表 + 输入框 + 附件
├── LeftPanel.tsx           # 左侧面板 — 会话列表 + 新建/切换/删除
├── RightPanel.tsx          # 右侧面板 — 状态仪表盘 (todos/tasks/teammates/bgTasks/cronTasks/knowledge)
├── FlowGraph.tsx           # 任务流程图 — React Flow + Dagre 自动布局
├── FlowOverlay.tsx         # 流程图全屏覆盖层
├── TimelineView.tsx        # 时间线视图 — 垂直展示对话历史
├── WorkflowView.tsx        # 工作流视图 — Agent 执行步骤概览
├── Section.tsx             # 通用折叠区块组件
├── i18n.ts                 # 国际化 (中/英文翻译)
│
└── flow-nodes/             # React Flow 自定义节点
    ├── index.ts            # 节点类型注册
    ├── ThinkingNode.tsx    # 思考节点 (蓝色) — LLM 推理中
    ├── ToolNode.tsx        # 工具节点 (紫色) — 工具调用
    ├── ResponseNode.tsx    # 响应节点 (绿色) — 最终输出
    ├── ErrorNode.tsx       # 错误节点 (红色) — 执行失败
    └── RetrievalNode.tsx   # 检索节点 (琥珀色) — RAG 知识召回
```

| 组件 | 作用 |
|------|------|
| `ChatPanel` | 核心交互组件, 处理用户输入、消息渲染、SSE 流式接收 |
| `LeftPanel` | 会话管理侧边栏, 支持新建/切换/删除会话 |
| `RightPanel` | 状态仪表盘, 2s 轮询 /api/state 展示系统状态 |
| `FlowGraph` | 用 React Flow 可视化 Agent 执行步骤, Dagre 自动布局 |
| `TimelineView` | 将对话历史按时间线垂直排列, 区分 user/assistant/tool |
| `i18n` | 支持中/英文切换, 所有 UI 文案集中管理 |

---

## src/hooks/ — 自定义 Hooks

```
src/hooks/
├── useAgentChat.ts         # Agent 对话 Hook — SSE 连接管理、消息收发、状态机
└── useGlobalState.ts       # 全局状态轮询 Hook — 2s 间隔 GET /api/state, ETag 缓存
```

| Hook | 作用 |
|------|------|
| `useAgentChat` | 封装 SSE 流式对话逻辑, 处理 state/log/message/telemetry/done/error 事件 |
| `useGlobalState` | 定时轮询 /api/state, 管理 todos/tasks/teammates/bgTasks 等全局状态 |

---

## src/lib/agent/ — Agent 核心逻辑

Agent 的"后端引擎", 包含工具定义、Manager 单例、RAG 和 MCP。

```
src/lib/agent/
├── tools.ts                # 工具函数实现 (bash/read/write/edit)
├── llm-client.ts           # OpenAI client 单例 (route.ts + subagent.ts 共享)
├── managers.ts             # 所有 Manager 单例定义和注册
├── subagent.ts             # SubAgent 执行引擎 (runAgentLoop + SubAgentRunner)
├── knowledge.ts            # RAG 知识库 — 分块、Embedding、混合检索
└── mcp.ts                  # MCP Client — 连接外部 MCP Server
```

| 文件 | 作用 |
|------|------|
| `tools.ts` | 文件系统工具实现: `runBash`(安全 shell)、`runRead`(读文件)、`runWrite`(原子写入)、`runEdit`(精确替换) |
| `llm-client.ts` | OpenAI SDK 客户端单例 — `client` + `MODEL`, 供 route.ts 和 subagent.ts 共享 |
| `managers.ts` | 12 个 Manager 单例 (Todo/Task/Background/Cron/Skill/MessageBus/Teammate/Worktree/Artifact/Session/Knowledge/MCP) + `microCompact()` 上下文压缩 |
| `subagent.ts` | `runAgentLoop()` 可复用 Agent 循环 + `SubAgentRunner` 子 Agent 生命周期管理 (轮询 inbox → LLM 执行 → 回复) |
| `knowledge.ts` | `KnowledgeManager` — 文本分块、Embedding API 调用、向量+BM25 混合检索 |
| `mcp.ts` | `McpManager` — 读取 .mcp.json、懒连接 MCP Server、工具桥接 |

### tools.ts — 工具函数

| 函数 | 作用 |
|------|------|
| `safePath(p)` | 路径沙箱 — 确保不超出 WORKDIR |
| `runBash(cmd)` | 执行 shell 命令 — 危险命令拦截 + 120s 超时 + 大输出持久化 |
| `runRead(p)` | 读取文件 — 路径安全检查 + 50000 字符截断 |
| `runWrite(p, c)` | 原子写入 — tmp 文件 + rename, 防止写入中断导致文件损坏 |
| `runEdit(p, o, n)` | 精确文本替换 — old_text 必须唯一匹配 |

### managers.ts — Manager 单例

| Manager | 存储 | 说明 |
|---------|------|------|
| `TodoManager` | `.todos.json` | 会话级待办, 最多 20 项, 全量替换 |
| `TaskManager` | `.tasks/task_{id}.json` | 跨会话持久化任务, 支持依赖/审计 |
| `BackgroundManager` | 内存 | 后台 shell 执行, 最多 5 并发, drain 通知 |
| `CronManager` | 内存 | 定时调度, setInterval → BG_MGR |
| `SkillLoader` | `skills/` | 技能文件加载, SKILL.md 格式 |
| `MessageBus` | `.team/inbox/` | 成员间消息, sendInbox + readInbox + 即时唤醒 |
| `TeammateManager` | `.team/config.json` | 团队成员管理 + SubAgentRunner 生命周期 (spawn/wakeRunner/setStatus) |
| `WorktreeManager` | 只读 (git) | Git worktree 列表 |
| `ArtifactManager` | `.artifacts/` | 制品归档, 按任务分目录 |
| `SessionManager` | `.sessions/` | 会话持久化, 完整 messages 存储 |
| `KnowledgeManager` | `.knowledge/` | RAG 知识库, 分块+embedding+检索 |
| `McpManager` | `.mcp.json` | MCP Client, 懒连接外部 Server |

---

## [运行时] 隐藏目录

这些目录在 Agent 运行时自动创建, 存储运行时数据。

```
.tasks/                     # TaskManager 持久化存储
├── task_1.json             # 单个任务 (id/subject/status/owner/blockedBy/blocks)
├── task_2.json
└── audit.jsonl             # 审计日志 (追加写入, 每行一个 JSON)

.sessions/                  # SessionManager 持久化存储
├── {uuid}.json             # 单个会话 (id/title/messages/createdAt/updatedAt)
└── ...

.team/                      # 团队协作数据
├── config.json             # 成员配置 (name/role/status)
└── inbox/
    ├── ws-engineer.jsonl   # 成员收件箱 (破坏性读取)
    └── tester.jsonl

.knowledge/                 # RAG 知识库
├── docs.json               # 文档索引 (source → chunkCount)
└── db/
    └── chunks.json         # 分块数据 (含 embedding 向量)

.artifacts/                 # 制品归档
├── task-1/                 # 按任务分目录
│   ├── _meta.json          # 元信息 (文件列表+大小+时间)
│   └── report.md           # 制品文件
└── shared/                 # 未关联任务的共享制品
```

---

## skills/ — Agent 技能

```
skills/
└── frontend-design/
    └── SKILL.md            # 前端设计技能 (带 YAML frontmatter)
```

技能文件格式:
```markdown
---
name: frontend-design
description: 前端设计指导
---
技能正文 (Markdown, 注入 LLM 上下文)
```

---

## docs/ — 项目文档

```
docs/
├── TECHNICAL_DESIGN.md     # 技术设计文档 — 14 个章节覆盖全部架构
├── WORKFLOW_EXAMPLE.md     # 端到端工作流示例 — 模拟完整任务执行
├── DIRECTORY_STRUCTURE.md  # 本文档 — 项目目录结构说明
└── workflow_example.pptx   # 工作流示例 PPT
```

---

## datapipe/ — Python 数据管道

独立的 Python 模块, 与 Next.js Agent 无直接依赖。

```
datapipe/
├── __init__.py
├── cli.py                  # 命令行入口
├── pipeline.py             # 管道定义
├── transforms.py           # 数据转换
├── utils.py                # 工具函数
└── test_pipeline.py        # 管道测试
```

---

## tests/ — 测试

```
tests/
└── test_pipeline.py        # Python 数据管道测试
```

---

## 配置文件

| 文件 | 作用 |
|------|------|
| `package.json` | Node.js 依赖 + 脚本 (dev/build/start) |
| `tsconfig.json` | TypeScript 编译配置 |
| `next.config.ts` | Next.js 配置 |
| `eslint.config.mjs` | ESLint 代码检查规则 |
| `postcss.config.mjs` | PostCSS (Tailwind CSS) |
| `.mcp.json` | MCP Server 配置 (tavily/filesystem) |
| `.env` | 环境变量 (API Key、模型 ID、Base URL) |
| `config.example.yaml` | 配置示例 |
| `AGENTS.md` | Claude Code 项目指令 |
| `CLAUDE.md` | Claude Code 入口 (引用 AGENTS.md) |
