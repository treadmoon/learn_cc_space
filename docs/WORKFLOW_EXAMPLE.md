# 端到端工作流示例 — 完整任务模拟

## 场景设定

> **用户指令**: "帮我为这个项目实现一个 WebSocket 实时推送功能，替代当前的 2 秒轮询机制。需要：1) 参考现有的 SSE 实现；2) 后端 WebSocket 服务端；3) 前端 Hook；4) 编写测试；5) 跑通构建。"

此场景将演示以下全部系统协同工作:

```
RAG 知识召回 → 持久化任务 → 子任务派生 → 团队协作
→ 后台任务 → 定时调度 → 文件操作 → 工具调用链
```

---

## 完整执行流程

### Phase 1: 知识召回 + 任务规划

#### Step 1.1 — RAG 检索现有 SSE 实现

Agent 首先检索知识库，了解当前项目的 SSE 实现模式。

```
┌─────────────────────────────────────────────────────────────┐
│  LLM 推理: "用户要替代轮询，我需要先了解现有 SSE 实现"        │
│                                                             │
│  → 调用 knowledge_search                                    │
│    { query: "SSE streaming real-time polling mechanism" }    │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  KnowledgeManager.search("SSE streaming ...", 5)            │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Step 1: Embed Query                                 │    │
│  │                                                     │    │
│  │   _embed(["SSE streaming real-time polling ..."])   │    │
│  │     │                                               │    │
│  │     └─▶ client.embeddings.create({                  │    │
│  │           model: "text-embedding-v3",               │    │
│  │           input: ["SSE streaming ..."]              │    │
│  │         })                                          │    │
│  │     │                                               │    │
│  │     └─▶ queryEmbedding = [0.12, -0.34, 0.56, ...]  │    │
│  │         (1536 维浮点向量)                            │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Step 2: 向量余弦相似度 (语义匹配)                    │    │
│  │                                                     │    │
│  │   遍历全部 chunks (假设 N=50 个分块):                │    │
│  │                                                     │    │
│  │   chunk[0].embedding = [0.11, -0.33, 0.55, ...]    │    │
│  │   cosineSim(queryEmbedding, chunk[0].embedding)     │    │
│  │     = dot(a,b) / (||a|| × ||b||)                    │    │
│  │     = 0.94                                          │    │
│  │                                                     │    │
│  │   chunk[1].embedding = [0.02, 0.88, -0.12, ...]    │    │
│  │   cosineSim(queryEmbedding, chunk[1].embedding)     │    │
│  │     = 0.31                                          │    │
│  │                                                     │    │
│  │   ... 对每个 chunk 计算 ...                          │    │
│  │                                                     │    │
│  │   vectorScores = [0.94, 0.31, 0.87, 0.72, 0.65, ...]│   │
│  │   (每个 chunk 一个相似度分数)                        │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Step 3: BM25 关键词评分 (精确匹配)                   │    │
│  │                                                     │    │
│  │   3a. tokenize(query)                               │    │
│  │       "SSE streaming real-time polling mechanism"   │    │
│  │       → ["sse", "streaming", "real", "time",        │    │
│  │          "polling", "mechanism"]                     │    │
│  │       (小写, 按非字母数字分割, 过滤 ≤1 字符)         │    │
│  │                                                     │    │
│  │   3b. 对每个 chunk 的 content 做同样的 tokenize     │    │
│  │       chunk[0] → ["sse", "流", "开启", "agent", ...] │   │
│  │       chunk[1] → ["eventsource", "监听", "事件", ...]│   │
│  │                                                     │    │
│  │   3c. 计算 BM25 公式:                               │    │
│  │       对 query 中每个词 qt:                          │    │
│  │         IDF(qt) = log((N - df + 0.5)/(df + 0.5) + 1)│   │
│  │         TF_norm = tf×(k1+1) / (tf + k1×(1-b+b×dl/avgdl))│
│  │         score += IDF × TF_norm                      │    │
│  │       其中 k1=1.5, b=0.75                           │    │
│  │                                                     │    │
│  │   bm25Scores = [3.21, 0.45, 2.87, 1.93, 2.15, ...] │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Step 4: 归一化 + 分数融合                            │    │
│  │                                                     │    │
│  │   4a. 归一化到 [0, 1]:                              │    │
│  │       maxVec = max(vectorScores) = 0.94             │    │
│  │       maxBm25 = max(bm25Scores) = 3.21              │    │
│  │                                                     │    │
│  │       vectorScores[i] / maxVec → [1.0, 0.33, 0.93, ...] │
│  │       bm25Scores[i]  / maxBm25 → [1.0, 0.14, 0.89, ...]│
│  │                                                     │    │
│  │   4b. 加权融合 (向量 0.7 + BM25 0.3):               │    │
│  │       combined[i] = 0.7 × (vec[i]/maxVec)           │    │
│  │                   + 0.3 × (bm25[i]/maxBm25)         │    │
│  │                                                     │    │
│  │       chunk[0]: 0.7×1.00 + 0.3×1.00 = 1.000        │    │
│  │       chunk[1]: 0.7×0.33 + 0.3×0.14 = 0.273        │    │
│  │       chunk[2]: 0.7×0.93 + 0.3×0.89 = 0.916        │    │
│  │       ...                                           │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Step 5: 排序取 Top-K + 格式化输出                    │    │
│  │                                                     │    │
│  │   5a. 按 combined score 降序排序                     │    │
│  │       [(idx:0, 1.000), (idx:2, 0.916), ...]        │    │
│  │                                                     │    │
│  │   5b. 取前 topK=5 个                                │    │
│  │                                                     │    │
│  │   5c. 过滤: top[0].score < 0.01 ?                   │    │
│  │       → 是: 返回 "No relevant results found"        │    │
│  │       → 否: 格式化输出                               │    │
│  │                                                     │    │
│  │   5d. 输出:                                         │    │
│  │       "Found 5 relevant chunks:\n\n                 │    │
│  │        [Result 1] (score: 1.000)                    │    │
│  │          source: src/app/api/chat/route.ts#0        │    │
│  │          content: ...                               │    │
│  │        ---\n                                        │    │
│  │        [Result 2] (score: 0.916)                    │    │
│  │          source: src/components/ChatPanel.tsx#2      │    │
│  │          content: ..."                              │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  返回结果:                                                   │
│                                                             │
│  [1] src/app/api/chat/route.ts (score: 0.92)                │
│      "SSE 流开启 → Agent 循环 → sendEvent('state', ...)     │
│       → sendEvent('log', ...) → sendEvent('done', ...)"     │
│                                                             │
│  [2] src/components/ChatPanel.tsx (score: 0.87)              │
│      "EventSource 监听 SSE 事件, 解析 state/log/message"     │
│                                                             │
│  [3] docs/TECHNICAL_DESIGN.md (score: 0.81)                 │
│      "SSE 协议: state | log | message | telemetry | done"   │
│                                                             │
│  [4] src/app/api/state/route.ts (score: 0.76)               │
│      "ETag 轮询, 2 秒间隔, 条件请求 304"                     │
│                                                             │
│  [5] src/app/page.tsx (score: 0.71)                         │
│      "useEffect setInterval 2s, fetch /api/state"           │
└─────────────────────────────────────────────────────────────┘
```

