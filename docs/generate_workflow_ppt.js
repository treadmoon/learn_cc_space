/**
 * 端到端工作流示例 — PPT 生成脚本
 * 基于 docs/WORKFLOW_EXAMPLE.md 内容
 */
const PptxGenJS = require("pptxgenjs");

const pres = new PptxGenJS();
pres.layout = "LAYOUT_16x9";
pres.title = "端到端工作流示例 — 完整任务模拟";
pres.author = "WorkBuddy Agent";

// ===== 颜色主题 (深蓝科技感) =====
const C = {
  bg:       "0D1B2A",   // 深海军蓝 - 背景
  bgLight:  "122030",   // 略浅背景
  panel:    "1A2E42",   // 面板/卡片背景
  accent1:  "00B4D8",   // 青蓝色 - 主强调
  accent2:  "48CAE4",   // 淡青色 - 次强调
  accent3:  "90E0EF",   // 浅青 - 第三强调
  green:    "06D6A0",   // 翠绿 - 完成/成功
  amber:    "FFB703",   // 琥珀 - 警告/任务
  coral:    "EF476F",   // 珊瑚红 - 重点
  white:    "FFFFFF",
  gray:     "B0C4D8",   // 浅灰蓝
  dimgray:  "7090A8",
  divider:  "1E3A50",
};

// ===== 工具函数 =====
function makeShadow() {
  return { type: "outer", blur: 8, offset: 3, color: "000000", opacity: 0.25, angle: 135 };
}

function addSlideHeader(slide, title, subtitle, phase) {
  // 顶部装饰条
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.06,
    fill: { color: C.accent1 }, line: { color: C.accent1, width: 0 }
  });
  // 阶段标签 (左上角)
  if (phase) {
    slide.addShape(pres.shapes.RECTANGLE, {
      x: 0.3, y: 0.12, w: 1.4, h: 0.3,
      fill: { color: C.accent1 }, line: { color: C.accent1, width: 0 },
      shadow: makeShadow()
    });
    slide.addText(phase, {
      x: 0.3, y: 0.12, w: 1.4, h: 0.3,
      fontSize: 9, bold: true, color: C.bg, align: "center", valign: "middle", margin: 0
    });
  }
  // 标题
  slide.addText(title, {
    x: 0.3, y: 0.55, w: 9.4, h: 0.65,
    fontSize: 28, bold: true, color: C.white, fontFace: "Arial Black", align: "left",
    margin: 0
  });
  // 副标题
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.3, y: 1.22, w: 9.4, h: 0.3,
      fontSize: 13, color: C.accent2, fontFace: "Arial", align: "left", margin: 0
    });
  }
  // 分隔线
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.3, y: 1.55, w: 9.4, h: 0.025,
    fill: { color: C.divider }, line: { color: C.divider, width: 0 }
  });
}

function addCard(slide, x, y, w, h, title, body, titleColor) {
  slide.addShape(pres.shapes.RECTANGLE, {
    x, y, w, h,
    fill: { color: C.panel }, line: { color: C.divider, width: 1 },
    shadow: makeShadow()
  });
  // 左边彩色竖条
  slide.addShape(pres.shapes.RECTANGLE, {
    x, y, w: 0.07, h,
    fill: { color: titleColor || C.accent1 }, line: { color: titleColor || C.accent1, width: 0 }
  });
  if (title) {
    slide.addText(title, {
      x: x + 0.15, y, w: w - 0.2, h: 0.38,
      fontSize: 13, bold: true, color: titleColor || C.accent1, valign: "middle", margin: 0
    });
  }
  if (body) {
    slide.addText(body, {
      x: x + 0.15, y: y + (title ? 0.38 : 0.1), w: w - 0.25, h: h - (title ? 0.42 : 0.15),
      fontSize: 11.5, color: C.gray, valign: "top", margin: 0
    });
  }
}

// ===== 幻灯片 1 — 封面 =====
(function() {
  const slide = pres.addSlide();
  slide.background = { color: C.bg };

  // 背景装饰 — 大圆
  slide.addShape(pres.shapes.OVAL, {
    x: 6.5, y: -1.5, w: 6, h: 6,
    fill: { color: C.accent1, transparency: 88 }, line: { color: C.accent1, width: 0 }
  });
  slide.addShape(pres.shapes.OVAL, {
    x: 7.2, y: -0.8, w: 4, h: 4,
    fill: { color: C.accent2, transparency: 92 }, line: { color: C.accent2, width: 0 }
  });

  // 顶部色条
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.08,
    fill: { color: C.accent1 }, line: { color: C.accent1, width: 0 }
  });

  // 标题区
  slide.addText("端到端工作流示例", {
    x: 0.5, y: 1.2, w: 9, h: 1.1,
    fontSize: 42, bold: true, color: C.white, fontFace: "Arial Black", align: "center",
    shadow: makeShadow()
  });
  slide.addText("完整任务模拟", {
    x: 0.5, y: 2.3, w: 9, h: 0.7,
    fontSize: 26, color: C.accent1, fontFace: "Arial", align: "center"
  });

  // 分隔线
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 3.5, y: 3.1, w: 3, h: 0.04,
    fill: { color: C.accent1 }, line: { color: C.accent1, width: 0 }
  });

  // 副标题描述
  slide.addText("RAG 知识召回 → 持久化任务 → 子任务派生 → 团队协作\n→ 后台任务 → 定时调度 → 文件操作 → 工具调用链", {
    x: 0.5, y: 3.3, w: 9, h: 0.9,
    fontSize: 15, color: C.gray, align: "center", fontFace: "Arial"
  });

  // 底部5个阶段标签
  const phases = [
    { label: "Phase 1", sub: "知识召回\n任务规划", color: C.accent1 },
    { label: "Phase 2", sub: "子任务派生\n团队协作", color: C.accent2 },
    { label: "Phase 3", sub: "后台任务\n定时调度", color: C.amber },
    { label: "Phase 4", sub: "集成\n构建验证", color: C.green },
    { label: "Phase 5", sub: "完成\n知识沉淀", color: C.coral },
  ];
  const bw = 1.6;
  const bGap = 0.1;
  const bStart = (10 - (bw * 5 + bGap * 4)) / 2;
  phases.forEach((p, i) => {
    const bx = bStart + i * (bw + bGap);
    slide.addShape(pres.shapes.RECTANGLE, {
      x: bx, y: 4.4, w: bw, h: 0.85,
      fill: { color: C.panel }, line: { color: p.color, width: 2 },
      shadow: makeShadow()
    });
    slide.addText(p.label, {
      x: bx, y: 4.42, w: bw, h: 0.3,
      fontSize: 10, bold: true, color: p.color, align: "center", margin: 0
    });
    slide.addText(p.sub, {
      x: bx, y: 4.72, w: bw, h: 0.5,
      fontSize: 9, color: C.gray, align: "center", margin: 0
    });
  });
})();

