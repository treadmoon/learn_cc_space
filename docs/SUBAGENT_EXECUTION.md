# SubAgent 执行流程详解

本文档从零开始解释子 Agent 系统的每个组件是什么、为什么存在、如何协作, 并逐步追踪完整调用链。

---

## 目录

- [第一部分: 核心概念](#第一部分-核心概念)
  - [什么是 Agent](#什么是-agent)
  - [什么是 Agent Loop](#什么是-agent-loop)
  - [什么是 SubAgent](#什么是-subagent)
  - [什么是 Teammate](#什么是-teammate)
  - [TeammateManager 是什么](#teammatemanager-是什么)
  - [MessageBus 是什么](#messagebus-是什么)
  - [SubAgentRunner 是什么](#subagentrunner-是什么)
  - [TeammateRunner 是什么](#teamrunner-是什么)
  - [runAgentLoop 是什么](#runagentloop-是什么)
  - [llm-client.ts 是什么](#llm-clientts-是什么)
  - [全局关系图](#全局关系图)
- [第二部分: 执行流程 (逐步追踪)](#第二部分-执行流程)
  - [阶段 1: LLM 返回工具调用](#阶段-1-llm-返回工具调用)
  - [阶段 2: executeToolCalls 分派](#阶段-2-executetoolcalls-分派)
  - [阶段 3: TeammateManager.spawn()](#阶段-3-teammanagerspawn)
  - [阶段 4: SubAgentRunner.start()](#阶段-4-subagentrunnerstart)
  - [阶段 5: _loop() 轮询等待](#阶段-5-_loop-轮询等待)
  - [阶段 6: 主 Agent 发送任务](#阶段-6-主-agent-发送任务)
  - [阶段 7: _loop 被唤醒, 执行任务](#阶段-7-_loop-被唤醒-执行任务)
  - [阶段 8: runAgentLoop() 独立 LLM 循环](#阶段-8-runagentloop-独立-llm-循环)
  - [阶段 9: 结果回传](#阶段-9-结果回传)
  - [阶段 10: 主 Agent 读取结果](#阶段-10-主-agent-读取结果)
- [第三部分: 完整时序图与索引](#第三部分-完整时序图与索引)
  - [完整时序图](#完整时序图)
  - [关键文件索引](#关键文件索引)

---

# 第一部分: 核心概念

## 什么是 Agent

在本项目中, **Agent** 是一个能自主使用工具的 AI 程序。它不只是聊天, 还能:

- 执行 bash 命令
- 读写文件
- 搜索知识库
- 管理任务

Agent 的核心能力来自 LLM (大语言模型) 的 **function calling** 功能 — LLM 可以决定"我现在需要用什么工具", 而不只是返回文本。

```
用户: "读取 package.json 的内容"
        │
        ▼
LLM:   "我需要用 read_file 工具" → 返回 tool_calls: [{name: "read_file", args: {path: "package.json"}}]
        │
        ▼
系统:   执行 read_file → 返回文件内容
        │
        ▼
LLM:   "package.json 包含以下内容: ..." → 返回纯文本 (finish_reason: "stop")
```

## 什么是 Agent Loop

**Agent Loop** 是 Agent 的核心执行循环。它的工作方式:

```
重复 (最多 N 轮):
    1. 调用 LLM, 传入对话历史 + 可用工具列表
    2. LLM 返回:
       a) 纯文本 → 结束循环, 返回给用户
       b) 工具调用 (tool_calls) → 执行工具 → 把结果注入对话历史 → 继续循环
```

用伪代码表示:

```typescript
for (let i = 0; i < MAX_LOOPS; i++) {
    const response = await llm.call(messages, tools);

    if (response.finish_reason === 'stop') {
        break;  // LLM 完成, 退出循环
    }

    // LLM 要求执行工具
    for (const toolCall of response.tool_calls) {
        const result = execute(toolCall.name, toolCall.arguments);
        messages.push({ role: 'tool', content: result });
    }
    // 继续下一轮 — LLM 会看到工具结果, 决定下一步
}
```

**为什么叫 "循环"?** 因为 LLM 可以连续请求多个工具。例如:

```
第 1 轮: LLM → "我要 read_file" → 得到文件内容
第 2 轮: LLM → "我要 bash" → 执行命令
第 3 轮: LLM → "我要 write_file" → 写入结果
第 4 轮: LLM → "任务完成" → 结束
```

本项目有两个 Agent Loop:
- **主 Agent Loop** (`route.ts:431-505`) — 处理用户对话, 最多 15 轮, 通过 SSE 流推送结果给前端
- **子 Agent Loop** (`subagent.ts:104-172`) — 子 Agent 独立执行, 最多 10 轮, 结果通过 MessageBus 回传

## 什么是 SubAgent

**SubAgent** (子 Agent) 是主 Agent 派生的独立执行单元。

**为什么需要子 Agent?**

假设用户说: *"帮我同时做三件事: 1) 整理代码 2) 写测试 3) 更新文档"*

如果没有子 Agent, 主 Agent 只能串行处理 (一件一件做), 而且三件事的上下文会互相干扰。

有了子 Agent:
```
主 Agent → spawn("coder", "整理代码")     → 子 Agent 1 独立执行
         → spawn("tester", "写测试")      → 子 Agent 2 独立执行
         → spawn("doc-writer", "更新文档") → 子 Agent 3 独立执行
         → 继续处理其他工作...

(过一段时间)

主 Agent → read_inbox("agent") → 收集三个子 Agent 的结果
```

**子 Agent 与主 Agent 的区别:**

| 维度 | 主 Agent | 子 Agent |
|------|---------|---------|
| 入口 | 用户 HTTP 请求 → SSE 流 | `SubAgentRunner.start()` → 后台 Promise |
| 上下文 | 用户对话历史 (跨会话) | 独立的 messages 数组 (每次任务新建) |
| LLM 循环 | `route.ts` 的 for 循环 | `runAgentLoop()` 函数 |
| 工具集 | 全部 24 个 + MCP + 团队工具 | 16 个 (排除团队工具, 防止递归) |
| 结果输出 | SSE 事件 → 前端 | `BUS.sendInbox()` → 主 Agent inbox |
| 终止条件 | 用户中止 / LLM stop / 15 轮上限 | `setStatus('idle')` / LLM stop / 10 轮上限 / 60s 空闲 |

## 什么是 Teammate

**Teammate** (队友) 是与主 Agent **对等协作**的 Agent, 与 SubAgent 的 **从属关系** 不同。

**为什么需要 Teammate?**

SubAgent 是从属关系: 父 → 子, 单向汇报。子 Agent 不能创建其他子 Agent, 不能直接与其他子 Agent 通信。

Teammate 是对等关系: 任意成员 ↔ 任意成员, 双向通信。Teammate 可以:
- 给任意成员发消息 (不限于主 Agent)
- 创建其他 Teammate
- 使用全量工具 (含团队协作工具)

```
SubAgent 模式 (从属):
  主 Agent → 子 Agent (单向汇报)
  主 Agent → 子 Agent (单向汇报)

Teammate 模式 (对等):
  主 Agent ←→ researcher ←→ coder (任意双向通信)
```

**典型场景:**

> "创建 researcher 和 coder 两个 teammate, researcher 搜索文档, 把结果发给 coder, coder 写代码"

```
主 Agent
  ├─ create_teammate("researcher", "搜索文档")
  ├─ create_teammate("coder", "写代码")
  └─ send_message({to:"researcher", content:"搜索 React 文档, 发给 coder"})

researcher ←──────────────────→ coder
  │ 搜索文档                     │ 收到文档
  │ send_message → coder         │ 写代码
  └──────────────────────────────┘
```

**SubAgent 与 Teammate 的区别:**

| 维度 | SubAgent (从属) | Teammate (对等) |
|------|----------------|----------------|
| 关系 | 父 → 子, 从属 | 对等, 协作 |
| 通信 | 父 → 子 (任务), 子 → 父 (结果) | 任意成员 → 任意成员 |
| 工具集 | 16 个 (排除团队工具) | 全部 21 个 (含 send_message, read_inbox, create_teammate) |
| 能否创建其他 Agent | 不能 | 能 (create_teammate) |
| 终止 | 父 setStatus('idle') / 60s 超时 | 自己 setStatus('idle') / 60s 超时 |
| System Prompt | "You work as part of a team under the main agent's coordination" | "You are an EQUAL team member — not a sub-agent" |
| 发件人 | `sendInbox(name, 'agent', content)` | `sendInbox(to, this.name, content)` |
| 运行器 | SubAgentRunner | TeammateRunner (继承 SubAgentRunner) |

## TeammateManager 是什么

**TeammateManager** 是管理子 Agent 生命周期的单例类。

**什么是 "单例"?** 在整个 Node.js 进程中, 只有一个 TeammateManager 实例。所有请求共享它。通过 `globalForAgent` 模式实现 (防止 Next.js HMR 重复创建)。

**它的职责:**

```
TeammateManager
├── spawn(name, role)            → 注册成员 (type:subagent) + 启动 SubAgentRunner
├── createTeammate(name, role)   → 注册成员 (type:teammate) + 启动 TeammateRunner
├── setStatus(name, status)      → 更新状态 + 停止 runner
├── listAll()                    → 返回所有成员列表
├── wakeRunner(name)             → 唤醒子 Agent 轮询
└── runners: Map<string, SubAgentRunner|TeammateRunner>  → 存储活跃的运行器
```

**数据存储:** `.team/config.json`

```json
{
  "team_name": "default",
  "members": [
    { "name": "tester", "role": "测试工程师", "status": "working", "type": "subagent" },
    { "name": "researcher", "role": "搜索文档", "status": "working", "type": "teammate" },
    { "name": "coder", "role": "代码编写", "status": "idle", "type": "teammate" }
  ]
}
```

**spawn() 做了什么?** (创建 SubAgent — 从属模式)

1. 在 config.json 中注册成员, `type: 'subagent'`
2. 停止同名旧 runner (如果存在)
3. 创建新的 `SubAgentRunner` 实例
4. 调用 `runner.start()` 启动后台循环 (非阻塞, 立即返回)

**createTeammate() 做了什么?** (创建 Teammate — 对等模式)

1. 在 config.json 中注册成员, `type: 'teammate'`
2. 停止同名旧 runner (如果存在)
3. 创建新的 `TeammateRunner` 实例 (继承 SubAgentRunner)
4. 调用 `runner.start()` 启动后台循环 (非阻塞, 立即返回)

**setStatus() 做了什么?**

1. 更新 config.json 中的状态
2. 如果设为 `'idle'`, 调用 `runner.stop()` 停止后台循环

**wakeRunner() 做了什么?**

1. 查找 name 对应的 runner
2. 调用 `runner.wake()` 让它立即检查 inbox (不需要等 5s 轮询)

## MessageBus 是什么

**MessageBus** 是子 Agent 之间的消息传递系统。

**为什么叫 "Bus"?** 类似硬件总线 — 任何节点都可以往总线上发消息, 目标节点从总线上读取消息。

**它的工作方式:**

```
.sendInbox(to, from, content)
    → 写入 .team/inbox/{to}.jsonl
    → 唤醒目标子 Agent (如果是子 Agent)

.readInbox(name)
    → 读取 .team/inbox/{name}.jsonl
    → 清空文件 (破坏性读取)
    → 返回消息数组
```

**消息格式** (每行一个 JSON):

```json
{"from":"agent","content":"读取 package.json","timestamp":"2026-05-18T10:00:00Z"}
```

**为什么是 "破坏性读取"?** 读完就清空, 消息不会保留。这是为了:
- 简化状态管理 (不需要标记已读/未读)
- 防止消息重复处理
- 适用于一次性任务结果传递

**收件箱文件:**

```
.team/inbox/
├── agent.jsonl      ← 主 Agent 的收件箱 (子 Agent 的回复)
├── tester.jsonl     ← tester 的收件箱 (主 Agent 的任务)
└── researcher.jsonl ← researcher 的收件箱
```

## SubAgentRunner 是什么

**SubAgentRunner** 是单个子 Agent 的执行引擎。每个子 Agent 有自己的 SubAgentRunner 实例。

**它是什么?** 一个后台运行的异步循环, 负责:
1. 等待任务 (轮询 inbox)
2. 收到任务后运行独立的 LLM 循环
3. 把结果发回主 Agent
4. 空闲超时后自动停止

**核心方法:**

| 方法 | 作用 | 阻塞? |
|------|------|-------|
| `constructor(name, role)` | 初始化, 记录子 Agent 的名称和角色 | 否 |
| `start()` | 启动后台循环 `_loop()` | 否 (非阻塞) |
| `stop()` | 设置 `running = false`, 唤醒等待中的轮询 | 否 |
| `wake()` | 唤醒 `_waitForWake()`, 让循环立即检查 inbox | 否 |
| `_loop()` | 核心循环: 轮询 → 执行 → 回复 | 是 (内部循环) |
| `_waitForWake(ms)` | 阻塞等待, 直到 `wake()` 被调用或超时 | 是 |
| `_buildSystemPrompt()` | 构建子 Agent 的系统提示词 | 否 |
| `_buildToolHandlers()` | 构建子 Agent 的工具处理器映射 | 否 |

**为什么是非阻塞的?**

`start()` 内部调用 `_loop()` 但**不 await** 它:

```typescript
start(): void {
    this.running = true;
    this._loop().catch(err => { ... });  // 没有 await!
}
```

这意味着:
- `start()` 立即返回
- `_loop()` 作为后台 Promise 在事件循环中运行
- 主 Agent 的 SSE 流不会被阻塞
- 子 Agent 和主 Agent 可以同时运行

**轮询 + 即时唤醒机制:**

```
_loop() 循环:
    while (running) {
        inbox = readInbox();
        if (inbox 为空) {
            等待 5 秒 或 被 wake() 唤醒  ← _waitForWake(5000)
            continue;
        }
        // 有消息 → 执行任务
    }
```

为什么要两种触发方式?
- **轮询 (5s)**: 兜底机制, 即使 wake() 失败也能在 5s 内发现新消息
- **即时唤醒**: sendInbox() 后调用 wakeRunner(), 立即唤醒, 无需等待

**空闲超时 (60s):**

如果连续 60s 没有收到任何消息, 子 Agent 自动停止:

```typescript
const idleTime = Date.now() - lastActiveTime;
if (idleTime >= 60_000) {
    TEAM_MGR.setStatus(this.name, 'idle');  // 停止
    break;
}
```

这是为了防止子 Agent 永远在后台运行, 浪费资源。

## TeammateRunner 是什么

**TeammateRunner** 是 Teammate (对等协作模式) 的执行引擎, 继承自 SubAgentRunner。

**与 SubAgentRunner 的区别:**

| 维度 | SubAgentRunner | TeammateRunner |
|------|---------------|----------------|
| 工具集 | 16 个 (SUB_AGENT_TOOLS) | 21 个 (TEAMMATE_TOOLS, 含团队协作) |
| System Prompt | 从属关系 ("under the main agent's coordination") | 对等关系 ("You are an EQUAL team member") |
| 发件人 | `'agent'` (固定为主 Agent) | `this.name` (自己) |
| create_teammate | 不能 | 能 |
| send_message | 不能 | 能 |
| read_inbox | 不能 | 能 |

**覆写的方法:**

```typescript
export class TeammateRunner extends SubAgentRunner {
    // 覆写: 协作模式的 system prompt
    protected _buildSystemPrompt(): string {
        return `You are "${this.name}", a teammate in a collaborative team. Role: ${this.role}.
You are an EQUAL team member — not a sub-agent...`;
    }

    // 覆写: 全量工具 handler (含团队协作)
    protected _buildToolHandlers(): Record<string, Function> {
        return {
            // 基础工具 (与 SubAgent 相同)
            bash: ..., read_file: ..., write_file: ..., edit_file: ...,
            // 团队协作工具 (SubAgent 没有的)
            create_teammate: (kw) => TEAM_MGR.createTeammate(kw.name, kw.role),
            send_message:    (kw) => BUS.sendInbox(kw.to, this.name, kw.content),
            read_inbox:      (kw) => BUS.readInbox(kw.name || this.name),
            // ...
        };
    }
}
```

**关键区别 — send_message 的发件人:**

```
SubAgent:  BUS.sendInbox("worker", "agent", content)   ← 发件人固定是 "agent"
Teammate:  BUS.sendInbox(kw.to, this.name, content)    ← 发件人是自己 (如 "researcher")
```

这意味着:
- SubAgent 的消息看起来都来自主 Agent
- Teammate 的消息带有自己的身份, 可以被其他 Teammate 识别

## runAgentLoop 是什么

**runAgentLoop** 是一个可复用的 Agent 循环函数, 从 route.ts 的主循环提取而来。

**为什么需要提取?** 主 Agent 和子 Agent 都需要相同的 LLM → 工具 → 重复逻辑。如果不提取, 就要复制粘贴一遍代码。

**函数签名:**

```typescript
async function runAgentLoop(params: {
    messages: any[];              // 初始消息数组 (会被原地修改)
    systemPrompt: string;         // 系统提示词 (角色定义)
    tools: any[];                 // 可用工具列表
    toolHandlers: Record<string, Function>;  // 工具名 → 执行函数
    maxLoops?: number;            // 最大循环次数 (默认 10)
    onLog?: (msg: string) => void;          // 日志回调
}): Promise<any[]>                // 返回最终的 messages 数组
```

**与主循环的区别:**

| 维度 | 主循环 (route.ts) | runAgentLoop (subagent.ts) |
|------|------------------|---------------------------|
| 结果输出 | SSE 事件 → 前端 | 返回 messages 数组 |
| 中止支持 | AbortController | 无 (由 stop() 终止) |
| 微压缩 | 有 (microCompact) | 有 (共享) |
| 后台通知 | 有 (BG_MGR.drain) | 无 |
| 最大轮次 | 15 | 10 |

### 消息推送时机 — 每条任务推几次?

**结论: 每条任务只推 1 次。runAgentLoop 本身不推送任何消息给主 Agent。**

```
runAgentLoop() 执行过程:
    LLM call #1 → tool_calls → 执行工具     ← onLog() 只写 console.log, 不推送
    LLM call #2 → tool_calls → 执行工具     ← onLog() 只写 console.log, 不推送
    LLM call #3 → stop → 返回 messages 数组 ← 返回给 _loop(), 不推送

_loop() 收到 result 后:
    提取最后一条 assistant 回复
    BUS.sendInbox(...)                      ← 唯一一次推送给主 Agent
```

对比主 Agent 和子 Agent 的消息输出方式:

| 事件 | 主 Agent (route.ts) | 子 Agent (subagent.ts) |
|------|---------------------|------------------------|
| LLM 返回文本 | `sendEvent('message', ...)` → SSE 推给前端 | `onLog(...)` → console.log |
| 工具调用开始 | `sendEvent('log', ...)` → SSE 推给前端 | `log(...)` → console.log |
| 工具执行结果 | `sendEvent('log', ...)` → SSE 推给前端 | `log(...)` → console.log |
| 循环结束 | `sendEvent('done', ...)` → SSE 推给前端 | `BUS.sendInbox(...)` → 推给主 Agent (1次) |

**为什么子 Agent 的中间过程不推给主 Agent?**

1. **主 Agent 不需要知道** — 子 Agent 的中间步骤 (思考、工具调用细节) 对主 Agent 来说是内部实现, 只需要最终结果
2. **避免干扰** — 如果子 Agent 的每一步都推给主 Agent, 主 Agent 的 context window 会被撑爆
3. **独立上下文** — 子 Agent 的 messages 数组是独立的, 不与主 Agent 共享

**主 Agent 能看到子 Agent 的中间过程吗?**

不能。主 Agent 只能通过 `read_inbox` 读取子 Agent 的最终回复。子 Agent 的:
- LLM 推理过程 → 只在 console.log 中
- 工具调用细节 → 只在 console.log 中
- 错误和重试 → 只在 console.log 中

如果需要让主 Agent 看到子 Agent 的执行过程, 需要修改 `_loop()` 方法, 在 `runAgentLoop` 的 `onLog` 回调中通过某种方式 (如状态 API 或额外消息) 推送给主 Agent。当前实现不做这个。

## llm-client.ts 是什么

**llm-client.ts** 是 OpenAI SDK 客户端的单例模块。

**为什么需要单独提取?** 主 Agent (route.ts) 和子 Agent (subagent.ts) 都需要调用 LLM。如果不共享, 就要创建两个 OpenAI 客户端实例。

**内容:**

```typescript
// src/lib/agent/llm-client.ts
import OpenAI from 'openai';

export const client = new OpenAI({
    baseURL: process.env.ANTHROPIC_BASE_URL,     // API 地址
    apiKey: process.env.ANTHROPIC_API_KEY || 'sk-none',
});

export const MODEL = process.env.MODEL_ID || 'claude-3-5-sonnet-20241022';
```

两个模块都 import 它:

```typescript
// route.ts
import { client, MODEL } from '@/lib/agent/llm-client';

// subagent.ts
import { client, MODEL } from '@/lib/agent/llm-client';
```

## 全局关系图

```
用户 HTTP 请求
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  route.ts (主 Agent)                                         │
│                                                              │
│  ┌─ Agent Loop (最多 15 轮) ─────────────────────────────┐  │
│  │  LLM call → tool_calls → executeToolCalls → 继续      │  │
│  │                                                         │  │
│  │  工具: bash, read_file, write_file, ...                │  │
│  │        spawn_teammate, create_teammate,                │  │
│  │        send_message, read_inbox, ...                   │  │
│  └─────────────────────────────────────────────────────────┘  │
│         │                                                     │
│         │ 调用                                                │
│         ▼                                                     │
│  ┌─ TeammateManager (单例) ──────────────────────────────┐  │
│  │  spawn()          → 创建 SubAgentRunner (从属模式)     │  │
│  │  createTeammate() → 创建 TeammateRunner (对等模式)     │  │
│  │  setStatus()      → 更新 config.json + stop()         │  │
│  │  wakeRunner()     → 唤醒子 Agent                      │  │
│  └─────────────────────────────────────────────────────────┘  │
│         │                                                     │
│         │ 创建                                                │
│         ▼                                                     │
│  ┌─ SubAgentRunner (从属模式) ───────────────────────────┐  │
│  │  工具: 16 个 (排除团队工具)                            │  │
│  │  通信: 子 → 父 (单向汇报)                              │  │
│  │  _loop():                                              │  │
│  │    inbox → runAgentLoop(16 tools) → sendInbox(agent)   │  │
│  └────────────────────────────────────────────────────────┘  │
│         │                                                     │
│         │ 创建                                                │
│         ▼                                                     │
│  ┌─ TeammateRunner (对等模式) ───────────────────────────┐  │
│  │  工具: 21 个 (含 create_teammate, send_message, ...)   │  │
│  │  通信: 任意成员 ↔ 任意成员 (双向)                      │  │
│  │  _loop():                                              │  │
│  │    inbox → runAgentLoop(21 tools) → sendInbox(发送者)  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ MessageBus (单例) ──────────────────────────────────┐   │
│  │  .team/inbox/agent.jsonl    ← 主 Agent 收件箱         │   │
│  │  .team/inbox/tester.jsonl   ← tester 收件箱           │   │
│  │  .team/inbox/researcher.jsonl ← researcher 收件箱     │   │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ llm-client.ts (共享) ───────────────────────────────┐   │
│  │  client: OpenAI SDK 实例                              │   │
│  │  MODEL: 模型 ID                                       │   │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

# 第二部分: 执行流程

下面逐步追踪: 用户发送 *"创建一个 tester 子 Agent，让它读取 package.json"* 到最终拿到结果的完整过程。

---

## 阶段 1: LLM 返回工具调用

**发生了什么?** 用户的消息到达主 Agent, LLM 决定需要调用 `spawn_teammate` 工具。

**入口**: 用户发送消息 → 主 Agent LLM 返回 tool_calls

用户发送: *"创建一个 tester 子 Agent，让它读取 package.json"*

主 Agent 的 LLM 返回:
```json
{
  "tool_calls": [{
    "id": "call_abc123",
    "type": "function",
    "function": {
      "name": "spawn_teammate",
      "arguments": "{\"name\":\"tester\",\"role\":\"读取并分析文件\"}"
    }
  }]
}
```

**LLM 为什么返回这个?** 因为 TOOLS 数组中定义了 `spawn_teammate` 工具, LLM 的 system prompt 中有说明它可以通过工具管理子 Agent。LLM 判断用户的意图是创建子 Agent, 所以返回对应的 tool_call。

**代码位置**: `src/app/api/chat/route.ts:431-505` — Agent 主循环

```typescript
// route.ts:459 — LLM 调用
resp = await client.chat.completions.create({
    model: MODEL,
    messages: messages.map(m => ({ role: m.role, content: m.content, ... })),
    tools: activeTools,   // ← 包含 spawn_teammate 在内的所有工具
    max_tokens: 4000
});

// route.ts:493 — finish_reason === 'tool_calls' → 不 break, 继续执行工具
if (resp.choices[0].finish_reason !== 'tool_calls') break;

// route.ts:504 — 执行所有 tool_calls
await executeToolCalls(assistantMsg.tool_calls, toolHandlers, mcpToolNames, messages, reqId, sendEvent);
```

**什么是 finish_reason?** LLM 返回时会附带一个 `finish_reason`:
- `'stop'` — LLM 完成回复, 不需要工具
- `'tool_calls'` — LLM 要求执行工具, 需要继续循环

---

## 阶段 2: executeToolCalls 分派

**发生了什么?** 系统找到 `spawn_teammate` 对应的执行函数并调用它。

**什么是 "分派"?** 就像电话接线员 — LLM 说 "我要找 spawn_teammate", 系统在 handler 映射表中找到对应的函数并执行。

**代码位置**: `src/app/api/chat/route.ts:261-303`

```typescript
async function executeToolCalls(toolCalls, toolHandlers, mcpToolNames, messages, reqId, sendEvent) {
    for (const block of toolCalls || []) {
        if (block.type !== 'function') continue;

        // 2.1 查找 handler — 在映射表中按工具名查找
        const handler = toolHandlers[block.function.name] ?? (...);
        // → toolHandlers["spawn_teammate"] = (kw) => TEAM_MGR.spawn(kw.name, kw.role)

        // 2.2 解析 LLM 返回的 JSON 参数
        let inputArgs = JSON.parse(block.function.arguments || '{}');
        // → { name: "tester", role: "读取并分析文件" }

        // 2.3 执行
        const output = await handler(inputArgs);
        // → TEAM_MGR.spawn("tester", "读取并分析文件")
        // → 返回: "Spawned 'tester' (role: 读取并分析文件), sub-agent loop started"

        // 2.4 结果推入 messages, 供下一轮 LLM 参考
        messages.push({
            role: 'tool',
            tool_call_id: block.id,
            name: 'spawn_teammate',
            content: "Spawned 'tester' (role: 读取并分析文件), sub-agent loop started"
        });
    }
}
```

**handler 从哪来?** `createToolHandlers()` 工厂函数 (`route.ts:309-361`) 创建了一个工具名 → 执行函数的映射表:

```typescript
function createToolHandlers(messages, reqId) {
    return {
        bash:           (kw) => runBash(kw.command),
        read_file:      (kw) => runRead(kw.path),
        // ...
        spawn_teammate: (kw) => TEAM_MGR.spawn(kw.name, kw.role),      // ← 就是这个
        send_message:   (kw) => BUS.sendInbox(kw.to, 'agent', kw.content),
        read_inbox:     (kw) => BUS.readInbox(kw.name),
        // ...
    };
}
```

---

## 阶段 3: TeammateManager.spawn()

**发生了什么?** 注册子 Agent 元数据 + 启动后台执行引擎。

**代码位置**: `src/lib/agent/managers.ts:911-935`

```typescript
spawn(name: string, role: string) {
    // 3.1 读取 .team/config.json (团队成员配置)
    const config = this._load();

    // 3.2 查找或创建成员
    //     如果已存在同名成员 → 更新 role 和 status
    //     如果不存在 → 新增一条
    let member = config.members.find(m => m.name === name);
    if (member) {
        member.status = 'working';
        member.role = role;
    } else {
        config.members.push({ name, role, status: 'working' });
    }

    // 3.3 持久化到 .team/config.json
    this._save(config);
    // → .team/config.json 内容变为:
    // {
    //   "team_name": "default",
    //   "members": [{ "name": "tester", "role": "读取并分析文件", "status": "working" }]
    // }

    // 3.4 停止旧 runner (如果之前已经有一个同名子 Agent 在运行)
    if (this.runners.has(name)) {
        this.runners.get(name).stop();
    }

    // 3.5 延迟导入 SubAgentRunner
    //     为什么用 require() 而不是 import?
    //     因为 managers.ts 和 subagent.ts 互相引用:
    //       managers.ts → 需要 SubAgentRunner
    //       subagent.ts → 需要 TEAM_MGR, BUS
    //     如果用 import, 会产生循环依赖, 模块加载时就会报错
    //     用 require() 延迟到运行时加载, 避免循环依赖
    const { SubAgentRunner } = require('./subagent');

    // 3.6 创建 SubAgentRunner 实例
    const runner = new SubAgentRunner("tester", "读取并分析文件");
    this.runners.set("tester", runner);  // 存入 Map, 方便后续 wake/stop

    // 3.7 启动后台循环
    runner.start();
    // → 非阻塞! 立即返回, 子 Agent 在后台运行

    return `Spawned 'tester' (role: 读取并分析文件), sub-agent loop started`;
}
```

**spawn 返回后发生了什么?** 控制权回到 `executeToolCalls`, 返回值被推入 messages。主 Agent 的 LLM 看到 "Spawned tester", 知道子 Agent 已创建, 可能继续调用 `send_message` 发送任务。

---

## 阶段 4: SubAgentRunner.start()

**发生了什么?** 子 Agent 的后台循环被启动, 但不阻塞主流程。

**代码位置**: `src/lib/agent/subagent.ts:214-222`

```typescript
start(): void {
    if (this.running) return;      // 防止重复启动
    this.running = true;

    // _loop() 返回一个 Promise, 但我们不 await 它
    // 这意味着 _loop() 会在后台运行, start() 立即返回
    //
    // 类比: 就像你启动了一个后台线程, 主线程继续执行
    // 但在 Node.js 中不是真正的线程, 而是异步 Promise
    this._loop().catch(err => {
        // 如果 _loop() 发生致命错误, 这里捕获
        // 防止 unhandled promise rejection 导致进程崩溃
        console.error(`[SubAgent tester] Fatal error:`, err);
        this.running = false;
        try { TEAM_MGR.setStatus(this.name, 'idle'); } catch {}
    });
}
```

**什么是 "非阻塞"?**

```
阻塞:     start() { await _loop(); }     ← 要等 _loop 结束才返回
非阻塞:   start() { _loop(); return; }   ← 立即返回, _loop 在后台运行
```

非阻塞是关键 — 主 Agent 的 SSE 流不能被阻塞, 否则前端会卡住。

---

## 阶段 5: _loop() 轮询等待

**发生了什么?** 子 Agent 的后台循环启动后, 发现 inbox 为空, 进入等待状态。

**代码位置**: `src/lib/agent/subagent.ts:249-278`

```typescript
private async _loop(): Promise<void> {
    console.log(`[SubAgent tester] Starting (role: 读取并分析文件)`);
    let lastActiveTime = Date.now();  // 记录最后一次活跃时间

    while (this.running) {
        // 5.1 检查状态 — 外部可能通过 setStatus('idle') 停止我们
        const members = TEAM_MGR.listAll();
        const me = members.find(m => m.name === this.name);
        if (!me || me.status === 'idle') {
            console.log(`[SubAgent tester] Status is idle, exiting loop`);
            break;  // 退出循环
        }

        // 5.2 读取 inbox (破坏性读取 — 读完清空)
        const inbox = BUS.readInbox("tester");
        // → [] (空的, 主 Agent 还没发消息)

        if (inbox.length === 0) {
            // 5.3 无消息 — 检查是否空闲太久
            const idleTime = Date.now() - lastActiveTime;
            if (idleTime >= 60_000) {  // 60 秒无消息
                console.log(`[SubAgent tester] Idle for 60s, auto-stopping`);
                TEAM_MGR.setStatus(this.name, 'idle');  // 自动停止
                break;
            }

            // 5.4 等待: 要么被 wake() 唤醒, 要么 5 秒超时
            await this._waitForWake(5_000);
            // → 执行到这里会暂停, 直到:
            //    a) wake() 被调用 (收到新消息) → 立即继续
            //    b) 5 秒过去 → 超时继续
            continue;
        }

        // 有消息 → 进入阶段 7
        // ...
    }
}
```

**_waitForWake 是如何工作的?**

```typescript
private _waitForWake(timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
        // 设置一个定时器, timeoutMs 后自动 resolve
        const timer = setTimeout(() => {
            this.wakeResolve = null;
            resolve();           // 超时 → 继续轮询
        }, timeoutMs);

        // 保存 resolve 函数的引用, 让 wake() 可以调用它
        this.wakeResolve = () => {
            clearTimeout(timer);  // 取消定时器
            this.wakeResolve = null;
            resolve();            // 被唤醒 → 立即处理消息
        };
    });
}
```

这个模式叫做 **"可取消的等待"** — 同时支持两种唤醒方式:
1. 超时唤醒 (5s 后自动继续)
2. 外部唤醒 (wake() 调用后立即继续)

---

## 阶段 6: 主 Agent 发送任务

**发生了什么?** 主 Agent 的 LLM 调用 `send_message` 工具, 向子 Agent 发送任务。

主 Agent LLM 返回:
```json
{
  "tool_calls": [{
    "id": "call_def456",
    "type": "function",
    "function": {
      "name": "send_message",
      "arguments": "{\"to\":\"tester\",\"content\":\"读取 package.json 并总结依赖数量\"}"
    }
  }]
}
```

**执行链** (与阶段 2 相同的分派流程):

```
executeToolCalls()
  → toolHandlers["send_message"]
    → BUS.sendInbox("tester", "agent", "读取 package.json 并总结依赖数量")
```

**代码位置**: `src/lib/agent/managers.ts:824-835` — MessageBus.sendInbox

```typescript
sendInbox(to: string, from: string, content: string): string {
    // 6.1 写入 .team/inbox/tester.jsonl
    const inboxPath = path.join(INBOX_DIR, `tester.jsonl`);
    const msg = JSON.stringify({
        from: "agent",
        content: "读取 package.json 并总结依赖数量",
        timestamp: "2026-05-18T10:00:00Z"
    });
    fs.appendFileSync(inboxPath, msg + '\n', 'utf8');
    // → .team/inbox/tester.jsonl 新增一行 JSON

    // 6.2 唤醒目标子 Agent
    //     子 Agent 可能正在 _waitForWake(5000) 中等待
    //     wakeRunner() 会让它立即醒来检查 inbox
    try { TEAM_MGR.wakeRunner("tester"); } catch {}

    return `Message sent to 'tester'`;
}
```

**唤醒链** (从 sendInbox 到子 Agent 醒来的完整路径):

```
BUS.sendInbox("tester", "agent", "读取 package.json...")
  │
  ├─ fs.appendFileSync(...)          // 写入消息文件
  │
  └─ TEAM_MGR.wakeRunner("tester")   // managers.ts:948
       │
       └─ this.runners.get("tester").wake()   // managers.ts:949
            │
            └─ SubAgentRunner.wake()           // subagent.ts:235
                 │
                 └─ this._resolveWake()        // subagent.ts:239
                      │
                      └─ this.wakeResolve()    // subagent.ts:331
                           │
                           └─ clearTimeout(timer); resolve();
                              // _waitForWake 的 Promise 被 resolve
                              // _loop() 从 await 处恢复, 继续执行
```

---

## 阶段 7: _loop 被唤醒, 执行任务

**发生了什么?** 子 Agent 的 `_loop()` 从 `_waitForWake` 中恢复, 发现 inbox 有消息, 开始执行任务。

**代码位置**: `src/lib/agent/subagent.ts:280-319`

```typescript
// _loop() 继续 — 上次阻塞在 await _waitForWake(5000), 现在被 wake() 唤醒

// 7.1 读取 inbox (破坏性读取 — 读完清空)
const inbox = BUS.readInbox("tester");
// → [{ from: "agent", content: "读取 package.json 并总结依赖数量", timestamp: "..." }]

// inbox 不为空 → 进入任务执行

lastActiveTime = Date.now();  // 更新活跃时间 (重置 60s 超时计时器)
console.log(`[SubAgent tester] Received 1 message(s)`);

for (const msg of inbox) {
    const taskContent = msg.content || String(msg);
    // → "读取 package.json 并总结依赖数量"

    console.log(`[SubAgent tester] Processing task: 读取 package.json 并总结依赖数量`);

    try {
        // 7.2 构建初始消息数组
        //     子 Agent 的对话从零开始, 不与主 Agent 共享上下文
        const messages = [
            { role: 'user', content: "读取 package.json 并总结依赖数量" }
        ];

        // 7.3 构建工具处理器
        //     子 Agent 有独立的 handler 映射, 排除团队协作工具
        //     防止子 Agent 调用 spawn_teammate 创建更多子 Agent (递归)
        const toolHandlers = this._buildToolHandlers();
        // → { bash, read_file, write_file, edit_file, TodoWrite, load_skill, ... }
        //   (没有 spawn_teammate, send_message, read_inbox 等)

        // 7.4 运行独立的 Agent 循环
        const result = await runAgentLoop({
            messages,
            systemPrompt: this._buildSystemPrompt(),  // 角色定义
            tools: SUB_AGENT_TOOLS,                    // 16 个工具
            toolHandlers,
            maxLoops: 10,
            onLog: (m) => console.log(`[SubAgent tester] ${m}`),
        });
        // → 进入阶段 8, 等待 runAgentLoop 返回

        // 7.5 提取最终 assistant 回复
        //     result 是完整的 messages 数组, 找最后一条 assistant 消息
        const lastAssistant = [...result].reverse().find(m => m.role === 'assistant' && m.content);
        const reply = lastAssistant?.content || 'Task completed (no text output)';

        // 7.6 通过 MessageBus 回复主 Agent
        //     注意: 发送到 "agent" (主 Agent 的 inbox), 不是 "tester"
        BUS.sendInbox("tester", "agent", reply);
        console.log(`[SubAgent tester] Replied: ${reply.slice(0, 80)}...`);

    } catch (err) {
        // 7.7 执行失败 — 错误信息也发回主 Agent
        const errorMsg = `Error: ${err.message}`;
        BUS.sendInbox("tester", "agent", errorMsg);
        console.error(`[SubAgent tester] Task failed:`, err.message);
    }
}

// 回到 while 循环顶部, 继续轮询下一个任务...
```

---

## 阶段 8: runAgentLoop() 独立 LLM 循环

**发生了什么?** 子 Agent 运行自己的 LLM 循环, 独立调用 LLM 和执行工具, 与主 Agent 完全隔离。

**代码位置**: `src/lib/agent/subagent.ts:104-172`

子 Agent 拥有独立的 LLM 上下文 — 它看不到主 Agent 的对话历史, 主 Agent 也看不到子 Agent 的中间步骤。

### 第一轮 LLM 调用

```typescript
// 8.1 注入 system prompt (角色定义)
messages.unshift({
    role: 'system',
    content: `You are a sub-agent named "tester" with the role: 读取并分析文件.

You work as part of a team under the main agent's coordination.

## Workflow
1. You receive tasks as user messages
2. You complete tasks using the available tools
3. When done, provide a clear summary of what you accomplished

## Guidelines
- Focus on completing the assigned task efficiently
- Use tools to read, write, and execute code as needed
- Keep your final response concise but complete`
});

// 8.2 微压缩 (新循环, 只有 2 条消息, 无需压缩)
microCompact(messages); // → 0 (没有压缩)

// 8.3 LLM 调用
resp = await client.chat.completions.create({
    model: MODEL,  // 与主 Agent 使用相同的模型
    messages: [
        { role: 'system', content: 'You are a sub-agent named "tester"...' },
        { role: 'user', content: '读取 package.json 并总结依赖数量' }
    ],
    tools: SUB_AGENT_TOOLS,  // 16 个工具
    max_tokens: 4000
});

// LLM 返回:
// → content: "我来读取 package.json 文件"
// → finish_reason: 'tool_calls'
// → tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"package.json"}' } }]
```

### 执行工具

```typescript
// 8.4 推入 assistant 消息
messages.push(assistantMsg);

// 8.5 finish_reason === 'tool_calls' → 继续执行工具

// 8.6 遍历 tool_calls
for (const block of assistantMsg.tool_calls) {
    const handler = toolHandlers["read_file"];
    // → (kw) => runRead(kw.path)

    const inputArgs = JSON.parse('{"path":"package.json"}');
    // → { path: "package.json" }

    console.log(`[SubAgent tester]   → read_file({"path":"package.json"})`);
    const output = await handler(inputArgs);
    // → runRead("package.json") → 返回文件内容 (最多 50000 字符)
    console.log(`[SubAgent tester]   ← { "name": "learn_cc_space", "dependencies": { ... } }`);

    messages.push({
        role: 'tool',
        tool_call_id: block.id,
        name: 'read_file',
        content: '{ "name": "learn_cc_space", "dependencies": { "next": "...", "react": "...", ... } }'
    });
}
```

### 第二轮 LLM 调用

```typescript
// 8.7 继续循环 (loop = 1)
resp = await client.chat.completions.create({
    model: MODEL,
    messages: [
        { role: 'system', content: '...' },
        { role: 'user', content: '读取 package.json 并总结依赖数量' },
        { role: 'assistant', content: '我来读取 package.json 文件', tool_calls: [...] },
        { role: 'tool', name: 'read_file', content: '{ "dependencies": {...}, "devDependencies": {...} }' }
    ],
    tools: SUB_AGENT_TOOLS,
    max_tokens: 4000
});

// LLM 看到了文件内容, 不再需要工具, 直接总结:
// → content: "package.json 包含 15 个 dependencies 和 8 个 devDependencies, 共 23 个依赖包。主要依赖包括: next, react, openai, zod 等。"
// → finish_reason: 'stop'  (不再需要工具)
```

### 循环结束

```typescript
// 8.8 finish_reason !== 'tool_calls' → break, 退出循环
messages.push(assistantMsg);
// → messages 数组现在包含完整的对话历史:
//   [system, user, assistant(tool_calls), tool, assistant(stop)]

return messages;
// → 返回给 SubAgentRunner._loop()
```

---

## 阶段 9: 结果回传

**发生了什么?** runAgentLoop 返回后, 子 Agent 提取最终回复, 通过 MessageBus 发回主 Agent。

**代码位置**: `src/lib/agent/subagent.ts:307-313`

```typescript
// runAgentLoop 返回的 messages 数组:
// [
//   { role: 'system', content: 'You are a sub-agent named "tester"...' },
//   { role: 'user', content: '读取 package.json 并总结依赖数量' },
//   { role: 'assistant', content: '我来读取 package.json 文件', tool_calls: [...] },
//   { role: 'tool', name: 'read_file', content: '{...}' },
//   { role: 'assistant', content: 'package.json 包含 15 个 dependencies 和 8 个 devDependencies...' }
// ]

// 9.1 提取最后一条 assistant 回复 (跳过 tool_calls 消息)
const lastAssistant = [...result].reverse().find(m => m.role === 'assistant' && m.content);
// → { role: 'assistant', content: 'package.json 包含 15 个 dependencies 和 8 个 devDependencies...' }

const reply = lastAssistant.content;
// → "package.json 包含 15 个 dependencies 和 8 个 devDependencies, 共 23 个依赖包..."

// 9.2 通过 MessageBus 发回主 Agent 的 inbox
BUS.sendInbox("tester", "agent", reply);
```

**sendInbox 内部** (`managers.ts:824-835`):

```typescript
sendInbox(to: "tester", from: "agent", content: "package.json 包含 15 个 dependencies...") {
    // 写入 .team/inbox/agent.jsonl (注意: 是 agent 的 inbox, 不是 tester 的)
    // 参数 to 是发送者 (tester), 消息会写入 .team/inbox/{to}.jsonl
    // 但这里有个语义: sendInbox 的第一个参数是 "谁发的", 消息写入 "谁的" inbox
    // 实际上: sendInbox("tester", "agent", content) → 写入 tester.jsonl
    // 但子 Agent 回复主 Agent 时: sendInbox("tester", "agent", reply)
    // → 写入 .team/inbox/tester.jsonl... 这里需要仔细看代码逻辑
    const inboxPath = path.join(INBOX_DIR, `${to}.jsonl`);
    // → .team/inbox/tester.jsonl

    // 实际上子 Agent 回复应该是写入 agent.jsonl
    // 这里的 to 参数含义是 "发送给谁的 inbox"
    // sendInbox("agent", "tester", reply) 才是正确的
    // 让我们重新看代码...
}
```

**更正**: 子 Agent 回复主 Agent 时的实际调用:

```typescript
// subagent.ts:312
BUS.sendInbox(this.name, 'agent', reply);
// → sendInbox("tester", "agent", "package.json 包含...")
// → to = "tester", from = "agent", content = "..."
// → 写入 .team/inbox/tester.jsonl
```

等等, 这写入了 tester 的 inbox, 不是 agent 的 inbox。让我重新检查...

实际上子 Agent 回复应该写入 agent 的 inbox, 所以调用应该是:

```typescript
// 修正: 子 Agent 回复主 Agent
BUS.sendInbox('agent', this.name, reply);
// → sendInbox("agent", "tester", "package.json 包含...")
// → to = "agent", from = "tester"
// → 写入 .team/inbox/agent.jsonl ✓
```

**sendInbox(to, from, content) 的语义:**
- `to` — 写入谁的 inbox 文件 (`.team/inbox/{to}.jsonl`)
- `from` — 消息中的发送者标记
- `content` — 消息内容

---

## 阶段 10: 主 Agent 读取结果

**发生了什么?** 主 Agent 的 LLM 调用 `read_inbox` 工具, 读取子 Agent 的回复。

主 Agent LLM 返回:
```json
{
  "tool_calls": [{
    "id": "call_ghi789",
    "type": "function",
    "function": {
      "name": "read_inbox",
      "arguments": "{\"name\":\"agent\"}"
    }
  }]
}
```

**执行链**:

```
executeToolCalls()
  → toolHandlers["read_inbox"]
    → BUS.readInbox("agent")
```

**代码位置**: `src/lib/agent/managers.ts:806-816` — MessageBus.readInbox

```typescript
readInbox(name: string): any[] {
    const inboxPath = path.join(INBOX_DIR, `agent.jsonl`);
    // → .team/inbox/agent.jsonl

    if (!fs.existsSync(inboxPath)) return [];
    const content = fs.readFileSync(inboxPath, 'utf8').trim();
    // → '{"from":"tester","content":"package.json 包含 15 个 dependencies...","timestamp":"..."}'

    const msgs = content.split('\n').filter(l => l).map(l => JSON.parse(l));
    // → [{ from: "tester", content: "package.json 包含 15 个 dependencies...", timestamp: "..." }]

    fs.writeFileSync(inboxPath, '', 'utf8');  // 清空文件 (破坏性读取)
    return msgs;
}
```

结果注入主 Agent 的 messages 数组, LLM 看到子 Agent 的回复, 生成最终回答:

> "package.json 包含 15 个 dependencies 和 8 个 devDependencies, 共 23 个依赖包。主要依赖包括: next, react, openai, zod 等。"

---

# 第三部分: 完整时序图与索引

## 完整时序图

```
用户                    主 Agent (SSE)          TeammateManager       SubAgentRunner         MessageBus
 │                         │                        │                     │                     │
 │─ "创建tester" ────────→│                        │                     │                     │
 │                         │─ spawn_teammate ──────→│                     │                     │
 │                         │                        │─ config.json 写入 ──│                     │
 │                         │                        │─ new Runner() ─────→│                     │
 │                         │                        │─ runner.start() ───→│                     │
 │                         │                        │                     │─ _loop() 开始 ─────→│
 │                         │                        │                     │← readInbox() (空) ──│
 │                         │                        │                     │─ _waitForWake(5s)   │
 │                         │← "Spawned tester" ────│                     │   (阻塞等待...)     │
 │                         │                        │                     │                     │
 │─ "给tester发任务" ────→│                        │                     │                     │
 │                         │─ send_message ────────→│                     │                     │
 │                         │                        │                     │                     │←─ sendInbox()
 │                         │                        │                     │                     │  写入 tester.jsonl
 │                         │                        │─ wakeRunner() ─────→│                     │
 │                         │                        │                     │← wake() 立即唤醒 ──│
 │                         │                        │                     │                     │
 │                         │                        │                     │← readInbox() ──────│
 │                         │                        │                     │  (有消息了!)         │
 │                         │                        │                     │                     │
 │                         │                        │                     │─ runAgentLoop()     │
 │                         │                        │                     │  │                  │
 │                         │                        │                     │  ├─ LLM call #1     │
 │                         │                        │                     │  │  → tool_calls     │
 │                         │                        │                     │  │                  │
 │                         │                        │                     │  ├─ read_file       │
 │                         │                        │                     │  │  → 文件内容       │
 │                         │                        │                     │  │                  │
 │                         │                        │                     │  ├─ LLM call #2     │
 │                         │                        │                     │  │  → stop           │
 │                         │                        │                     │  │  → "15 deps..."   │
 │                         │                        │                     │  │                  │
 │                         │                        │                     │  └─ return messages │
 │                         │                        │                     │                     │
 │                         │                        │                     │─ sendInbox("agent")→│
 │                         │                        │                     │                     │  写入 agent.jsonl
 │                         │                        │                     │                     │
 │                         │                        │                     │← readInbox() (空) ──│
 │                         │                        │                     │─ _waitForWake(5s)   │
 │                         │                        │                     │   (继续轮询...)     │
 │                         │                        │                     │                     │
 │─ "读取tester结果" ────→│                        │                     │                     │
 │                         │─ read_inbox ──────────→│                     │                     │
 │                         │                        │                     │                     │←─ readInbox()
 │                         │                        │                     │                     │  读取+清空 agent.jsonl
 │                         │← [{from:"tester"...}] │                     │                     │
 │                         │                        │                     │                     │
 │← 最终回复 ────────────│                        │                     │                     │
 │  "15 deps, 8 devDeps"  │                        │                     │                     │
 │                         │                        │                     │                     │
 │─ "让tester停止" ──────→│                        │                     │                     │
 │                         │─ set_teammate_status ─→│                     │                     │
 │                         │                        │─ config.json 更新 ──│                     │
 │                         │                        │  status: 'idle'     │                     │
 │                         │                        │─ runner.stop() ────→│                     │
 │                         │                        │                     │─ running = false    │
 │                         │                        │                     │─ _resolveWake() ───→│
 │                         │                        │                     │─ loop 退出          │
 │                         │                        │─ runners.delete()   │                     │
 │                         │← "Status set to idle" │                     │                     │
```

## 关键文件索引

| 文件 | 关键行号 | 作用 |
|------|---------|------|
| `src/app/api/chat/route.ts:261-303` | `executeToolCalls()` | 工具调用分派 — 查找 handler + 解析参数 + 执行 + 注入结果 |
| `src/app/api/chat/route.ts:309-361` | `createToolHandlers()` | handler 工具厂 — 注册 5 个团队协作 handler |
| `src/app/api/chat/route.ts:343-348` | 团队工具 handler | `spawn_teammate` → `TEAM_MGR.spawn()` |
| `src/lib/agent/managers.ts:824-835` | `MessageBus.sendInbox()` | 写入 inbox + 唤醒目标 runner |
| `src/lib/agent/managers.ts:806-816` | `MessageBus.readInbox()` | 破坏性读取 inbox |
| `src/lib/agent/managers.ts:911-935` | `TeammateManager.spawn()` | 写 config + 创建 SubAgentRunner + start() |
| `src/lib/agent/managers.ts:940-950` | `TeammateManager.setStatus()` | 更新 config + stop runner |
| `src/lib/agent/managers.ts:955-960` | `TeammateManager.wakeRunner()` | 唤醒子 Agent 轮询 |
| `src/lib/agent/subagent.ts:104-172` | `runAgentLoop()` | 可复用 Agent 循环 — LLM → 工具 → 重复 |
| `src/lib/agent/subagent.ts:214-222` | `SubAgentRunner.start()` | 非阻塞启动后台循环 |
| `src/lib/agent/subagent.ts:224-228` | `SubAgentRunner.stop()` | 停止循环 |
| `src/lib/agent/subagent.ts:235-238` | `SubAgentRunner.wake()` | 即时唤醒轮询 |
| `src/lib/agent/subagent.ts:249-323` | `SubAgentRunner._loop()` | 核心循环 — 轮询 inbox → 执行 → 回复 |
| `src/lib/agent/subagent.ts:260-266` | `SUB_AGENT_TOOLS` | 子 Agent 工具集 (16 个, 排除团队工具) |
| `src/lib/agent/subagent.ts:280-296` | `TEAMMATE_TOOLS` | Teammate 工具集 (21 个, 含团队协作) |
| `src/lib/agent/subagent.ts:326-337` | `_waitForWake()` | 阻塞等待 — 支持 wake() 即时唤醒 |
| `src/lib/agent/subagent.ts:450-540` | `TeammateRunner` | 对等协作模式执行引擎 (继承 SubAgentRunner) |
| `src/lib/agent/managers.ts:935-965` | `TeammateManager.createTeammate()` | 创建 Teammate (对等模式) + 启动 TeammateRunner |
| `src/lib/agent/llm-client.ts:1-12` | `client` + `MODEL` | OpenAI 单例 (主 Agent + 子 Agent 共享) |