#### Step 1.2 — 创建持久化任务体系

基于检索结果，Agent 创建任务并设置依赖关系。

```
┌─────────────────────────────────────────────────────────────┐
│  调用 task_create × 5                                        │
└─────────────────────────────────────────────────────────────┘

任务 #1: WebSocket 服务端实现
├── subject: "实现 WebSocket 服务端"
├── description: "基于 ws 库，创建 /api/ws 路由，广播状态变更"
├── status: pending
├── blockedBy: []
└── blocks: [2, 3]

任务 #2: 前端 useWebSocket Hook
├── subject: "实现 useWebSocket Hook"
├── description: "替代 setInterval 轮询，监听 WS 消息更新 globalState"
├── status: pending
├── blockedBy: [1]
└── blocks: [4]

任务 #3: 测试编写
├── subject: "编写 WebSocket 单元测试"
├── description: "ws 服务端测试 + Hook 测试"
├── status: pending
├── blockedBy: [1]
└── blocks: [5]

任务 #4: 集成替换
├── subject: "替换轮询为 WebSocket"
├── description: "移除 setInterval，接入 useWebSocket"
├── status: pending
├── blockedBy: [1, 2]
└── blocks: [5]

任务 #5: 构建验证
├── subject: "pnpm build 验证"
├── description: "确保 TypeScript 编译通过，无类型错误"
├── status: pending
├── blockedBy: [3, 4]
└── blocks: []
```

**任务依赖图:**

```
          ┌─────────────────────┐
          │  #1 WS 服务端实现    │
          └──────┬──────┬───────┘
                 │      │
          ┌──────▼──┐ ┌─▼──────────┐
          │ #2 Hook │ │ #3 测试编写 │
          └────┬────┘ └─────┬──────┘
               │            │
          ┌────▼────────────▼──────┐
          │  #4 集成替换轮询        │
          └───────────┬────────────┘
                      │
              ┌───────▼────────┐
              │  #5 构建验证    │
              └────────────────┘
```

#### Step 1.3 — 更新 TodoList