// ===== 幻灯片 2 — 场景设定 =====
(function() {
  const slide = pres.addSlide();
  slide.background = { color: C.bg };
  addSlideHeader(slide, "场景设定", "一个真实的 Agent 编码任务", "背景");

  // 用户指令卡
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.4, y: 1.75, w: 9.2, h: 1.35,
    fill: { color: C.panel }, line: { color: C.accent1, width: 1.5 },
    shadow: makeShadow()
  });
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.4, y: 1.75, w: 0.07, h: 1.35,
    fill: { color: C.accent1 }, line: { color: C.accent1, width: 0 }
  });
  slide.addText("💬  用户指令", {
    x: 0.6, y: 1.8, w: 2, h: 0.3,
    fontSize: 11, bold: true, color: C.accent1, margin: 0
  });
  slide.addText(
    "帮我为这个项目实现一个 WebSocket 实时推送功能，替代当前的 2 秒轮询机制。\n需要：① 参考现有 SSE 实现  ② 后端 WebSocket 服务端  ③ 前端 Hook  ④ 编写测试  ⑤ 跑通构建",
    {
      x: 0.6, y: 2.1, w: 8.9, h: 0.85,
      fontSize: 13.5, color: C.white, fontFace: "Arial", margin: 0
    }
  );

  // 4 项核心系统
  const items = [
    { label: "RAG 知识召回", desc: "先检索，再理解\n现有 SSE 实现模式", color: C.accent1 },
    { label: "持久化任务", desc: "5 个任务，带依赖\n关系自动解锁", color: C.accent2 },
    { label: "多 Agent 协作", desc: "ws-engineer + tester\n并行分工", color: C.amber },
    { label: "后台任务 & Cron", desc: "测试/构建后台跑\n不阻塞主流程", color: C.green },
  ];
  const cw = 2.1;
  const cgap = 0.1;
  const cstart = 0.4;
  items.forEach((item, i) => {
    const cx = cstart + i * (cw + cgap);
    slide.addShape(pres.shapes.RECTANGLE, {
      x: cx, y: 3.3, w: cw, h: 1.5,
      fill: { color: C.panel }, line: { color: item.color, width: 1.5 },
      shadow: makeShadow()
    });
    slide.addShape(pres.shapes.RECTANGLE, {
      x: cx, y: 3.3, w: cw, h: 0.07,
      fill: { color: item.color }, line: { color: item.color, width: 0 }
    });
    slide.addText(item.label, {
      x: cx + 0.1, y: 3.4, w: cw - 0.15, h: 0.38,
      fontSize: 12, bold: true, color: item.color, margin: 0, valign: "middle"
    });
    slide.addText(item.desc, {
      x: cx + 0.1, y: 3.82, w: cw - 0.15, h: 0.9,
      fontSize: 11, color: C.gray, margin: 0
    });
  });

  // 底部系统协同箭头流
  slide.addText("RAG 知识召回  →  持久化任务  →  子任务派生  →  团队协作  →  后台任务  →  定时调度  →  文件操作  →  工具调用链", {
    x: 0.3, y: 5.0, w: 9.4, h: 0.4,
    fontSize: 10, color: C.dimgray, align: "center", margin: 0
  });
})();

