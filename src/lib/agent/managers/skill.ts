import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * SkillLoader — 技能文件加载器
 *
 * 技能 (Skill) ≠ 工具 (Tool):
 *   - Tool: 可执行的函数 (如 bash, read_file), 产生副作用
 *   - Skill: Markdown 知识文档, 注入上下文供 LLM 参考, 不执行任何操作
 *
 * 存储: skills/{name}/SKILL.md (带 YAML frontmatter)
 * 格式:
 *   ---
 *   name: my-skill
 *   description: 一行描述
 *   ---
 *   技能正文 (Markdown)
 *
 * 调用: LLM 调用 load_skill(name) → 返回 <skill> 标签包裹的 Markdown 文本
 * 加载时机: 进程启动时一次性扫描 skills/ 目录, 运行时不重新加载
 */
export class SkillLoader {
    /** 已加载的技能 { 技能名 → { meta: YAML 元信息, body: Markdown 正文 } } */
    public skills: Record<string, { meta: any; body: string }> = {};

    /**
     * 构造函数 — 进程启动时一次性扫描 skills/ 目录
     * 运行时不重新加载 (技能文件是静态知识, 不会动态变化)
     */
    constructor(skillsDir: string) {
        this._loadSkills(skillsDir);
    }

    /**
     * 扫描 skills/ 目录并加载所有 SKILL.md 文件
     *
     * 目录约定:
     *   skills/
     *   ├── frontend-design/
     *   │   └── SKILL.md        ← 子目录名即技能名 (除非 YAML 中指定了 name)
     *   ├── data-pipeline/
     *   │   └── SKILL.md
     *   └── ...
     *
     * 文件格式 (YAML frontmatter + Markdown 正文):
     *   ---
     *   name: my-skill           ← 可选, 不写则用目录名
     *   description: 一行描述    ← 可选, 供 descriptions() 展示
     *   ---
     *   # 技能正文
     *   这里是 Markdown 内容...
     *
     * 解析流程:
     *   1. 列出 skillsDir 下的所有子目录
     *   2. 筛选出包含 SKILL.md 的子目录
     *   3. 逐个读取: 用正则分离 frontmatter 和 body
     *   4. 手动解析 frontmatter (逐行按冒号分割, 不依赖 YAML 库)
     *   5. 技能名优先取 meta.name, 否则用目录名
     */
    private _loadSkills(skillsDir: string) {
        // skillsDir 不存在时静默返回 (项目可能没有自定义技能)
        if (!fs.existsSync(skillsDir)) return;

        // Step 1: 列出所有子目录
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

        // Step 2: 筛选包含 SKILL.md 的子目录 → 得到文件路径数组
        const skillFiles = entries.filter(e => e.isDirectory())
             .map(e => path.join(skillsDir, e.name, 'SKILL.md'))
             .filter(p => fs.existsSync(p));

        // Step 3: 逐个解析
        for (const file of skillFiles.sort()) {
            const text = fs.readFileSync(file, 'utf8');

            // Step 4: 用正则分离 YAML frontmatter 和 Markdown 正文
            // 匹配: ---\n{frontmatter}\n---\n{body}
            const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
            let meta: any = {};
            let body = text;  // 默认: 整个文件作为 body (无 frontmatter 时)

            if (match) {
                // 手动解析 frontmatter — 逐行按首个冒号分割
                // 为什么不用 YAML 库? 减少依赖, 且 frontmatter 格式简单 (key: value)
                const frontmatter = match[1];
                for (const line of frontmatter.trim().split('\n')) {
                    const colonIdx = line.indexOf(':');
                    if (colonIdx !== -1) {
                        const key = line.slice(0, colonIdx).trim();
                        const value = line.slice(colonIdx + 1).trim();
                        meta[key] = value;
                    }
                }
                body = match[2].trim();
            }

            // Step 5: 技能名 — 优先取 YAML 中的 name, 否则用父目录名
            // 例: skills/frontend-design/SKILL.md → name = meta.name || 'frontend-design'
            const name = meta.name || path.basename(path.dirname(file));
            this.skills[name] = { meta, body };
        }
    }

    /**
     * 生成技能描述列表 — 供 LLM 查看有哪些技能可用
     *
     * 输出格式:
     *   (no skills)                           ← 无技能时
     *   或
     *   - frontend-design: 前端设计指导       ← 有技能时
     *   - data-pipeline: 数据管道设计
     *
     * 调用时机: Agent 系统提示词中可能引用, 或 LLM 调用 load_skill 前参考
     */
    descriptions(): string {
        if (!Object.keys(this.skills).length) return '(no skills)';
        return Object.entries(this.skills)
            .map(([n, s]) => `  - ${n}: ${s.meta.description || '-'}`)
            .join('\n');
    }

    /**
     * 加载指定技能 — 返回 <skill> 标签包裹的 Markdown 正文
     *
     * LLM 调用 load_skill(name) 时触发:
     *   1. 在 this.skills 中查找
     *   2. 找到 → 返回 <skill name="xxx">正文</skill>
     *   3. 未找到 → 返回错误提示 + 可用技能列表 (帮助 LLM 自行修正)
     *
     * 为什么用 <skill> 标签包裹?
     *   - 与普通对话内容区分开, LLM 能识别这是"参考资料"而非"用户消息"
     *   - 类似 XML 的结构化标签是 LLM 熟悉的格式
     *
     * @param name  技能名 (对应 YAML 中的 name 或目录名)
     * @returns     <skill> 标签包裹的正文, 或错误提示
     */
    load(name: string): string {
        const skill = this.skills[name];
        if (!skill) {
            return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(', ')}`;
        }
        return `<skill name="${name}">\n${skill.body}\n</skill>`;
    }
}