```
┌─────────────────────────────────────────────────────────────┐
│  调用 TodoWrite                                              │
│  { todos: [                                                  │
│    { id: 1, content: "WebSocket 功能实现", status: "in_progress" },│
│    { id: 2, content: "参考 SSE 模式设计 WS 协议", status: "pending" }│
│  ]}                                                          │
└─────────────────────────────────────────────────────────────┘
```

---

### Phase 2: 子任务派生 + 团队协作

Agent 决定将任务 #1 (WS 服务端) 和任务 #3 (测试) 并行派发给子 Agent。

#### Step 2.1 — 派生子 Agent

```
┌─────────────────────────────────────────────────────────────┐
│  调用 bash (读取现有 SSE 代码供子 Agent 参考)                  │
│  $ cat src/app/api/chat/route.ts | head -50                  │
│                                                             │
│  输出: SSE 路由结构、sendEvent 函数、Agent 循环...             │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  TeammateManager.spawn("ws-engineer", "WebSocket 服务端开发") │
│                                                             │
│  .team/config.json 更新:                                     │
│  {                                                           │
│    "team_name": "default",                                   │
│    "members": [                                              │
│      { "name": "ws-engineer", "role": "WS 服务端开发",        │
│        "status": "working" }                                 │
│    ]                                                         │
│  }                                                           │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  TeammateManager.spawn("tester", "测试工程师")                │
│                                                             │
│  .team/config.json 更新:                                     │
│  {                                                           │
│    "team_name": "default",                                   │
│    "members": [                                              │
│      { "name": "ws-engineer", "role": "WS 服务端开发",        │
│        "status": "working" },                                │
│      { "name": "tester", "role": "测试工程师",                │
│        "status": "working" }                                 │
│    ]                                                         │
│  }                                                           │
└─────────────────────────────────────────────────────────────┘
```

#### Step 2.2 — 子 Agent: ws-engineer 执行

```
┌─────────────────────────────────────────────────────────────┐
│  子 Agent: ws-engineer (独立上下文窗口)                       │
│                                                             │
│  收到任务: "基于 ws 库实现 WebSocket 服务端，参考 SSE 模式"    │
└─────────────────────────────────────────────────────────────┘
         │
         ├── 调用 read_file
         │   读取 src/app/api/chat/route.ts
         │   了解 SSE sendEvent 模式
         │
         ├── 调用 knowledge_search
         │   { query: "WebSocket ws library Node.js setup" }
         │   → 返回 ws 库 API 文档片段
         │
         ├── 调用 write_file
         │   创建 src/app/api/ws/route.ts
         │   ┌─────────────────────────────────────────────┐
         │   │ import { WebSocketServer } from 'ws';       │
         │   │ import { BG_MGR, TODO, TASK_MGR, ... }      │
         │   │   from '@/lib/agent/managers';               │
         │   │                                             │
         │   │ // WebSocket 广播器                           │
         │   │ class WSBroadcaster { ... }                  │
         │   │                                             │
         │   │ // 升级 HTTP → WebSocket                     │
         │   │ export async function GET(req) { ... }       │
         │   └─────────────────────────────────────────────┘
         │
         ├── 调用 bash
         │   $ pnpm add ws
         │   → 安装 ws 依赖
         │
         ├── 调用 write_file
         │   创建 src/lib/ws-broadcaster.ts
         │   (独立的广播器模块，供 state 变更时调用)
         │
         └── 写入结果到收件箱
             .team/inbox/ws-engineer.jsonl
             ┌─────────────────────────────────────────────┐
             │ {"from":"ws-engineer","to":"lead",           │
             │  "content":"WebSocket 服务端已完成。          │
             │  创建了 src/app/api/ws/route.ts 和           │
             │  src/lib/ws-broadcaster.ts。                  │
             │  已安装 ws 依赖。支持多客户端连接和状态广播。", │
             │  "ts":"2026-05-13T09:15:00Z"}                │
             └─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  TeammateManager.setStatus("ws-engineer", "idle")           │
└─────────────────────────────────────────────────────────────┘
```

#### Step 2.3 — 子 Agent: tester 执行 (并行)