// ===== 幻灯片 3 — Phase 1: RAG 知识召回 =====
(function() {
  const slide = pres.addSlide();
  slide.background = { color: C.bg };
  addSlideHeader(slide, "Phase 1 — 知识召回 + 任务规划", "Step 1.1  RAG 检索现有 SSE 实现", "Phase 1");

  // RAG 流程 5步骤
  const steps = [
    { num: "1", title: "Embed 查询", body: "调用 text-embedding-v3\n将查询转为 1536 维浮点向量", color: C.accent1 },
    { num: "2", title: "向量余弦相似度", body: "遍历全部 50 个 chunks\n计算 cosine similarity", color: C.accent2 },
    { num: "3", title: "BM25 关键词评分", body: "tokenize + IDF/TF_norm\n精确关键词匹配", color: C.amber },
    { num: "4", title: "归一化 + 分数融合", body: "向量 0.7 + BM25 0.3\n加权融合 combined score", color: C.green },
    { num: "5", title: "排序取 Top-K", body: "按 combined score 降序\n输出 top 5 相关 chunks", color: C.coral },
  ];

  steps.forEach((s, i) => {
    const sx = 0.3 + i * 1.88;
    slide.addShape(pres.shapes.RECTANGLE, {
      x: sx, y: 1.7, w: 1.7, h: 2.0,
      fill: { color: C.panel }, line: { color: s.color, width: 1.5 },
      shadow: makeShadow()
    });
    // 圆形序号
    slide.addShape(pres.shapes.OVAL, {
      x: sx + 0.6, y: 1.78, w: 0.5, h: 0.5,
      fill: { color: s.color }, line: { color: s.color, width: 0 }
    });
    slide.addText(s.num, {
      x: sx + 0.6, y: 1.78, w: 0.5, h: 0.5,
      fontSize: 16, bold: true, color: C.bg, align: "center", valign: "middle", margin: 0
    });
    slide.addText(s.title, {
      x: sx + 0.07, y: 2.35, w: 1.57, h: 0.4,
      fontSize: 11, bold: true, color: s.color, align: "center", margin: 0
    });
    slide.addText(s.body, {
      x: sx + 0.07, y: 2.75, w: 1.57, h: 0.85,
      fontSize: 9.5, color: C.gray, align: "center", margin: 0
    });
    // 箭头 (不在最后一个后面)
    if (i < steps.length - 1) {
      slide.addShape(pres.shapes.LINE, {
        x: sx + 1.75, y: 2.7, w: 0.07, h: 0,
        line: { color: C.dimgray, width: 1.5 }
      });
      slide.addText("→", {
        x: sx + 1.73, y: 2.56, w: 0.2, h: 0.3,
        fontSize: 13, color: C.dimgray, align: "center", margin: 0
      });
    }
  });

  // 检索结果
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.3, y: 3.85, w: 9.4, h: 1.5,
    fill: { color: C.panel }, line: { color: C.divider, width: 1 },
    shadow: makeShadow()
  });
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.3, y: 3.85, w: 9.4, h: 0.06,
    fill: { color: C.green }, line: { color: C.green, width: 0 }
  });
  slide.addText("✅  检索结果 (Top 5)", {
    x: 0.45, y: 3.9, w: 4, h: 0.3,
    fontSize: 11, bold: true, color: C.green, margin: 0
  });
  const results = [
    "[1] src/app/api/chat/route.ts  (0.92) — SSE 流开启 → Agent 循环 → sendEvent",
    "[2] src/components/ChatPanel.tsx (0.87) — EventSource 监听 SSE 事件",
    "[3] docs/TECHNICAL_DESIGN.md   (0.81) — SSE 协议: state | log | message | done",
    "[4] src/app/api/state/route.ts  (0.76) — ETag 轮询, 2 秒间隔, 条件请求 304",
    "[5] src/app/page.tsx            (0.71) — useEffect setInterval 2s, fetch /api/state",
  ];
  slide.addText(
    results.map(r => ({ text: r, options: { bullet: true, breakLine: true } })),
    { x: 0.45, y: 4.25, w: 9.0, h: 1.05, fontSize: 10, color: C.gray, margin: 0 }
  );
})();

// ===== 幻灯片 4 — Phase 1: 任务创建 + 依赖图 =====
(function() {
  const slide = pres.addSlide();
  slide.background = { color: C.bg };
  addSlideHeader(slide, "Phase 1 — 创建持久化任务体系", "Step 1.2  建立任务依赖关系图", "Phase 1");

  // 5个任务卡片
  const tasks = [
    { id: "#1", title: "WS 服务端实现", desc: "基于 ws 库创建\n/api/ws 路由", color: C.accent1, blockedBy: "—", blocks: "#2, #3" },
    { id: "#2", title: "useWebSocket Hook", desc: "替代 setInterval\n轮询，监听 WS", color: C.accent2, blockedBy: "#1", blocks: "#4" },
    { id: "#3", title: "单元测试编写", desc: "WS 服务端测试\n+ Hook 测试", color: C.amber, blockedBy: "#1", blocks: "#5" },
    { id: "#4", title: "集成替换轮询", desc: "移除 setInterval\n接入 useWebSocket", color: C.green, blockedBy: "#1,#2", blocks: "#5" },
    { id: "#5", title: "构建验证", desc: "pnpm build\nTypeScript 编译", color: C.coral, blockedBy: "#3,#4", blocks: "—" },
  ];

  const tw = 1.65;
  const tgap = 0.13;
  const tstart = 0.3;
  tasks.forEach((t, i) => {
    const tx = tstart + i * (tw + tgap);
    slide.addShape(pres.shapes.RECTANGLE, {
      x: tx, y: 1.75, w: tw, h: 2.4,
      fill: { color: C.panel }, line: { color: t.color, width: 1.5 },
      shadow: makeShadow()
    });
    slide.addShape(pres.shapes.RECTANGLE, {
      x: tx, y: 1.75, w: tw, h: 0.05,
      fill: { color: t.color }, line: { color: t.color, width: 0 }
    });
    slide.addText(t.id, {
      x: tx + 0.05, y: 1.8, w: 0.5, h: 0.32,
      fontSize: 13, bold: true, color: t.color, margin: 0
    });
    slide.addText(t.title, {
      x: tx + 0.08, y: 2.12, w: tw - 0.12, h: 0.42,
      fontSize: 11, bold: true, color: C.white, margin: 0
    });
    slide.addText(t.desc, {
      x: tx + 0.08, y: 2.55, w: tw - 0.12, h: 0.55,
      fontSize: 9.5, color: C.gray, margin: 0
    });
    slide.addText("blockedBy: " + t.blockedBy, {
      x: tx + 0.08, y: 3.14, w: tw - 0.12, h: 0.25,
      fontSize: 9, color: C.amber, margin: 0
    });
    slide.addText("blocks: " + t.blocks, {
      x: tx + 0.08, y: 3.4, w: tw - 0.12, h: 0.25,
      fontSize: 9, color: C.accent2, margin: 0
    });
  });

  // 依赖流程
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.3, y: 4.28, w: 9.4, h: 1.08,
    fill: { color: C.panel }, line: { color: C.divider, width: 1 }
  });
  slide.addText("任务依赖关系：", {
    x: 0.5, y: 4.33, w: 2, h: 0.25,
    fontSize: 10, bold: true, color: C.accent1, margin: 0
  });
  slide.addText(
    "#1 WS服务端  →  #2 Hook  →  #4 集成替换  →  #5 构建验证\n               └→  #3 测试 ──────────────────────↗",
    {
      x: 0.5, y: 4.6, w: 9.0, h: 0.65,
      fontSize: 11, color: C.gray, fontFace: "Courier New", margin: 0
    }
  );
})();

