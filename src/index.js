/**
 * 应用入口
 * 负责初始化和组装所有模块
 */

import 'dotenv/config';
import { Bot } from 'grammy';
import { validateConfig, ADMIN_USER, ENV_ALLOWED_USERS, PG_POLL_INTERVAL } from './config.js';
import { getCurrentModelName, logApiKeyStatus } from './models.js';
import { setOnSessionDelete, evictSessions } from './session.js';
import { initPiGlobals } from './agent.js';
import { initPgPool, closePgPool, startPolling, getPgPool } from './submissions.js';
import { registerCommands } from './telegram/commands.js';
import { registerCallbacks } from './telegram/callbacks.js';
import { registerMessageHandlers } from './telegram/messages.js';
import { initDb, closeDb, allowRepo } from '../db.js';

async function main() {
  // 验证配置
  validateConfig();

  // 初始化数据库
  initDb();

  // 初始化 PI Agent
  await initPiGlobals();

  // 创建 Bot
  const bot = new Bot(process.env.BOT_TOKEN);
  const runningTasks = new Map();
  const lastMessages = new Map();
  
  // 设置会话删除回调
  setOnSessionDelete((key) => lastMessages.delete(key));

  // 初始化 PostgreSQL
  initPgPool();

  // 注册命令
  registerCommands(bot, runningTasks, lastMessages);

  // 注册消息处理器（返回 processUserMessage 函数）
  const processUserMessage = registerMessageHandlers(bot, runningTasks, lastMessages);

  // 注册回调处理器
  registerCallbacks(bot, runningTasks, lastMessages, processUserMessage);

  // 定时清理会话
  setInterval(evictSessions, 5 * 60 * 1000);

  // 启动 PostgreSQL 轮询
  startPolling(bot);

  // 注册命令菜单
  await bot.api.setMyCommands([
    { command: 'start', description: '主菜单' },
    { command: 'help', description: '帮助' },
    { command: 'status', description: '系统状态' },
    { command: 'skills', description: '已装技能' },
    { command: 'mydata', description: '我的数据用量' },
    { command: 'deletedata', description: '删除我的数据' },
    { command: 'cancel', description: '取消当前任务' },
    { command: 'clear', description: '清除对话' },
  ]);

  if (ADMIN_USER) {
    await bot.api.setMyCommands([
      { command: 'start', description: '主菜单' },
      { command: 'help', description: '帮助' },
      { command: 'status', description: '系统状态' },
      { command: 'models', description: '切换模型' },
      { command: 'submissions', description: '客户咨询' },
      { command: 'adduser', description: '添加用户' },
      { command: 'removeuser', description: '移除用户' },
      { command: 'listusers', description: '查看白名单' },
      { command: 'cancel', description: '取消当前任务' },
      { command: 'clear', description: '清除对话' },
    ], { scope: { type: 'chat', chat_id: ADMIN_USER } });
  }

  // 错误处理
  bot.catch((err) => console.error('[Bot] grammY 错误:', err));

  function gracefulShutdown() {
    console.log('🛑 正在停机...');
    bot.stop();
    closePgPool();
    closeDb();
    process.exit(0);
  }
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
  process.on('unhandledRejection', (err) => console.error('[Process] unhandledRejection:', err));
  process.on('uncaughtException', (err) => { console.error('[Process] uncaughtException:', err); closeDb(); process.exit(1); });

  // 启动信息
  console.log('🤖 botk 已启动');
  console.log(`🔧 工具: read, write, edit, bash`);
  console.log(`🔌 技能: find-skills`);
  console.log(`📡 模型: ${getCurrentModelName()}`);
  console.log(`🗄 数据库: data/botk.db`);
  if (ADMIN_USER) console.log(`👑 管理员: ${ADMIN_USER}`);
  else console.log('⚠️  未设置 ADMIN_USER');
  if (getPgPool()) console.log(`📬 客户咨询监控: 已启用`);
  else console.log(`📬 客户咨询监控: 未配置`);
  if (ENV_ALLOWED_USERS.length > 0) console.log(`🔒 .env 白名单: [${ENV_ALLOWED_USERS.join(', ')}]`);
  const dbAllowed = allowRepo.list();
  if (dbAllowed.length > 0) console.log(`🔒 DB 白名单: [${dbAllowed.map(u => u.user_id).join(', ')}]`);

  await bot.start();
}

main();