```
┌─────────────────────────────────────────────────────────────┐
│  子 Agent: tester (独立上下文窗口)                            │
│                                                             │
│  收到任务: "为 WebSocket 模块编写单元测试"                     │
└─────────────────────────────────────────────────────────────┘
         │
         ├── 调用 read_file
         │   读取已有测试模式: tests/ 或 __tests__/ 目录
         │
         ├── 调用 bash
         │   $ ls src/**/*.test.ts 2>/dev/null || echo "no tests"
         │   → 了解项目测试结构
         │
         ├── 调用 write_file
         │   创建 src/lib/__tests__/ws-broadcaster.test.ts
         │   ┌─────────────────────────────────────────────┐
         │   │ import { describe, it, expect, vi } from    │
         │   │   'vitest';                                  │
         │   │ import { WSBroadcaster } from                │
         │   │   '../ws-broadcaster';                       │
         │   │                                             │
         │   │ describe('WSBroadcaster', () => {            │
         │   │   it('should broadcast to all clients');     │
         │   │   it('should handle client disconnect');     │
         │   │   it('should serialize JSON messages');      │
         │   │ });                                         │
         │   └─────────────────────────────────────────────┘
         │
         ├── 调用 write_file
         │   创建 src/hooks/__tests__/useWebSocket.test.ts
         │
         └── 写入结果到收件箱
             .team/inbox/tester.jsonl
             ┌─────────────────────────────────────────────┐
             │ {"from":"tester","to":"lead",                │
             │  "content":"测试文件已创建:                    │
             │  ws-broadcaster.test.ts (3 cases)            │
             │  useWebSocket.test.ts (4 cases)。            │
             │  等待实现代码就绪后运行。",                     │
             │  "ts":"2026-05-13T09:18:00Z"}                │
             └─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  TeammateManager.setStatus("tester", "idle")               │
└─────────────────────────────────────────────────────────────┘
```

#### Step 2.4 — 主 Agent 收集子任务结果

```
┌─────────────────────────────────────────────────────────────┐
│  主 Agent 推理: "两个子 Agent 应该完成了，收集结果"            │
└─────────────────────────────────────────────────────────────┘
         │
         ├── 调用 read_file (读取收件箱)
         │   .team/inbox/ws-engineer.jsonl
         │   → "WebSocket 服务端已完成..."
         │
         ├── 调用 read_file (读取收件箱)
         │   .team/inbox/tester.jsonl
         │   → "测试文件已创建..."
         │
         ├── 调用 task_update
         │   task_update({ id: 1, status: "completed" })
         │   task_update({ id: 3, status: "completed" })
         │
         └── 调用 task_update
             task_update({ id: 2, status: "in_progress" })
             → 开始实现 useWebSocket Hook (任务 #2 被解锁)
```

---

### Phase 3: 后台任务 + 定时调度

#### Step 3.1 — 后台运行测试

```
┌─────────────────────────────────────────────────────────────┐
│  Agent 推理: "测试代码已就绪，后台运行测试避免阻塞"            │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  调用 background_run                                         │
│  {                                                           │
│    command: "cd /project && pnpm test -- --run",             │
│    timeout: 180                                              │
│  }                                                           │
│                                                             │
│  BG_MGR.run() 执行:                                         │
│  ├── 并发检查: 0/5 running → 通过                            │
│  ├── tid = "a1b2c3d4"                                       │
│  ├── tasks["a1b2c3d4"] = {                                  │
│  │     status: "running",                                    │
│  │     command: "pnpm test -- --run",                        │
│  │     result: null                                          │
│  │   }                                                       │
│  └── exec("pnpm test -- --run") → 子进程启动                 │
│                                                             │
│  返回: "Background task a1b2c3d4 started: pnpm test -- --run"│
└─────────────────────────────────────────────────────────────┘
```

#### Step 3.2 — Agent 继续工作 (不等待测试)

```
┌─────────────────────────────────────────────────────────────┐
│  Agent 推理: "测试在后台跑着，我继续实现 useWebSocket Hook"    │
└─────────────────────────────────────────────────────────────┘
         │
         ├── 调用 read_file
         │   src/app/page.tsx → 了解当前轮询逻辑
         │
         ├── 调用 write_file
         │   创建 src/hooks/useWebSocket.ts
         │   ┌─────────────────────────────────────────────┐
         │   │ 'use client';                               │
         │   │ import { useEffect, useRef, useCallback }   │
         │   │   from 'react';                             │
         │   │                                             │
         │   │ export function useWebSocket(                │
         │   │   onMessage: (data: any) => void             │
         │   │ ) {                                          │
         │   │   const wsRef = useRef<WebSocket | null>();  │
         │   │                                             │
         │   │   useEffect(() => {                          │
         │   │     const ws = new WebSocket(                │
         │   │       `ws://${location.host}/api/ws`         │
         │   │     );                                       │
         │   │     ws.onmessage = (e) => {                  │
         │   │       onMessage(JSON.parse(e.data));         │
         │   │     };                                       │
         │   │     wsRef.current = ws;                      │
         │   │     return () => ws.close();                  │
         │   │   }, []);                                    │
         │   │ }                                            │
         │   └─────────────────────────────────────────────┘
         │
         └── 调用 task_update
             task_update({ id: 2, status: "completed" })
```

#### Step 3.3 — 后台测试完成，通知注入

```
测试子进程执行完成...