// ===== 幻灯片 5 — Phase 2: 子 Agent 派生 =====
(function() {
  const slide = pres.addSlide();
  slide.background = { color: C.bg };
  addSlideHeader(slide, "Phase 2 — 子任务派生 + 团队协作", "Step 2.1~2.3  并行派发给两个子 Agent", "Phase 2");

  // 主 Agent 卡
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 3.5, y: 1.75, w: 3.0, h: 0.85,
    fill: { color: C.panel }, line: { color: C.accent1, width: 2 },
    shadow: makeShadow()
  });
  slide.addText("🤖  主 Agent (Lead)", {
    x: 3.5, y: 1.85, w: 3.0, h: 0.35,
    fontSize: 13, bold: true, color: C.accent1, align: "center", margin: 0
  });
  slide.addText("bash (cat SSE代码) → team_spawn ×2", {
    x: 3.5, y: 2.2, w: 3.0, h: 0.3,
    fontSize: 9.5, color: C.gray, align: "center", margin: 0
  });

  // 箭头 向下分叉
  slide.addShape(pres.shapes.LINE, { x: 3.8, y: 2.6, w: 0, h: 0.4, line: { color: C.accent1, width: 2 } });
  slide.addShape(pres.shapes.LINE, { x: 6.2, y: 2.6, w: 0, h: 0.4, line: { color: C.amber, width: 2 } });
  slide.addShape(pres.shapes.LINE, { x: 3.8, y: 3.0, w: 2.4, h: 0, line: { color: C.dimgray, width: 1.5 } });

  // ws-engineer 子 Agent
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.3, y: 3.0, w: 4.0, h: 2.3,
    fill: { color: C.panel }, line: { color: C.accent1, width: 1.5 },
    shadow: makeShadow()
  });
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.3, y: 3.0, w: 4.0, h: 0.05,
    fill: { color: C.accent1 }, line: { color: C.accent1, width: 0 }
  });
  slide.addText("🔧  ws-engineer (独立窗口)", {
    x: 0.45, y: 3.06, w: 3.7, h: 0.35,
    fontSize: 12, bold: true, color: C.accent1, margin: 0
  });
  const wsSteps = [
    "read_file → 了解 SSE sendEvent 模式",
    "knowledge_search → ws 库 API",
    "write_file → src/app/api/ws/route.ts",
    "bash → pnpm add ws (安装依赖)",
    "write_file → src/lib/ws-broadcaster.ts",
    "inbox → 写入完成结果"
  ];
  wsSteps.forEach((s, i) => {
    slide.addText("▸ " + s, {
      x: 0.45, y: 3.45 + i * 0.29, w: 3.7, h: 0.28,
      fontSize: 9.5, color: i === 5 ? C.green : C.gray, margin: 0
    });
  });

  // tester 子 Agent
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 5.7, y: 3.0, w: 4.0, h: 2.3,
    fill: { color: C.panel }, line: { color: C.amber, width: 1.5 },
    shadow: makeShadow()
  });
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 5.7, y: 3.0, w: 4.0, h: 0.05,
    fill: { color: C.amber }, line: { color: C.amber, width: 0 }
  });
  slide.addText("🧪  tester (独立窗口)", {
    x: 5.85, y: 3.06, w: 3.7, h: 0.35,
    fontSize: 12, bold: true, color: C.amber, margin: 0
  });
  const testerSteps = [
    "read_file → 了解现有测试结构",
    "bash → ls src/**/*.test.ts",
    "write_file → ws-broadcaster.test.ts (3 cases)",
    "write_file → useWebSocket.test.ts (4 cases)",
    "inbox → 写入测试完成结果"
  ];
  testerSteps.forEach((s, i) => {
    slide.addText("▸ " + s, {
      x: 5.85, y: 3.45 + i * 0.34, w: 3.7, h: 0.32,
      fontSize: 9.5, color: i === 4 ? C.green : C.gray, margin: 0
    });
  });

  // 并行标签
  slide.addText("⚡ 并行执行", {
    x: 4.3, y: 3.6, w: 1.4, h: 0.35,
    fontSize: 10, bold: true, color: C.coral, align: "center", margin: 0
  });
})();

