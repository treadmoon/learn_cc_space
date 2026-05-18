# SubAgent 执行流程详解

本文档追踪子 Agent 从创建到执行的完整调用链, 逐步展示代码如何流转。

---

## 目录

1. [阶段 1: LLM 返回工具调用](#阶段-1-llm-返回工具调用)
2. [阶段 2: executeToolCalls 分派](#阶段-2-executetoolcalls-分派)
3. [阶段 3: TeammateManager.spawn()](#阶段-3-teammanagerspawn)
4. [阶段 4: SubAgentRunner.start()](#阶段-4-subagentrunnerstart)
5. [阶段 5: _loop() 轮询等待](#阶段-5-_loop-轮询等待)
6. [阶段 6: 主 Agent 发送任务](#阶段-6-主-agent-发送任务)
7. [阶段 7: _loop 被唤醒, 执行任务](#阶段-7-_loop-被唤醒-执行任务)
8. [阶段 8: runAgentLoop() 独立 LLM 循环](#阶段-8-runagentloop-独立-llm-循环)
9. [阶段 9: 结果回传](#阶段-9-结果回传)
10. [阶段 10: 主 Agent 读取结果](#阶段-10-主-agent-读取结果)
11. [完整时序图](#完整时序图)
12. [关键文件索引](#关键文件索引)

---

## 阶段 1: LLM 返回工具调用

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

**代码位置**: `src/app/api/chat/route.ts:431-505` — Agent 主循环

```typescript
// route.ts:459 — LLM 调用
resp = await client.chat.completions.create({
    model: MODEL,
    messages: messages.map(m => ({ ... })),
    tools: activeTools,
    max_tokens: 4000
});

// route.ts:493 — finish_reason === 'tool_calls' → 不 break, 继续执行工具
if (resp.choices[0].finish_reason !== 'tool_calls') break;

// route.ts:504 — 执行所有 tool_calls
await executeToolCalls(assistantMsg.tool_calls, toolHandlers, mcpToolNames, messages, reqId, sendEvent);
```

---

## 阶段 2: executeToolCalls 分派

**入口**: `executeToolCalls()` 查找 handler 并执行

**代码位置**: `src/app/api/chat/route.ts:261-303`

```typescript
async function executeToolCalls(toolCalls, toolHandlers, mcpToolNames, messages, reqId, sendEvent) {
    for (const block of toolCalls || []) {
        if (block.type !== 'function') continue;

        // 2.1 查找 handler — 在 createToolHandlers() 返回的映射表中按 name 查找
        const handler = toolHandlers[block.function.name] ?? (
            mcpToolNames.has(block.function.name)
                ? (kw) => MCP_MGR.callTool(block.function.name, kw)
                : () => 'Unknown tool'
        );
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

**handler 来源**: `createToolHandlers()` 工厂函数 (`route.ts:309-361`)

```typescript
function createToolHandlers(messages, reqId) {
    return {
        // ... 其他工具 ...
        spawn_teammate:      (kw) => TEAM_MGR.spawn(kw.name, kw.role),
        list_teammates:      ()   => TEAM_MGR.listAll(),
        set_teammate_status: (kw) => { TEAM_MGR.setStatus(kw.name, kw.status); return `...`; },
        send_message:        (kw) => BUS.sendInbox(kw.to, 'agent', kw.content),
        read_inbox:          (kw) => BUS.readInbox(kw.name),
    };
}
```

---

## 阶段 3: TeammateManager.spawn()

**入口**: handler 调用 `TEAM_MGR.spawn("tester", "读取并分析文件")`

**代码位置**: `src/lib/agent/managers.ts:911-935`

```typescript
spawn(name: string, role: string) {
    // 3.1 读取 .team/config.json
    const config = this._load();

    // 3.2 查找或创建成员
    let member = config.members.find(m => m.name === name);
    if (member) {
        member.status = 'working';
        member.role = role;
    } else {
        config.members.push({ name, role, status: 'working' });
    }

    // 3.3 持久化到 .team/config.json
    this._save(config);
    // → .team/config.json: { team_name: "default", members: [{ name: "tester", role: "读取并分析文件", status: "working" }] }

    // 3.4 停止旧 runner (如果存在同名子 Agent)
    if (this.runners.has(name)) {
        this.runners.get(name).stop();
    }

    // 3.5 延迟导入 SubAgentRunner (避免 managers.ts ↔ subagent.ts 循环依赖)
    const { SubAgentRunner } = require('./subagent');

    // 3.6 创建 runner 实例
    const runner = new SubAgentRunner("tester", "读取并分析文件");
    this.runners.set("tester", runner);

    // 3.7 启动后台循环 (非阻塞!)
    runner.start();

    return `Spawned 'tester' (role: 读取并分析文件), sub-agent loop started`;
}
```

**关键**: `runner.start()` 是非阻塞的。主 Agent 的 SSE 流立即返回, 子 Agent 在后台独立运行。

---

## 阶段 4: SubAgentRunner.start()

**入口**: `runner.start()` 启动后台异步循环

**代码位置**: `src/lib/agent/subagent.ts:214-222`

```typescript
start(): void {
    if (this.running) return;      // 防止重复启动
    this.running = true;

    // _loop() 返回 Promise, 但不 await — 作为后台任务运行
    // .catch() 捕获致命错误, 防止 unhandled promise rejection
    this._loop().catch(err => {
        console.error(`[SubAgent tester] Fatal error:`, err);
        this.running = false;
        try { TEAM_MGR.setStatus(this.name, 'idle'); } catch {}
    });
}
```

此时 `_loop()` 已在后台开始执行, 主 Agent 继续处理下一条消息。

---

## 阶段 5: _loop() 轮询等待

**入口**: `_loop()` 启动后, inbox 为空, 进入等待状态

**代码位置**: `src/lib/agent/subagent.ts:249-278`

```typescript
private async _loop(): Promise<void> {
    console.log(`[SubAgent tester] Starting (role: 读取并分析文件)`);
    let lastActiveTime = Date.now();

    while (this.running) {
        // 5.1 检查 TeammateManager 中的状态
        const members = TEAM_MGR.listAll();
        const me = members.find(m => m.name === this.name);
        if (!me || me.status === 'idle') {
            console.log(`[SubAgent tester] Status is idle, exiting loop`);
            break;
        }

        // 5.2 读取 inbox (破坏性读取 — 读完清空)
        const inbox = BUS.readInbox("tester");
        // → [] (空的, 主 Agent 还没发消息)

        if (inbox.length === 0) {
            // 5.3 检查空闲超时
            const idleTime = Date.now() - lastActiveTime;
            if (idleTime >= 60_000) {  // 60s 无消息 → 自动停止
                console.log(`[SubAgent tester] Idle for 60s, auto-stopping`);
                TEAM_MGR.setStatus(this.name, 'idle');
                break;
            }

            // 5.4 等待唤醒或 5s 超时
            await this._waitForWake(5_000);
            // → 阻塞在这里, 直到:
            //    a) wake() 被调用 (收到新消息)
            //    b) 5s 超时 (继续下一次轮询)
            continue;
        }
        // ... 有消息时进入阶段 7
    }
}
```

**_waitForWake 实现** (`subagent.ts:326-337`):

```typescript
private _waitForWake(timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
        this.wakeResolve = resolve;
        const timer = setTimeout(() => {
            this.wakeResolve = null;
            resolve();           // 超时 → 继续轮询
        }, timeoutMs);

        this.wakeResolve = () => {
            clearTimeout(timer);
            this.wakeResolve = null;
            resolve();           // 被 wake() 唤醒 → 立即处理消息
        };
    });
}
```

---

## 阶段 6: 主 Agent 发送任务

**入口**: 用户第二条消息 → 主 Agent LLM 返回 `send_message` 工具调用

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
    // → .team/inbox/tester.jsonl 新增一行

    // 6.2 唤醒目标子 Agent (即时响应, 无需等待 5s 轮询)
    try { TEAM_MGR.wakeRunner("tester"); } catch {}

    return `Message sent to 'tester'`;
}
```

**唤醒链**:

```
TEAM_MGR.wakeRunner("tester")                    // managers.ts:948
  → this.runners.get("tester").wake()             // managers.ts:949
    → SubAgentRunner.wake()                        // subagent.ts:235
      → this._resolveWake()                        // subagent.ts:239
        → this.wakeResolve()                       // subagent.ts:331 — resolve _waitForWake 的 Promise
```

此时 `_loop()` 中的 `await this._waitForWake(5_000)` 被提前 resolve, 循环立即继续。

---

## 阶段 7: _loop 被唤醒, 执行任务

**入口**: `_waitForWake` 被 resolve, `_loop` 继续执行

**代码位置**: `src/lib/agent/subagent.ts:280-319`

```typescript
// _loop() 继续 — 上次阻塞在 _waitForWake, 现在被唤醒

// 7.1 再次读取 inbox (破坏性读取)
const inbox = BUS.readInbox("tester");
// → [{ from: "agent", content: "读取 package.json 并总结依赖数量", timestamp: "..." }]

// inbox 不为空 → 进入任务执行

lastActiveTime = Date.now();
console.log(`[SubAgent tester] Received 1 message(s)`);

for (const msg of inbox) {
    const taskContent = msg.content || String(msg);
    // → "读取 package.json 并总结依赖数量"

    console.log(`[SubAgent tester] Processing task: 读取 package.json 并总结依赖数量`);

    try {
        // 7.2 构建初始消息数组
        const messages = [
            { role: 'user', content: "读取 package.json 并总结依赖数量" }
        ];

        // 7.3 构建工具处理器 (排除团队协作工具, 防止递归)
        const toolHandlers = this._buildToolHandlers();
        // → { bash, read_file, write_file, edit_file, TodoWrite, load_skill, ... }

        // 7.4 运行独立的 Agent 循环
        const result = await runAgentLoop({
            messages,
            systemPrompt: this._buildSystemPrompt(),
            tools: SUB_AGENT_TOOLS,       // 16 个工具 (无 spawn/send/read_inbox)
            toolHandlers,
            maxLoops: 10,
            onLog: (m) => console.log(`[SubAgent tester] ${m}`),
        });
        // → 进入阶段 8

        // 7.5 提取最终 assistant 回复
        const lastAssistant = [...result].reverse().find(m => m.role === 'assistant' && m.content);
        const reply = lastAssistant?.content || 'Task completed (no text output)';

        // 7.6 通过 MessageBus 回复主 Agent
        BUS.sendInbox("tester", "agent", reply);
        console.log(`[SubAgent tester] Replied: ${reply.slice(0, 80)}...`);

    } catch (err) {
        // 7.7 执行失败 — 错误信息发回主 Agent
        const errorMsg = `Error: ${err.message}`;
        BUS.sendInbox("tester", "agent", errorMsg);
        console.error(`[SubAgent tester] Task failed:`, err.message);
    }
}

// 回到 while 循环顶部, 继续轮询下一个任务...
```

---

## 阶段 8: runAgentLoop() 独立 LLM 循环

**入口**: `runAgentLoop()` — 子 Agent 独立的 LLM 调用 + 工具执行循环

**代码位置**: `src/lib/agent/subagent.ts:104-172`

子 Agent 拥有独立的 LLM 上下文, 与主 Agent 完全隔离。

### 第一轮 LLM 调用

```typescript
// 8.1 注入 system prompt
messages.unshift({
    role: 'system',
    content: 'You are a sub-agent named "tester" with the role: 读取并分析文件...'
});

// 8.2 微压缩 (新循环, 无需压缩)
microCompact(messages); // → 0

// 8.3 LLM 调用
resp = await client.chat.completions.create({
    model: MODEL,  // 与主 Agent 相同的模型
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
    // → runRead("package.json") → 返回文件内容 (截断到 50000 字符)
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

// LLM 返回:
// → content: "package.json 包含 15 个 dependencies 和 8 个 devDependencies, 共 23 个依赖包。主要依赖包括: next, react, openai, zod 等。"
// → finish_reason: 'stop'  (不再需要工具)
```

### 循环结束

```typescript
// 8.8 finish_reason !== 'tool_calls' → break
messages.push(assistantMsg);
// → messages 数组现在包含完整的对话历史

return messages;
// → 返回给 SubAgentRunner._loop()
```

---

## 阶段 9: 结果回传

**入口**: `runAgentLoop` 返回, `_loop` 提取结果并回复

**代码位置**: `src/lib/agent/subagent.ts:307-313`

```typescript
// runAgentLoop 返回的 messages 数组:
// [
//   { role: 'system', content: '...' },
//   { role: 'user', content: '读取 package.json 并总结依赖数量' },
//   { role: 'assistant', content: '我来读取 package.json 文件', tool_calls: [...] },
//   { role: 'tool', name: 'read_file', content: '{...}' },
//   { role: 'assistant', content: 'package.json 包含 15 个 dependencies 和 8 个 devDependencies...' }
// ]

// 9.1 提取最后一条 assistant 回复
const lastAssistant = [...result].reverse().find(m => m.role === 'assistant' && m.content);
// → { role: 'assistant', content: 'package.json 包含 15 个 dependencies 和 8 个 devDependencies...' }

const reply = lastAssistant.content;
// → "package.json 包含 15 个 dependencies 和 8 个 devDependencies..."

// 9.2 通过 MessageBus 发回主 Agent 的 inbox
BUS.sendInbox("tester", "agent", reply);
```

**sendInbox 内部** (`managers.ts:824-835`):

```typescript
sendInbox(to: "tester", from: "agent", content: "package.json 包含 15 个 dependencies...") {
    // 写入 .team/inbox/agent.jsonl (注意: 是 agent 的 inbox, 不是 tester 的)
    const inboxPath = path.join(INBOX_DIR, `agent.jsonl`);
    const msg = JSON.stringify({
        from: "tester",
        content: "package.json 包含 15 个 dependencies 和 8 个 devDependencies...",
        timestamp: "2026-05-18T10:00:05Z"
    });
    fs.appendFileSync(inboxPath, msg + '\n', 'utf8');

    // 唤醒 agent — 但 agent 是主 Agent, 不是子 Agent, wakeRunner 无操作
    try { TEAM_MGR.wakeRunner("agent"); } catch {}
    // → runners Map 中没有 "agent", 无事发生 (主 Agent 由 SSE 流驱动, 不需要唤醒)

    return `Message sent to 'agent'`;
}
```

---

## 阶段 10: 主 Agent 读取结果

**入口**: 主 Agent LLM 返回 `read_inbox` 工具调用

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

    fs.writeFileSync(inboxPath, '', 'utf8');  // 清空 (破坏性读取)
    return msgs;
}
```

结果注入主 Agent 的 messages 数组, LLM 看到子 Agent 的回复, 生成最终回答:

> "package.json 包含 15 个 dependencies 和 8 个 devDependencies, 共 23 个依赖包..."

---

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

---

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
| `src/lib/agent/subagent.ts:260-266` | `SUB_AGENT_TOOLS` | 子 Agent 工具集 (排除团队工具) |
| `src/lib/agent/subagent.ts:326-337` | `_waitForWake()` | 阻塞等待 — 支持 wake() 即时唤醒 |
| `src/lib/agent/llm-client.ts:1-12` | `client` + `MODEL` | OpenAI 单例 (主 Agent + 子 Agent 共享) |