┌─────────────────────────────────────────────────────────────┐
│  BG_MGR callback 触发:                                      │
│                                                             │
│  tasks["a1b2c3d4"] = {                                      │
│    status: "completed",                                      │
│    command: "pnpm test -- --run",                            │
│    result: "✓ ws-broadcaster (3 tests) 12ms\n               │
│             ✓ useWebSocket (4 tests) 8ms\n                   │
│             Tests: 7 passed, 0 failed"                       │
│  }                                                           │
│                                                             │
│  notifications.push({                                        │
│    task_id: "a1b2c3d4",                                      │
│    status: "completed",                                      │
│    result: "7 passed, 0 failed (截断到 500 字符)"             │
│  })                                                          │
└─────────────────────────────────────────────────────────────┘
```

**消费者 1 — Agent 循环 drain (如果 Agent 仍在运行):**

```
┌─────────────────────────────────────────────────────────────┐
│  Agent 循环第 N 轮开始:                                      │
│                                                             │
│  const notifs = BG_MGR.drain();                             │
│  // notifs = [{ task_id: "a1b2c3d4", status: "completed",   │
│  //             result: "7 passed, 0 failed" }]             │
│                                                             │
│  → 注入合成消息到 messages:                                   │
│  {                                                           │
│    role: "user",                                             │
│    content: "<background-results>\n                          │
│              [bg:a1b2c3d4] completed: 7 passed, 0 failed\n   │
│              </background-results>"                          │
│  }                                                           │
│                                                             │
│  → LLM 看到测试通过，继续下一步                               │
└─────────────────────────────────────────────────────────────┘
```

**消费者 2 — State API drain (如果 Agent 空闲):**

```
┌─────────────────────────────────────────────────────────────┐
│  GET /api/state (2s 轮询)                                    │
│                                                             │
│  ETag 计算后 → BG_MGR.drain()                               │
│  → bgNotifs = [{ task_id: "a1b2c3d4", ... }]                │
│  → 返回给客户端                                              │
│                                                             │
│  page.tsx 处理:                                              │
│  if (data.bgNotifs?.length) {                                │
│    setMessages(prev => [...prev, ...data.bgNotifs.map(n => ({│
│      id: msgId(),                                            │
│      role: 'assistant',                                      │
│      content: `[BACKGROUND TASK: ${n.task_id}]               │
│                Status: ${n.status}\nOutput:\n${n.result}`    │
│    }))]);                                                    │
│  }                                                           │
│                                                             │
│  → ChatPanel 显示:                                           │
│  ┌──────────────────────────────────────────┐               │
│  │ 🤖 [BACKGROUND TASK: a1b2c3d4]           │               │
│  │ Status: completed                         │               │
│  │ Output:                                   │               │
│  │ ✓ ws-broadcaster (3 tests) 12ms           │               │
│  │ ✓ useWebSocket (4 tests) 8ms              │               │
│  │ Tests: 7 passed, 0 failed                 │               │
│  └──────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────┘
```

#### Step 3.4 — 设置定时健康检查

```
┌─────────────────────────────────────────────────────────────┐
│  Agent 推理: "设置定时任务监控 WebSocket 连接健康状态"         │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  调用 cron_schedule                                         │
│  {                                                           │
│    name: "ws-health-check",                                  │
│    command: "curl -s -o /dev/null -w '%{http_code}'          │
│              http://localhost:3000/api/ws || echo 'DOWN'",   │
│    interval_ms: 30000                                        │
│  }                                                           │
│                                                             │
│  CRON_MGR.schedule() 执行:                                   │
│  ├── cronTasks["ws-health-check"] = {                        │
│  │     command: "curl ...",                                  │
│  │     intervalMs: 30000,                                    │
│  │     lastRun: null,                                        │
│  │     count: 0                                              │
│  │   }                                                       │
│  └── setInterval(() => {                                     │
│        BG_MGR.run("curl ...", 120);  // 委托 BG_MGR         │
│        cronTasks[...].count++;                               │
│        cronTasks[...].lastRun = new Date().toISOString();    │
│      }, 30000)                                               │
│                                                             │
│  返回: "Cron job 'ws-health-check' scheduled every 30000ms"  │
└─────────────────────────────────────────────────────────────┘
```

**Cron 执行流 (每 30 秒):**

```
setInterval 触发
    │
    ▼
BG_MGR.run("curl ...", 120)
    │
    ├── 创建后台任务 tid="e5f6g7h8"
    ├── exec("curl ...") → 子进程
    ├── 完成 → notifications.push(...)
    │
    └── 下次 drain 时被消费
        → Agent 循环或 UI 收到健康检查结果