// ===== 幻灯片 6 — Phase 3: 后台任务 + 定时调度 =====
(function() {
  const slide = pres.addSlide();
  slide.background = { color: C.bg };
  addSlideHeader(slide, "Phase 3 — 后台任务 + 定时调度", "Step 3.1~3.4  测试后台跑，主 Agent 继续工作", "Phase 3");

  // 左：后台任务流
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.3, y: 1.75, w: 4.4, h: 3.5,
    fill: { color: C.panel }, line: { color: C.amber, width: 1.5 },
    shadow: makeShadow()
  });
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.3, y: 1.75, w: 4.4, h: 0.05,
    fill: { color: C.amber }, line: { color: C.amber, width: 0 }
  });
  slide.addText("🚀  后台任务 (BG_MGR)", {
    x: 0.45, y: 1.8, w: 4.1, h: 0.35,
    fontSize: 12, bold: true, color: C.amber, margin: 0
  });
  const bgItems = [
    { text: "调用 background_run (pnpm test --run)", color: C.white },
    { text: "tid = 'a1b2c3d4' 子进程启动", color: C.gray },
    { text: "主 Agent 不等待，继续写 useWebSocket.ts", color: C.accent2 },
    { text: "─────────────────────────────", color: C.divider },
    { text: "测试完成: ✓ 7 passed, 0 failed", color: C.green },
    { text: "BG_MGR.notifications.push()", color: C.gray },
    { text: "下次 drain() 注入 <background-results>", color: C.gray },
    { text: "─────────────────────────────", color: C.divider },
    { text: "调用 background_run (pnpm build)", color: C.white },
    { text: "tid = 'i9j0k1l2' 构建后台启动", color: C.gray },
  ];
  bgItems.forEach((item, i) => {
    slide.addText((item.color === C.divider ? "" : "▸ ") + item.text, {
      x: 0.45, y: 2.2 + i * 0.29, w: 4.1, h: 0.27,
      fontSize: 9.5, color: item.color, margin: 0, fontFace: item.color === C.divider ? "Courier New" : "Arial"
    });
  });

  // 右：定时调度
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 5.0, y: 1.75, w: 4.7, h: 1.8,
    fill: { color: C.panel }, line: { color: C.coral, width: 1.5 },
    shadow: makeShadow()
  });
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 5.0, y: 1.75, w: 4.7, h: 0.05,
    fill: { color: C.coral }, line: { color: C.coral, width: 0 }
  });
  slide.addText("⏰  定时调度 (CRON_MGR)", {
    x: 5.15, y: 1.8, w: 4.35, h: 0.35,
    fontSize: 12, bold: true, color: C.coral, margin: 0
  });
  const cronItems = [
    "cron_schedule: ws-health-check",
    "间隔: 30000ms (30秒)",
    "命令: curl localhost:3000/api/ws",
    "委托 BG_MGR.run() 执行检查",
    "每次结果注入 drain 通知"
  ];
  cronItems.forEach((item, i) => {
    slide.addText("▸ " + item, {
      x: 5.15, y: 2.2 + i * 0.26, w: 4.35, h: 0.25,
      fontSize: 9.5, color: C.gray, margin: 0
    });
  });

  // 右下：通知消费机制
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 5.0, y: 3.7, w: 4.7, h: 1.55,
    fill: { color: C.panel }, line: { color: C.green, width: 1.5 },
    shadow: makeShadow()
  });
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 5.0, y: 3.7, w: 4.7, h: 0.05,
    fill: { color: C.green }, line: { color: C.green, width: 0 }
  });
  slide.addText("📬  通知 Drain 机制", {
    x: 5.15, y: 3.75, w: 4.35, h: 0.35,
    fontSize: 12, bold: true, color: C.green, margin: 0
  });
  slide.addText(
    "消费者1: Agent循环 → drain() → 注入 <background-results> 消息\n消费者2: State API → drain() → 推送给 UI 客户端\n保证通知不丢失，两个消费者至少一个收到",
    {
      x: 5.15, y: 4.15, w: 4.4, h: 1.0,
      fontSize: 10, color: C.gray, margin: 0
    }
  );
})();

// ===== 幻灯片 7 — Phase 4: 集成 + 构建 =====
(function() {
  const slide = pres.addSlide();
  slide.background = { color: C.bg };
  addSlideHeader(slide, "Phase 4 — 集成 + 构建验证", "Step 4.1~4.3  替换轮询，后台构建，压缩上下文", "Phase 4");

  // 左：集成替换
  addCard(slide, 0.3, 1.75, 4.4, 2.2,
    "🔄  Step 4.1 — 集成替换",
    "read_file → 定位 page.tsx 轮询代码\nedit_file → 注释掉 setInterval 2s 轮询\nimport useWebSocket Hook\nuseWebSocket((data) => { ... }) 接管状态\ntask_update({ id: 4, status: 'completed' })",
    C.green
  );

  // 右：构建验证
  addCard(slide, 5.0, 1.75, 4.7, 2.2,
    "🏗️  Step 4.2 — 后台构建验证",
    "background_run('pnpm build 2>&1', timeout: 300)\ntid = 'i9j0k1l2' → 后台启动\nAgent 不阻塞，同时调用 compress()\n压缩历史工具调用，保留最近 4 条消息\nread_file 结果保留不压缩",
    C.amber
  );

  // 构建结果
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.3, y: 4.1, w: 9.4, h: 1.2,
    fill: { color: C.panel }, line: { color: C.green, width: 1.5 },
    shadow: makeShadow()
  });
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.3, y: 4.1, w: 9.4, h: 0.05,
    fill: { color: C.green }, line: { color: C.green, width: 0 }
  });
  slide.addText("✅  构建成功 — BG_MGR callback 触发", {
    x: 0.5, y: 4.15, w: 4, h: 0.3,
    fontSize: 11, bold: true, color: C.green, margin: 0
  });
  slide.addText(
    "✓ Compiled successfully    Route: /   5.2kB  |  /api/chat  |  /api/ws  |  /api/state\n" +
    "drain() → 注入 <background-results> → LLM 看到成功 → task_update(#5, completed) → 最终回复",
    {
      x: 0.5, y: 4.5, w: 9.0, h: 0.7,
      fontSize: 10.5, color: C.gray, fontFace: "Courier New", margin: 0
    }
  );
})();

