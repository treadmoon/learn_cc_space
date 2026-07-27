/**
 * 向后兼容重导出 — 所有 Manager 已迁移至 managers/ 目录
 *
 * 本文件仅做 barrel re-export, 确保以下导入路径无需修改:
 *   import { TODO, BG_MGR, microCompact } from './managers'
 *   import { TODO, BG_MGR, microCompact } from '@/lib/agent/managers'
 */
export * from './managers/index';