```

---

### Phase 4: 集成 + 构建验证

#### Step 4.1 — 集成替换

```
┌─────────────────────────────────────────────────────────────┐
│  Agent 推理: "所有组件就绪，替换轮询为 WebSocket"              │
└─────────────────────────────────────────────────────────────┘
         │
         ├── 调用 read_file
         │   src/app/page.tsx → 定位轮询代码
         │
         ├── 调用 edit_file
         │   ┌─────────────────────────────────────────────┐
         │   │ 替换:                                       │
         │   │ // 旧代码 (2 秒轮询)                         │
│        │ │ // useEffect(() => {                          │
│        │ │ //   const interval = setInterval(async () =>{│
│        │ │ //     const res = await fetch('/api/state'); │
│        │ │ //     ...                                    │
│        │ │ //   }, 2000);                                │
│        │ │ //   return () => clearInterval(interval);    │
│        │ │ // }, []);                                    │
│        │ │                                               │
│        │ │ // 新代码 (WebSocket)                          │
│        │ │ import { useWebSocket } from                   │
│        │ │   '@/hooks/useWebSocket';                      │
│        │ │                                               │
│        │ │ // 在组件内:                                    │
│        │ │ useWebSocket((data) => {                       │
│        │ │   if (data.type === 'state') {                 │
│        │ │     setGlobalState(data.payload);              │
│        │ │   } else if (data.type === 'bgNotif') {        │
│        │ │     setMessages(prev => [...prev, {            │
│        │ │       id: msgId(),                             │
│        │ │       role: 'assistant',                       │
│        │ │       content: formatBgNotif(data.payload)     │
│        │ │     }]);                                       │
│        │ │   }                                            │
│        │ │ });                                            │
│        │ └────────────────────────────────────────────────┘
         │
         └── 调用 task_update
             task_update({ id: 4, status: "completed" })
```

#### Step 4.2 — 后台构建验证

```
┌─────────────────────────────────────────────────────────────┐
│  调用 background_run                                         │
│  {                                                           │
│    command: "cd /project && pnpm build 2>&1",               │
│    timeout: 300                                              │
│  }                                                           │
│                                                             │
│  tid = "i9j0k1l2"                                           │
│  status: "running"                                           │
│                                                             │
│  Agent 不阻塞，继续处理其他事情...                             │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent 同时调用 compress                                     │
│  "压缩上下文，清理冗余的工具调用历史"                          │
│                                                             │
│  compressMessages() 执行:                                    │
│  ├── 保留最近 4 条消息                                        │
│  ├── 旧工具结果替换为 [Previous: used read_file]             │
│  └── read_file 结果保留不压缩                                 │
└─────────────────────────────────────────────────────────────┘
```

#### Step 4.3 — 构建结果通知

```
构建进程完成...