// ===== 幻灯片 8 — Phase 5: 知识沉淀 + 最终结果 =====
(function() {
  const slide = pres.addSlide();
  slide.background = { color: C.bg };
  addSlideHeader(slide, "Phase 5 — 完成 + 知识沉淀", "Step 5.1~5.3  ingest → artifact → 最终回复", "Phase 5");

  // 3个步骤卡
  const steps5 = [
    {
      title: "📥  知识库导入",
      sub: "knowledge_ingest",
      items: [
        "src/app/api/ws/route.ts → 3 chunks",
        "src/hooks/useWebSocket.ts → 2 chunks",
        "共 5 个新 chunk 导入向量库",
        "下次遇到 WS 相关任务直接命中",
      ],
      color: C.accent1
    },
    {
      title: "🗃️  制品归档",
      sub: "artifact_save",
      items: [
        "taskId: 1 → .artifacts/task_1_ws-route.ts",
        "代码实现永久归档可追溯",
        "关联任务 ID 便于审计",
        "完整可追溯链路",
      ],
      color: C.accent2
    },
    {
      title: "💬  最终回复",
      sub: "SSE message 事件",
      items: [
        "新增: ws/route.ts, ws-broadcaster.ts",
        "新增: useWebSocket.ts, ×2 测试文件",
        "修改: page.tsx (替换 2s 轮询)",
        "测试: 7 passed  |  构建: ✓ Success",
      ],
      color: C.green
    },
  ];

  steps5.forEach((s, i) => {
    const sx = 0.3 + i * 3.17;
    slide.addShape(pres.shapes.RECTANGLE, {
      x: sx, y: 1.75, w: 2.9, h: 3.0,
      fill: { color: C.panel }, line: { color: s.color, width: 1.5 },
      shadow: makeShadow()
    });
    slide.addShape(pres.shapes.RECTANGLE, {
      x: sx, y: 1.75, w: 2.9, h: 0.05,
      fill: { color: s.color }, line: { color: s.color, width: 0 }
    });
    slide.addText(s.title, {
      x: sx + 0.1, y: 1.8, w: 2.7, h: 0.38,
      fontSize: 12, bold: true, color: s.color, margin: 0
    });
    slide.addText(s.sub, {
      x: sx + 0.1, y: 2.18, w: 2.7, h: 0.28,
      fontSize: 9.5, color: C.dimgray, margin: 0
    });
    s.items.forEach((item, j) => {
      slide.addText("▸ " + item, {
        x: sx + 0.1, y: 2.5 + j * 0.5, w: 2.7, h: 0.45,
        fontSize: 10.5, color: C.gray, margin: 0
      });
    });
  });

  // 知识闭环说明
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.3, y: 4.88, w: 9.4, h: 0.5,
    fill: { color: C.panel }, line: { color: C.accent1, width: 1 }
  });
  slide.addText("💡  知识闭环：先检索 RAG → 理解执行 → 再 ingest 新实现 → 下次任务可直接命中，形成正反馈循环", {
    x: 0.5, y: 4.93, w: 9.0, h: 0.38,
    fontSize: 11, color: C.accent2, align: "center", margin: 0
  });
})();

