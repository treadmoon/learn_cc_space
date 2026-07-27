import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdirSync } from '../tools/fs';

const WORKDIR = process.cwd();
const TEAM_DIR = path.join(WORKDIR, '.team');

/**
 * TeammateManager — 团队成员管理 + SubAgent 生命周期
 *
 * 存储: .team/config.json (JSON 配置文件)
 * 成员状态: working(执行中) / idle(空闲)
 *
 * 生命周期:
 *   spawn(name, role) → 注册成员 + 设为 working + 启动 SubAgentRunner
 *   setStatus(name, 'idle') → 标记为空闲 + 停止 SubAgentRunner
 *   wakeRunner(name) → 唤醒子 Agent 轮询 (收到新消息时)
 *
 * 与子 Agent 的协作流程:
 *   1. 主 Agent 调用 spawn() → 注册 + 启动后台 LLM 循环
 *   2. 主 Agent 调用 send_message() → 写入 inbox + 唤醒子 Agent
 *   3. 子 Agent 收到消息 → 运行 agent loop → 结果发回主 Agent inbox
 *   4. 主 Agent 调用 read_inbox() → 读取子 Agent 的回复
 *   5. 主 Agent 调用 setStatus('idle') → 终止子 Agent 循环
 */
export class TeammateManager {
    public configPath: string;
    /** 活跃的子 Agent 运行器 — 按成员名索引 */
    private runners: Map<string, any>;  // any: 避免循环导入 SubAgentRunner 类型
    /** 最大团队成员数 — 防止无限递归创建 */
    private static readonly MAX_TEAM_SIZE = 10;

    constructor() {
        mkdirSync(TEAM_DIR);
        this.configPath = path.join(TEAM_DIR, 'config.json');
        this.runners = new Map();
        if (!fs.existsSync(this.configPath)) {
            this._save({ team_name: 'default', members: [] });
        }
    }

    _load() {
        if (fs.existsSync(this.configPath)) {
            try {
                return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            } catch (e) {
                return { team_name: 'default', members: [] };
            }
        }
        return { team_name: 'default', members: [] };
    }

    _save(data: any) {
        fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf8');
    }

    listAll(): any[] {
        const config = this._load();
        return config.members || [];
    }

    /**
     * 派生/唤醒子 Agent — 注册成员 + 启动 SubAgentRunner 后台循环
     *
     * 若成员已存在: 更新 role 并重新启动 runner
     * 若成员不存在: 新建并启动 runner
     *
     * SubAgentRunner 以非阻塞方式运行, 内部会:
     *   - 轮询 inbox (5s 间隔 + 即时唤醒)
     *   - 收到消息后运行独立的 LLM agent loop
     *   - 结果通过 MessageBus 发回主 Agent
     *   - 空闲 60s 后自动停止
     *
     * @param name 子 Agent 名称 (唯一标识)
     * @param role 角色描述 (注入 system prompt)
     */
    spawn(name: string, role: string) {
        const config = this._load();
        let member = config.members.find((m: any) => m.name === name);
        if (member) {
            member.status = 'working';
            member.role = role;
            member.type = 'subagent';
        } else {
            if (config.members.length >= TeammateManager.MAX_TEAM_SIZE) {
                return `Error: Max team size (${TeammateManager.MAX_TEAM_SIZE}) reached. Remove idle members first.`;
            }
            config.members.push({ name, role, status: 'working', type: 'subagent' });
        }
        this._save(config);

        // 停止旧 runner (如果存在)
        if (this.runners.has(name)) {
            this.runners.get(name).stop();
        }

        // 启动新 SubAgentRunner (延迟导入避免循环依赖)
        const { SubAgentRunner } = require('../subagent');
        const runner = new SubAgentRunner(name, role);
        this.runners.set(name, runner);
        runner.start();

        return `Spawned '${name}' (role: ${role}), sub-agent loop started`;
    }

    /**
     * 创建 Teammate (对等协作模式) — 注册成员 + 启动 TeammateRunner
     *
     * 与 spawn() 的区别:
     *   - spawn()        → SubAgentRunner (有限工具, 单向汇报)
     *   - createTeammate() → TeammateRunner (全量工具, 双向通信)
     *
     * TeammateRunner 拥有全部工具 (含 send_message, read_inbox, create_teammate),
     * 可以与其他 Teammate 直接通信, 不需要通过主 Agent 中转。
     *
     * @param name Teammate 名称 (唯一标识)
     * @param role 角色描述 (注入 system prompt)
     */
    createTeammate(name: string, role: string) {
        const config = this._load();
        let member = config.members.find((m: any) => m.name === name);
        if (member) {
            member.status = 'working';
            member.role = role;
            member.type = 'teammate';
        } else {
            if (config.members.length >= TeammateManager.MAX_TEAM_SIZE) {
                return `Error: Max team size (${TeammateManager.MAX_TEAM_SIZE}) reached. Remove idle members first.`;
            }
            config.members.push({ name, role, status: 'working', type: 'teammate' });
        }
        this._save(config);

        // 停止旧 runner (如果存在)
        if (this.runners.has(name)) {
            this.runners.get(name).stop();
        }

        // 启动新 TeammateRunner (延迟导入避免循环依赖)
        const { TeammateRunner } = require('../subagent');
        const runner = new TeammateRunner(name, role);
        this.runners.set(name, runner);
        runner.start();

        return `Created teammate '${name}' (role: ${role}), collaborative mode`;
    }

    /**
     * 更新子 Agent 状态 — 如 'working' → 'idle'
     * 若设为 idle, 同时停止对应的 SubAgentRunner
     * 静默失败: 成员不存在时不报错
     */
    setStatus(name: string, status: string) {
        const config = this._load();
        const member = config.members.find((m: any) => m.name === name);
        if (member) {
            member.status = status;
            this._save(config);
        }

        // 停止 SubAgentRunner
        if (status === 'idle' && this.runners.has(name)) {
            this.runners.get(name).stop();
            this.runners.delete(name);
        }
    }

    /**
     * 唤醒子 Agent — 当有新消息到达其 inbox 时调用
     * 子 Agent 的轮询会立即被唤醒, 无需等待 5s 间隔
     */
    wakeRunner(name: string) {
        if (this.runners.has(name)) {
            this.runners.get(name).wake();
        }
    }
}