┌─────────────────────────────────────────────────────────────┐
│  BG_MGR callback:                                           │
│                                                             │
│  tasks["i9j0k1l2"] = {                                      │
│    status: "completed",                                      │
│    result: "✓ Compiled successfully\n                        │
│             Route (app)                    Size     First Load│
│             ┌ ○ /                         5.2 kB         89 kB│
│             ├ ○ /api/chat                 0 B              0 B│
│             ├ ○ /api/ws                   0 B              0 B│
│             └ ○ /api/state                0 B              0 B│
│             ○  (Static)  prerendered as static content"       │
│  }                                                           │
│                                                             │
│  notifications.push({ task_id: "i9j0k1l2", ... })           │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent 循环 drain → 注入 <background-results>               │
│                                                             │
│  LLM 看到 "Compiled successfully"                           │
│  → 调用 task_update({ id: 5, status: "completed" })         │
│  → 更新 TodoWrite: 所有 todo 标记完成                        │
│  → 生成最终回复给用户                                        │
└─────────────────────────────────────────────────────────────┘
```

---

### Phase 5: 完成 + 知识沉淀

#### Step 5.1 — 将实现导入知识库

```
┌─────────────────────────────────────────────────────────────┐
│  Agent 推理: "将新实现导入知识库，方便未来检索"                │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  调用 knowledge_ingest                                       │
│  { path: "src/app/api/ws/route.ts" }                        │
│                                                             │
│  KnowledgeManager.ingest() 执行:                             │
│  ├── 读取文件内容                                             │
│  ├── chunkText() → 3 个 chunk                                │
│  │   [0]: WebSocket 服务器初始化 (500 chars)                  │
│  │   [1]: 广播器类实现 (480 chars)                            │
│  │   [2]: HTTP 升级处理 (350 chars)                           │
│  ├── _embed(chunks) → 3 个向量                               │
│  ├── 存入 .knowledge/db/chunks.json                          │
│  └── 更新 .knowledge/docs.json 索引                          │
│                                                             │
│  返回: "Ingested src/app/api/ws/route.ts → 3 chunks"        │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  调用 knowledge_ingest                                       │
│  { path: "src/hooks/useWebSocket.ts" }                      │
│                                                             │
│  返回: "Ingested src/hooks/useWebSocket.ts → 2 chunks"      │
└─────────────────────────────────────────────────────────────┘
```

#### Step 5.2 — 保存制品

```
┌─────────────────────────────────────────────────────────────┐
│  调用 artifact_save                                         │
│  {                                                           │
│    taskId: 1,                                                │
│    filePath: "src/app/api/ws/route.ts",                     │
│    content: "...(文件内容)..."                                │
│  }                                                           │
│                                                             │
│  → .artifacts/task_1_ws-route.ts 保存                        │
└─────────────────────────────────────────────────────────────┘
```

#### Step 5.3 — 最终回复

```
┌─────────────────────────────────────────────────────────────┐
│  Agent 生成最终回复 (SSE message 事件):                       │
│                                                             │
│  "WebSocket 实时推送功能已完成！以下是实现摘要：               │
│                                                             │
│  **新增文件:**                                                │
│  - `src/app/api/ws/route.ts` — WebSocket 服务端              │
│  - `src/lib/ws-broadcaster.ts` — 状态广播器                  │
│  - `src/hooks/useWebSocket.ts` — 前端 Hook                   │
│  - `src/lib/__tests__/ws-broadcaster.test.ts` — 服务端测试   │
│  - `src/hooks/__tests__/useWebSocket.test.ts` — Hook 测试    │
│                                                             │
│  **修改文件:**                                                │
│  - `src/app/page.tsx` — 替换 2s 轮询为 WebSocket 监听        │
│                                                             │
│  **测试结果:** 7 passed, 0 failed                            │
│  **构建状态:** ✓ Compiled successfully                       │
│                                                             │
│  **已设置:**                                                  │
│  - 定时健康检查 (ws-health-check, 30s 间隔)                  │
│  - 知识库已更新 (5 new chunks)                               │
│  - 任务制品已归档"                                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 完整调用链时序图

```
时间轴 →

用户     主Agent        ws-engineer    tester       BG_MGR      CRON_MGR
 │         │               │             │            │            │
 │  发送   │               │             │            │            │
 │  消息   │               │             │            │            │
 │────────▶│               │             │            │            │
 │         │               │             │            │            │
 │         │──knowledge_search──▶        │            │            │
 │         │◀──SSE: log──────            │            │            │
 │         │               │             │            │            │
 │         │──task_create×5─▶            │            │            │
 │         │◀──SSE: log──────            │            │            │
 │         │               │             │            │            │
 │         │──TodoWrite────▶             │            │            │
 │         │               │             │            │            │
 │         │──bash (cat)───▶             │            │            │
 │         │               │             │            │            │
 │         │──team_spawn───▶│             │            │            │
 │         │  ws-engineer   │             │            │            │
 │         │               │             │            │            │
 │         │──team_spawn───▶│────────────▶│            │            │
 │         │  tester        │  (并行)     │            │            │
 │         │               │             │            │            │
 │         │               │──read_file──▶            │            │
 │         │               │──knowledge──▶            │            │
 │         │               │  search     │            │            │
 │         │               │──write_file─▶            │            │
 │         │               │  ×2         │            │            │
 │         │               │──bash───────▶            │            │
 │         │               │  (pnpm add) │            │            │
 │         │               │             │            │            │
 │         │               │             │──read_file─▶            │
 │         │               │             │──bash──────▶            │
 │         │               │             │  (ls)      │            │
 │         │               │             │──write_file▶            │
 │         │               │             │  ×2        │            │
 │         │               │             │            │            │
 │         │◀──inbox: ws-engineer────────│            │            │
 │         │◀──inbox: tester─────────────│            │            │
 │         │               │             │            │            │
 │         │──background───▶────────────────────────▶│            │
 │         │  run (test)    │             │            │            │
 │         │               │             │            │──exec()──▶ │
 │         │               │             │            │  (pnpm    │
 │         │               │             │            │   test)   │
 │         │               │             │            │            │
 │         │──write_file───▶ (Hook)       │            │            │
 │         │──edit_file────▶ (集成)       │            │            │
 │         │               │             │            │            │
 │         │──background───▶────────────────────────▶│            │
 │         │  run (build)   │             │            │──exec()──▶ │
 │         │               │             │            │            │
 │         │               │             │    测试完成 │◀──callback│
 │         │               │             │            │            │
 │         │◀──drain()──────◀─────────────────────────│            │
 │         │  <bg-results>  │             │            │            │
 │         │               │             │            │            │
 │         │──cron_schedule─▶──────────────────────────────────▶│
 │         │  ws-health     │             │            │    │      │
 │         │               │             │            │    │setInterval
 │         │               │             │    构建完成 │◀──callback│
 │         │               │             │            │            │
 │         │◀──drain()──────◀─────────────────────────│            │
 │         │  <bg-results>  │             │            │            │
 │         │               │             │            │            │
 │         │──knowledge_ingest──▶        │            │            │
 │         │──artifact_save──▶           │            │            │
 │         │               │             │            │            │
 │  SSE    │◀──message (最终回复)─────────│            │            │
 │◀────────│               │             │            │            │
 │  done   │               │             │            │            │
 │◀────────│               │             │            │            │
 │         │               │             │            │            │
 │  2s 轮询│               │             │            │            │
 │◀───────▶│/api/state     │             │            │            │
 │         │               │             │            │──bg run──▶ │
 │         │               │             │   (cron tick: health)   │
```

