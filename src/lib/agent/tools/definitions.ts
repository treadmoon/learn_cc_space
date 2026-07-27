/**
 * TOOLS 数组 — 注册给 LLM 的可调用工具列表
 * 每个工具包含: name, description, parameters (JSON Schema)
 * LLM 返回 tool_calls 时, 按 name 分派到 toolHandlers 执行
 *
 * 分类:
 *   文件系统: bash, read_file, write_file, edit_file
 *   任务管理: TodoWrite, task_create, task_get, task_update, task_list
 *   后台任务: background_run, check_background
 *   定时调度: cron_schedule, cron_remove
 *   知识技能: load_skill, knowledge_ingest, knowledge_search
 *   上下文:   compress
 *   制品:     artifact_save
 *   团队:     spawn_teammate, create_teammate, list_teammates, send_message, read_inbox
 *   Worktree: worktree_list, worktree_add, worktree_remove
 */
export const TOOLS = [
    // ── 文件系统工具 ──
    { type: 'function' as const, function: { name: 'bash', description: 'Run absolute or relative path bash command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    { type: 'function' as const, function: { name: 'read_file', description: 'Read file contents.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function' as const, function: { name: 'write_file', description: 'Write file contents.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function' as const, function: { name: 'edit_file', description: 'Replace exact text in file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } } },
    // ── 待办工具 ──
    { type: 'function' as const, function: { name: 'TodoWrite', description: 'Update task tracking list.', parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, activeForm: { type: 'string' } }, required: ['content', 'status', 'activeForm'] } } }, required: ['items'] } } },
    // ── 知识技能工具 ──
    { type: 'function' as const, function: { name: 'load_skill', description: 'Load specialized knowledge by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    // ── 上下文压缩工具 ──
    { type: 'function' as const, function: { name: 'compress', description: 'Manually compress conversation context. (Dummy implementation)', parameters: { type: 'object', properties: {} } } },
    // ── 后台任务工具 ──
    { type: 'function' as const, function: { name: 'background_run', description: 'Run command in background thread.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'integer' } }, required: ['command'] } } },
    { type: 'function' as const, function: { name: 'check_background', description: 'Check background task status.', parameters: { type: 'object', properties: { task_id: { type: 'string' } } } } },
    // ── 持久化任务工具 ──
    { type: 'function' as const, function: { name: 'task_create', description: 'Create a persistent file task.', parameters: { type: 'object', properties: { subject: { type: 'string' }, description: { type: 'string' } }, required: ['subject'] } } },
    { type: 'function' as const, function: { name: 'task_get', description: 'Get task details by ID.', parameters: { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'] } } },
    { type: 'function' as const, function: { name: 'task_update', description: 'Update task status or dependencies.', parameters: { type: 'object', properties: { task_id: { type: 'integer' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'expired', 'deleted'] }, add_blocked_by: { type: 'array', items: { type: 'integer' } }, add_blocks: { type: 'array', items: { type: 'integer' } } }, required: ['task_id'] } } },
    { type: 'function' as const, function: { name: 'task_list', description: 'List all tasks.', parameters: { type: 'object', properties: {} } } },
    // ── 定时调度工具 ──
    { type: 'function' as const, function: { name: 'cron_schedule', description: 'Schedule a background command to run periodically.', parameters: { type: 'object', properties: { name: { type: 'string' }, command: { type: 'string' }, interval_ms: { type: 'integer' } }, required: ['name', 'command', 'interval_ms'] } } },
    { type: 'function' as const, function: { name: 'cron_remove', description: 'Remove a scheduled background command.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
    // ── 团队协作工具 ──
    { type: 'function' as const, function: { name: 'spawn_teammate', description: 'Create or wake a sub-agent teammate with a name and role.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Unique teammate name' }, role: { type: 'string', description: 'Role description for the teammate' } }, required: ['name', 'role'] } } },
    { type: 'function' as const, function: { name: 'create_teammate', description: 'Create a collaborative teammate (peer agent with full tools and team communication).', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Unique teammate name' }, role: { type: 'string', description: 'Role description for the teammate' } }, required: ['name', 'role'] } } },
    { type: 'function' as const, function: { name: 'list_teammates', description: 'List all teammates and their current status.', parameters: { type: 'object', properties: {} } } },
    { type: 'function' as const, function: { name: 'set_teammate_status', description: 'Update a teammate\'s status (e.g. working, idle).', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Teammate name' }, status: { type: 'string', description: 'New status value' } }, required: ['name', 'status'] } } },
    { type: 'function' as const, function: { name: 'send_message', description: 'Send a message to a teammate\'s inbox.', parameters: { type: 'object', properties: { to: { type: 'string', description: 'Recipient teammate name' }, content: { type: 'string', description: 'Message content' } }, required: ['to', 'content'] } } },
    { type: 'function' as const, function: { name: 'read_inbox', description: 'Read and clear your inbox messages (destructive read).', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Teammate name whose inbox to read' } }, required: ['name'] } } },
    // ── 制品工具 ──
    { type: 'function' as const, function: { name: 'artifact_save', description: 'Save a file as a task artifact to .artifacts/ directory.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path to save as artifact' }, task_id: { type: 'integer', description: 'Associated task ID (optional, saves to shared/ if omitted)' }, description: { type: 'string', description: 'Brief description of the artifact' } }, required: ['path'] } } },
    // ── RAG 知识库工具 ──
    { type: 'function' as const, function: { name: 'knowledge_ingest', description: 'Ingest a file or text into the knowledge base for later retrieval. Supports .md, .txt, .json, .csv, .py, .ts, .js and other text formats.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path to ingest' }, text: { type: 'string', description: 'Direct text content to ingest (alternative to path)' }, source: { type: 'string', description: 'Source identifier for text mode (required when using text)' } } } } },
    { type: 'function' as const, function: { name: 'knowledge_search', description: 'Semantic search over the knowledge base. Use this to find relevant information before answering questions.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, top_k: { type: 'number', description: 'Number of results to return (default 5)' } }, required: ['query'] } } },
    // ── Worktree 工具 ──
    { type: 'function' as const, function: { name: 'worktree_list', description: 'List all git worktrees with structured info (path, branch, head, bare, locked).', parameters: { type: 'object', properties: {} } } },
    { type: 'function' as const, function: { name: 'worktree_add', description: 'Create a new git worktree for a branch. If path is omitted, auto-generates based on branch name.', parameters: { type: 'object', properties: { branch: { type: 'string', description: 'Branch name to create worktree for' }, path: { type: 'string', description: 'Optional target directory for the worktree' } }, required: ['branch'] } } },
    { type: 'function' as const, function: { name: 'worktree_remove', description: 'Remove a git worktree by path or branch name.', parameters: { type: 'object', properties: { target: { type: 'string', description: 'Worktree absolute path or branch name to remove' } }, required: ['target'] } } }
];