// ===== 幻灯片 9 — 完整调用链时序图 =====
(function() {
  const slide = pres.addSlide();
  slide.background = { color: C.bg };
  addSlideHeader(slide, "完整调用链时序图", "各角色并行协作全景", "时序");

  // 角色标题
  const roles = ["用户", "主Agent", "ws-engineer", "tester", "BG_MGR", "CRON_MGR"];
  const roleColors = [C.white, C.accent1, C.accent2, C.amber, C.green, C.coral];
  const roleX = [0.25, 1.7, 3.2, 4.7, 6.2, 7.7];
  const lineW = 0.8;

  roles.forEach((r, i) => {
    slide.addShape(pres.shapes.RECTANGLE, {
      x: roleX[i], y: 1.7, w: lineW, h: 0.36,
      fill: { color: C.panel }, line: { color: roleColors[i], width: 1 },
      shadow: makeShadow()
    });
    slide.addText(r, {
      x: roleX[i], y: 1.7, w: lineW, h: 0.36,
      fontSize: 9.5, bold: true, color: roleColors[i], align: "center", valign: "middle", margin: 0
    });
    // 竖线
    slide.addShape(pres.shapes.LINE, {
      x: roleX[i] + lineW / 2, y: 2.06, w: 0, h: 3.3,
      line: { color: roleColors[i], width: 1, dashType: "dash" }
    });
  });

  // 时序事件行
  const events = [
    { y: 2.25, from: 0, to: 1, label: "发送消息", color: C.white },
    { y: 2.55, from: 1, to: 1, label: "knowledge_search → knowledge召回", color: C.accent1 },
    { y: 2.85, from: 1, to: 1, label: "task_create ×5, TodoWrite", color: C.accent1 },
    { y: 3.15, from: 1, to: 2, label: "team_spawn: ws-engineer", color: C.accent2 },
    { y: 3.15, from: 1, to: 3, label: "team_spawn: tester (并行)", color: C.amber },
    { y: 3.45, from: 2, to: 4, label: "ws-engineer: read/write/bash", color: C.accent2 },
    { y: 3.45, from: 3, to: 4, label: "tester: read/bash/write ×2", color: C.amber },
    { y: 3.75, from: 1, to: 4, label: "background_run (pnpm test)", color: C.green },
    { y: 4.05, from: 1, to: 1, label: "write Hook + edit_file (集成)", color: C.accent1 },
    { y: 4.35, from: 1, to: 4, label: "background_run (pnpm build)", color: C.amber },
    { y: 4.65, from: 4, to: 1, label: "drain: 测试7 passed, 构建✓", color: C.green },
    { y: 4.95, from: 1, to: 5, label: "cron_schedule: ws-health-check (30s)", color: C.coral },
  ];

  events.forEach(ev => {
    const x1 = roleX[ev.from] + lineW / 2;
    const x2 = roleX[ev.to] + lineW / 2;
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    if (ev.from !== ev.to) {
      slide.addShape(pres.shapes.LINE, {
        x: minX, y: ev.y, w: maxX - minX, h: 0,
        line: { color: ev.color, width: 1.2 }
      });
      // 箭头文字
      const midX = (x1 + x2) / 2;
      slide.addText(ev.label, {
        x: Math.min(x1, x2) - 0.05, y: ev.y - 0.22, w: Math.abs(x2 - x1) + 0.1, h: 0.22,
        fontSize: 7.5, color: ev.color, align: "center", margin: 0
      });
    } else {
      slide.addText("⟳  " + ev.label, {
        x: x1 - 0.1, y: ev.y - 0.15, w: 2.5, h: 0.2,
        fontSize: 8, color: ev.color, margin: 0
      });
    }
  });
})();

// ===== 幻灯片 10 — 系统交互汇总 =====
(function() {
  const slide = pres.addSlide();
  slide.background = { color: C.bg };
  addSlideHeader(slide, "系统交互汇总", "各系统在本案例中的角色", "汇总");

  const rows = [
    ["系统", "使用时机", "工具/方法", "作用"],
    ["RAG 知识召回", "Phase 1 开始", "knowledge_search", "检索 SSE 实现作为参考"],
    ["RAG 知识沉淀", "Phase 5 结束", "knowledge_ingest", "将新实现导入知识库"],
    ["持久化任务", "Phase 1~4", "task_create / update", "创建任务体系 + 状态跟踪"],
    ["子任务派生", "Phase 2", "TeammateManager.spawn()", "派生 ws-engineer / tester"],
    ["团队协作", "Phase 2", "MessageBus (inbox)", "子 Agent 写入结果 → 主 Agent 读取"],
    ["后台任务", "Phase 3~4", "background_run", "测试/构建后台跑，不阻塞主流程"],
    ["通知 Drain", "Phase 3~4", "BG_MGR.drain()", "测试/构建结果注入 Agent 上下文"],
    ["定时调度", "Phase 3", "cron_schedule", "30s 健康检查 WebSocket 连接"],
    ["上下文压缩", "Phase 4", "compress()", "清理冗余历史，保留关键信息"],
    ["SSE 流", "全程", "SSE events", "实时推送状态/日志/消息给客户端"],
  ];

  const colW = [2.0, 1.6, 2.1, 3.4];
  const colX = [0.25, 2.3, 3.95, 6.1];
  const rowH = 0.36;
  const startY = 1.72;

  rows.forEach((row, ri) => {
    row.forEach((cell, ci) => {
      const isHeader = ri === 0;
      const bg = isHeader ? C.accent1 : (ri % 2 === 0 ? C.bgLight : C.panel);
      const fc = isHeader ? C.bg : (ci === 0 ? C.accent2 : C.gray);
      slide.addShape(pres.shapes.RECTANGLE, {
        x: colX[ci], y: startY + ri * rowH, w: colW[ci], h: rowH,
        fill: { color: bg }, line: { color: C.divider, width: 0.5 }
      });
      slide.addText(cell, {
        x: colX[ci] + 0.07, y: startY + ri * rowH, w: colW[ci] - 0.1, h: rowH,
        fontSize: isHeader ? 11 : 9.5, bold: isHeader, color: fc,
        valign: "middle", margin: 0
      });
    });
  });
})();