---

## 系统交互汇总

### 各系统在本案例中的角色

| 系统 | 使用时机 | 工具/方法 | 作用 |
|------|---------|----------|------|
| **RAG 知识召回** | Phase 1 开始 | `knowledge_search` | 检索现有 SSE 实现作为参考 |
| **RAG 知识召回** | Phase 5 结束 | `knowledge_ingest` | 将新实现导入知识库 |
| **持久化任务** | Phase 1 | `task_create` × 5 | 创建任务体系 + 依赖关系 |
| **持久化任务** | Phase 2-4 | `task_update` | 更新任务状态 (pending→in_progress→completed) |
| **TodoList** | Phase 1 | `TodoWrite` | 短期待办跟踪 |
| **子任务派生** | Phase 2 | `TeammateManager.spawn()` | 派生 ws-engineer 和 tester |
| **团队协作** | Phase 2 | `MessageBus` (inbox) | 子 Agent 写入结果，主 Agent 读取 |
| **后台任务** | Phase 3 | `background_run` | 后台运行测试 (不阻塞主流程) |
| **后台任务** | Phase 4 | `background_run` | 后台运行构建 |
| **通知 Drain** | Phase 3-4 | `BG_MGR.drain()` | 测试/构建结果注入 Agent 上下文 |
| **定时调度** | Phase 3 | `cron_schedule` | 30s 健康检查 |
| **定时调度** | Phase 3-4 | `BG_MGR.run()` (内部) | Cron 委托 BG_MGR 执行 |
| **文件操作** | 全程 | `read_file` `write_file` `edit_file` | 读写代码文件 |
| **Shell 命令** | Phase 2 | `bash` | 安装依赖、列目录 |
| **制品归档** | Phase 5 | `artifact_save` | 保存任务制品 |
| **上下文压缩** | Phase 4 | `compress` | 清理冗余历史 |
| **SSE 流** | 全程 | SSE events | 实时推送状态/日志/消息给客户端 |
| **State 轮询** | 全程 | 2s GET /api/state | 同步 globalState (teammates, bgTasks, cronTasks 等) |
| **ETag 缓存** | 全程 | If-None-Match | 减少无效数据传输 |

### RightPanel 实时展示变化

```
时间 →  Phase 1        Phase 2         Phase 3         Phase 4        Phase 5

活跃进程  0              0               1 (test)        2 (test+build) 0
         ─────────────  ─────────────   ─────────────   ─────────────  ─────

协作智能体 0              2               2→0             0              0
         ─────────────  ┌─●─ws-eng─●─┐  (idle)         ─────────────  ─────
                        │ ●─tester──● │
                        └────────────┘

驻留调度  0              0               0               1 (ws-health)  1
         ─────────────  ─────────────   ─────────────   ─────────────  ─────

会话轮次  1→3            4→8             9→12            13→16          17→18
         (递增)          (递增)          (递增)          (递增)         (递增)

知识库    0 docs         0 docs          0 docs          0 docs         2 docs
         0 chunks       0 chunks        0 chunks        0 chunks       5 chunks
```

---

## 设计要点

1. **并行优先**: 子 Agent 并行执行，后台任务不阻塞主流程
2. **通知不丢失**: drain 机制保证两个消费者至少一个收到通知；ETag 缓存不影响通知投递
3. **上下文隔离**: 子 Agent 独立窗口，不污染主 Agent 上下文；结果按需注入
4. **知识循环**: 先检索 (RAG) → 执行 → 再沉淀 (ingest)，形成知识闭环
5. **任务可追溯**: 依赖图 + 审计日志 + 制品归档，完整可追溯
6. **状态实时同步**: SSE 流 + 2s 轮询 + ETag 缓存，兼顾实时性和带宽效率
