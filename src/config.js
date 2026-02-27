/**
 * 配置管理模块
 * 集中管理所有环境变量和常量配置
 */

import { resolve } from 'path';

// ==================== 基础配置 ====================

export const AGENT_DIR = resolve(process.cwd(), '.pi', 'agent');
export const ADMIN_USER = Number(process.env.ADMIN_USER) || 0;
export const ENV_ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(',').map(id => Number(id.trim())).filter(Boolean)
  : [];

// ==================== 超时和限制 ====================

export const TIMEOUT_MS = 3 * 60 * 1000;
export const MSG_THROTTLE_MS = 1500;
export const TG_MAX_LEN = 4000;
export const SESSION_TTL_MS = 30 * 60 * 1000;
export const SESSION_MAX = 20;

// ==================== 流式输出配置 ====================

export const STREAM_THROTTLE_MS = 450;
export const TYPING_INTERVAL_MS = 4000;

// ==================== PostgreSQL 配置 ====================

export const PG_CONNECTION_STRING = process.env.PG_CONNECTION_STRING || '';
export const PG_POLL_INTERVAL = Number(process.env.PG_POLL_INTERVAL) || 30000;

// ==================== 用户文档目录 ====================

export const USER_DOCS_DIR = process.env.USER_DOCS_DIR || '/home/administrator/Documents';

// ==================== 验证必需配置 ====================

export function validateConfig() {
  if (!process.env.BOT_TOKEN) {
    console.error('❌ 缺少 BOT_TOKEN');
    process.exit(1);
  }
  if (!process.env.DEEPSEEK_API_KEY && !process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY && !process.env.MOONSHOT_API_KEY) {
    console.error('❌ 缺少 AI API Key，请设置 DEEPSEEK_API_KEY、OPENAI_API_KEY、GEMINI_API_KEY 或 MOONSHOT_API_KEY');
    process.exit(1);
  }
}