// ===== 幻灯片 11 — 设计要点 =====
(function() {
  const slide = pres.addSlide();
  slide.background = { color: C.bg };
  addSlideHeader(slide, "设计要点", "六大核心设计原则", "原则");

  const principles = [
    {
      num: "01", title: "并行优先",
      desc: "子 Agent 并行执行 (ws-engineer + tester 同时工作)\n后台任务不阻塞主 Agent 主流程",
      color: C.accent1
    },
    {
      num: "02", title: "通知不丢失",
      desc: "drain 机制保证两个消费者至少一个收到通知\nETag 缓存不影响通知投递",
      color: C.accent2
    },
    {
      num: "03", title: "上下文隔离",
      desc: "子 Agent 独立窗口，不污染主 Agent 上下文\n结果按需注入，精准控制信息量",
      color: C.amber
    },
    {
      num: "04", title: "知识循环",
      desc: "先检索 (RAG) → 执行 → 再沉淀 (ingest)\n形成知识正反馈闭环",
      color: C.green
    },
    {
      num: "05", title: "任务可追溯",
      desc: "依赖图 + 审计日志 + 制品归档\n完整链路，每步操作均有记录",
      color: C.coral
    },
    {
      num: "06", title: "状态实时同步",
      desc: "SSE 流 + 2s 轮询 + ETag 缓存\n兼顾实时性与带宽效率",
      color: C.accent3
    },
  ];

  const cols = 3;
  const cw = 3.0;
  const ch = 1.65;
  const cgapX = 0.2;
  const cgapY = 0.18;
  const startX = 0.3;
  const startY = 1.75;

  principles.forEach((p, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const px = startX + col * (cw + cgapX);
    const py = startY + row * (ch + cgapY);

    slide.addShape(pres.shapes.RECTANGLE, {
      x: px, y: py, w: cw, h: ch,
      fill: { color: C.panel }, line: { color: p.color, width: 1.5 },
      shadow: makeShadow()
    });
    slide.addShape(pres.shapes.RECTANGLE, {
      x: px, y: py, w: cw, h: 0.05,
      fill: { color: p.color }, line: { color: p.color, width: 0 }
    });
    // 序号圆
    slide.addShape(pres.shapes.OVAL, {
      x: px + 0.12, y: py + 0.1, w: 0.44, h: 0.44,
      fill: { color: p.color }, line: { color: p.color, width: 0 }
    });
    slide.addText(p.num, {
      x: px + 0.12, y: py + 0.1, w: 0.44, h: 0.44,
      fontSize: 11, bold: true, color: C.bg, align: "center", valign: "middle", margin: 0
    });
    slide.addText(p.title, {
      x: px + 0.65, y: py + 0.12, w: cw - 0.75, h: 0.4,
      fontSize: 14, bold: true, color: p.color, margin: 0, valign: "middle"
    });
    slide.addText(p.desc, {
      x: px + 0.12, y: py + 0.6, w: cw - 0.2, h: ch - 0.65,
      fontSize: 10.5, color: C.gray, margin: 0
    });
  });
})();

// ===== 幻灯片 12 — 总结 =====
(function() {
  const slide = pres.addSlide();
  slide.background = { color: C.bg };

  // 装饰圆
  slide.addShape(pres.shapes.OVAL, {
    x: -1, y: -1, w: 5, h: 5,
    fill: { color: C.accent1, transparency: 90 }, line: { color: C.accent1, width: 0 }
  });
  slide.addShape(pres.shapes.OVAL, {
    x: 7, y: 2, w: 5, h: 5,
    fill: { color: C.coral, transparency: 90 }, line: { color: C.coral, width: 0 }
  });

  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.08,
    fill: { color: C.accent1 }, line: { color: C.accent1, width: 0 }
  });

  slide.addText("总结", {
    x: 0.5, y: 0.5, w: 9, h: 0.65,
    fontSize: 36, bold: true, color: C.white, fontFace: "Arial Black", align: "center"
  });

  // 流程概要
  slide.addText("RAG 知识召回  →  持久化任务(×5)  →  子任务派生  →  并行协作", {
    x: 0.5, y: 1.4, w: 9, h: 0.35,
    fontSize: 13, color: C.accent1, align: "center"
  });
  slide.addText("→  后台任务  →  Cron定时调度  →  集成构建  →  知识沉淀", {
    x: 0.5, y: 1.75, w: 9, h: 0.35,
    fontSize: 13, color: C.accent2, align: "center"
  });

  slide.addShape(pres.shapes.RECTANGLE, {
    x: 2.5, y: 2.2, w: 5, h: 0.04,
    fill: { color: C.accent1 }, line: { color: C.accent1, width: 0 }
  });

  // 关键数字
  const metrics = [
    { val: "5", label: "持久化任务\n带依赖关系图", color: C.accent1 },
    { val: "2", label: "并行子 Agent\nws-engineer + tester", color: C.amber },
    { val: "7", label: "单测通过\n全部 0 失败", color: C.green },
    { val: "5", label: "知识库 chunks\n新增导入", color: C.coral },
  ];

  metrics.forEach((m, i) => {
    const mx = 0.5 + i * 2.3;
    slide.addShape(pres.shapes.OVAL, {
      x: mx + 0.4, y: 2.45, w: 1.3, h: 1.3,
      fill: { color: C.panel }, line: { color: m.color, width: 2 },
      shadow: makeShadow()
    });
    slide.addText(m.val, {
      x: mx + 0.4, y: 2.45, w: 1.3, h: 1.3,
      fontSize: 40, bold: true, color: m.color, align: "center", valign: "middle", margin: 0
    });
    slide.addText(m.label, {
      x: mx, y: 3.85, w: 2.1, h: 0.65,
      fontSize: 10, color: C.gray, align: "center", margin: 0
    });
  });

  slide.addText("WorkBuddy Agent — 端到端自主任务执行", {
    x: 0.5, y: 5.0, w: 9, h: 0.35,
    fontSize: 12, color: C.dimgray, align: "center"
  });
})();

// ===== 输出文件 =====
const outputPath = "/Users/meil/codeSpace/learn_cc_space/docs/workflow_example.pptx";
pres.writeFile({ fileName: outputPath })
  .then(() => console.log("✅  PPT 已生成:", outputPath))
  .catch(err => { console.error("❌  生成失败:", err); process.exit(1); });
