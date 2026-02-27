import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import { resolve } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import pg from 'pg';
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  codingTools,
  DefaultResourceLoader,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import { initDb, closeDb, userRepo, fileRepo, taskRepo, dbStats, allowRepo } from './db.js';

// ==================== 配置 ====================

const AGENT_DIR = resolve(process.cwd(), '.pi', 'agent');
const ADMIN_USER = Number(process.env.ADMIN_USER) || 0;
const ENV_ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(',').map(id => Number(id.trim())).filter(Boolean)
  : [];
const TIMEOUT_MS = 3 * 60 * 1000;
const MSG_THROTTLE_MS = 1500;
const TG_MAX_LEN = 4000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_MAX = 20;

const PG_CONNECTION_STRING = process.env.PG_CONNECTION_STRING || '';
const PG_POLL_INTERVAL = Number(process.env.PG_POLL_INTERVAL) || 30000;

// ==================== 进度管理 ====================

class ProgressMessage {
  constructor(ctx) {
    this.ctx = ctx;
    this.msgId = null;
    this.lines = [];
    this.phase = 0;
    this.lastUpdate = 0;
    this.finished = false;
  }

  _bar() {
    const fills = Math.min(Math.round(this.phase * 16 / 100), 16);
    return '█'.repeat(fills) + '░'.repeat(16 - fills) + ` ${this.phase}%`;
  }

  _text() {
    return this.lines.join('\n') + `\n${this._bar()}`;
  }

  async init(text) {
    this.lines = [text];
    this.phase = 10;
    try {
      const msg = await this.ctx.reply(this._text(), {
        reply_markup: new InlineKeyboard().text('🛑 取消任务', 'cancel_task'),
      });
      this.msgId = msg.message_id;
    } catch {}
  }

  async update(line, phase) {
    if (this.finished) return;
    this.lines.push(line);
    if (this.lines.length > 8) this.lines = this.lines.slice(-8);
    if (phase) this.phase = phase;
    const now = Date.now();
    if (now - this.lastUpdate < MSG_THROTTLE_MS) return;
    this.lastUpdate = now;
    if (!this.msgId) return;
    try {
      await this.ctx.api.editMessageText(
        this.ctx.chat.id, this.msgId, this._text(),
        { reply_markup: new InlineKeyboard().text('🛑 取消任务', 'cancel_task') }
      );
    } catch {}
  }

  async finish(text) {
    this.finished = true;
    if (!this.msgId) {
      try { await this.ctx.reply(text); } catch {}
      return;
    }
    try {
      await this.ctx.api.editMessageText(this.ctx.chat.id, this.msgId, text, {
        reply_markup: new InlineKeyboard()
          .text('🗑 清除对话', 'clear_session').text('🏠 主菜单', 'main_menu'),
      });
    } catch {
      try { await this.ctx.reply(text); } catch {}
    }
  }

  async error(text) {
    this.finished = true;
    const msg = `⚠️ ${text}`;
    if (!this.msgId) {
      try {
        await this.ctx.reply(msg, {
          reply_markup: new InlineKeyboard()
            .text('🔄 重试', 'retry_task').text('🏠 主菜单', 'main_menu'),
        });
      } catch {}
      return;
    }
    try {
      await this.ctx.api.editMessageText(this.ctx.chat.id, this.msgId, msg, {
        reply_markup: new InlineKeyboard()
          .text('🔄 重试', 'retry_task').text('🏠 主菜单', 'main_menu'),
      });
    } catch {}
  }
}

// ==================== PI Agent (全局共享) ====================

let sharedAuth, sharedModelRegistry, sharedSettingsManager, sharedLoader, sharedUserLoader, sharedModel;

async function initPiGlobals() {
  sharedAuth = new AuthStorage(resolve(AGENT_DIR, 'auth.json'));
  // 优先使用 Gemini，其次 Kimi
  if (process.env.GEMINI_API_KEY) {
    sharedAuth.setRuntimeApiKey('gemini', process.env.GEMINI_API_KEY);
  }
  if (process.env.MOONSHOT_API_KEY) {
    sharedAuth.setRuntimeApiKey('kimi', process.env.MOONSHOT_API_KEY);
  }
  sharedModelRegistry = new ModelRegistry(sharedAuth, resolve(AGENT_DIR, 'models.json'));
  const available = await sharedModelRegistry.getAvailable();
  if (!available.length) throw new Error('没有可用的模型，请检查 GEMINI_API_KEY 或 MOONSHOT_API_KEY');
  // 调试：输出 available 的结构
  console.log('[DEBUG] Available models:', JSON.stringify(available.slice(0, 3), null, 2));
  // 获取完整模型标识符 (provider/model-id 格式)
  const getFullModelId = (m) => {
    if (typeof m === 'string') return m;
    // PI SDK 返回的格式可能是 { provider, model } 或 { id } 或其他
    if (m?.provider && m?.model) return `${m.provider}/${m.model}`;
    if (m?.provider && m?.id) return `${m.provider}/${m.id}`;
    return m?.model || m?.id || String(m);
  };
  // 优先选择 Gemini 模型
  const geminiModel = available.find(m => getFullModelId(m).includes('gemini'));
  sharedModel = geminiModel ? getFullModelId(geminiModel) : getFullModelId(available[0]);
  console.log('[DEBUG] Selected model:', sharedModel);

  sharedSettingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 3 },
  });

  const ADMIN_PROMPT = [
    '你是 bao，一个万能私人助手。用中文回复。',
    `当前工作目录: ${process.cwd()}`,
    '你拥有服务器完整权限：可以通过 bash 执行任意命令、读写编辑任何文件、访问网络（curl/wget）。',
    '当用户的需求超出你当前能力时，使用 find-skills 技能搜索并安装新技能。',
    '步骤：1. 用 bash 执行 npx skills find "关键词" 搜索',
    '2. 找到后执行 npx skills add <package> -g -y 安装',
    '3. 安装后使用新技能完成任务',
    '如果搜索不到技能，就用 bash 和其他基础工具直接完成。',
    '保持简洁、有用、接地气。不要说废话。',
  ].join('\n');

  const USER_PROMPT = [
    '你是 bao，一个万能私人助手。用中文回复。',
    `当前工作目录: ${process.cwd()}`,
    '你可以帮用户完成各种任务：回答问题、翻译、总结、数据分析、写作等。',
    '你有以下权限：',
    '  - 可以用 bash 执行只读命令：ls, cat, head, tail, grep, find, wc, curl, wget, df, du, date, whoami, uname, ps, top',
    '  - 可以用 read 工具读取文件',
    '  - 禁止执行任何写入、修改、删除操作（write, edit, rm, mv, cp, mkdir, chmod, chown, apt, npm install 等）',
    '  - 禁止执行 sudo、shutdown、reboot、kill、pkill 等危险命令',
    '  - 如果用户要求你做禁止的操作，礼貌地告知权限不足，建议联系管理员',
    '当用户的需求超出你当前能力时，使用 find-skills 技能搜索并安装新技能。',
    '保持简洁、有用、接地气。不要说废话。',
  ].join('\n');

  sharedLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: AGENT_DIR,
    settingsManager: sharedSettingsManager,
    systemPromptOverride: () => ADMIN_PROMPT,
  });
  await sharedLoader.reload();

  sharedUserLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: AGENT_DIR,
    settingsManager: sharedSettingsManager,
    systemPromptOverride: () => USER_PROMPT,
  });
  await sharedUserLoader.reload();
}

async function createPiSession(admin = false) {
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: AGENT_DIR,
    model: sharedModel,
    thinkingLevel: 'off',
    authStorage: sharedAuth,
    modelRegistry: sharedModelRegistry,
    tools: codingTools,
    resourceLoader: admin ? sharedLoader : sharedUserLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: sharedSettingsManager,
  });
  return session;
}

// ==================== Session 管理 (LRU + TTL) ====================

const sessions = new Map();
let onSessionDelete = null;

function getSession(key) {
  const entry = sessions.get(key);
  if (!entry) return null;
  entry.lastUsed = Date.now();
  return entry.session;
}

function setSession(key, session) {
  sessions.set(key, { session, lastUsed: Date.now() });
  evictSessions();
}

function deleteSession(key) {
  const entry = sessions.get(key);
  if (entry) {
    try { entry.session.dispose(); } catch {}
    sessions.delete(key);
    if (onSessionDelete) onSessionDelete(key);
  }
}

function evictSessions() {
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (now - entry.lastUsed > SESSION_TTL_MS) deleteSession(key);
  }
  if (sessions.size > SESSION_MAX) {
    const sorted = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < sorted.length - SESSION_MAX; i++) deleteSession(sorted[i][0]);
  }
}

// ==================== Agent 执行 ====================

async function runAgent(session, userText, progress) {
  let fullResponse = '';
  let toolName = '';

  const unsub = session.subscribe((event) => {
    if (event.type !== 'message_update') return;
    const e = event.assistantMessageEvent;
    switch (e.type) {
      case 'text_delta':
        fullResponse += e.delta;
        break;
      case 'tool_call_start':
        toolName = e.name || 'tool';
        const label = TOOL_NAMES[toolName] || toolName;
        progress.update(`🔧 ${label}`, Math.min(progress.phase + 10, 85));
        break;
      case 'tool_call_output':
        if (e.content) {
          const preview = String(e.content).slice(0, 80).replace(/\n/g, ' ');
          progress.update(`   ↳ ${preview}`, Math.min(progress.phase + 5, 90));
        }
        break;
      case 'tool_call_end':
        progress.update(`✓ ${TOOL_NAMES[toolName] || toolName} 完成`, Math.min(progress.phase + 5, 90));
        break;
    }
  });

  try {
    await session.prompt(userText);
  } finally {
    unsub();
  }

  return fullResponse;
}

// ==================== 分段发送 (支持 Markdown) ====================

const TOOL_NAMES = { bash: '执行命令', read: '读取文件', write: '写入文件', edit: '编辑文件', grep: '搜索', find: '查找', ls: '列目录' };

async function sendLongText(ctx, text, keyboard) {
  if (!text || text.trim().length === 0) {
    text = '✅ 完成（无文字输出）';
  }
  const opts = keyboard ? { reply_markup: keyboard } : {};
  if (text.length <= TG_MAX_LEN) {
    try {
      await ctx.reply(text, { ...opts, parse_mode: 'Markdown' });
    } catch {
      await ctx.reply(text, opts);
    }
    return;
  }
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TG_MAX_LEN) { chunks.push(remaining); break; }
    let cut = remaining.lastIndexOf('\n', TG_MAX_LEN);
    if (cut < TG_MAX_LEN / 2) cut = TG_MAX_LEN;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const prefix = chunks.length > 1 ? `📄 (${i + 1}/${chunks.length})\n\n` : '';
    const sendOpts = isLast && keyboard ? { reply_markup: keyboard } : {};
    try {
      await ctx.reply(prefix + chunks[i], { ...sendOpts, parse_mode: 'Markdown' });
    } catch {
      await ctx.reply(prefix + chunks[i], sendOpts);
    }
  }
}

// ==================== 主函数 ====================

async function main() {
  if (!process.env.BOT_TOKEN) { console.error('❌ 缺少 BOT_TOKEN'); process.exit(1); }
  if (!process.env.GEMINI_API_KEY && !process.env.MOONSHOT_API_KEY) {
    console.error('❌ 缺少 AI API Key，请设置 GEMINI_API_KEY 或 MOONSHOT_API_KEY');
    process.exit(1);
  }

  initDb();
  await initPiGlobals();

  const bot = new Bot(process.env.BOT_TOKEN);
  const runningTasks = new Map();
  const lastMessages = new Map();
  onSessionDelete = (key) => lastMessages.delete(key);

  // ==================== PostgreSQL 客户咨询监控 ====================

  let pgPool = null;
  let lastPollTime = new Date();

  if (PG_CONNECTION_STRING) {
    pgPool = new pg.Pool({ connectionString: PG_CONNECTION_STRING });
    pgPool.on('error', (err) => console.error('[PG] Pool error:', err.message));
    console.log('🔗 PostgreSQL 已连接');
  }

  async function pollNewSubmissions() {
    if (!pgPool || !ADMIN_USER) return;
    try {
      const result = await pgPool.query(`
        SELECT id, name, contact_method, contact_value, message, status, created_at
        FROM vsmaios_contact_submission
        WHERE created_at > $1
        ORDER BY created_at ASC
      `, [lastPollTime]);

      for (const row of result.rows) {
        const time = new Date(row.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const text =
          `📬 新客户咨询\n\n` +
          `👤 姓名: ${row.name || '未知'}\n` +
          `📱 ${row.contact_method}: ${row.contact_value}\n` +
          `💬 消息: ${(row.message || '').slice(0, 500)}\n` +
          `⏰ 时间: ${time}`;
        try {
          await bot.api.sendMessage(ADMIN_USER, text);
        } catch (err) {
          console.error('[PG] 推送失败:', err.message);
        }
        lastPollTime = new Date(row.created_at);
      }
    } catch (err) {
      console.error('[PG] 轮询失败:', err.message);
    }
  }

  function isAdmin(ctx) {
    return ctx.from && ctx.from.id === ADMIN_USER;
  }

  function isAllowed(ctx) {
    if (!ctx.from) return false;
    if (ctx.from.id === ADMIN_USER) return true;
    if (ENV_ALLOWED_USERS.includes(ctx.from.id)) return true;
    return allowRepo.has(ctx.from.id);
  }

  function sessionKey(ctx) { return `${ctx.from.id}_${ctx.chat.id}`; }

  function touchUser(ctx) {
    if (ctx.from) userRepo.upsert(ctx.from.id, ctx.from.username || ctx.from.first_name);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  }

  // ==================== 欢迎 + 命令 ====================

  const welcomeKb = new InlineKeyboard()
    .text('💡 我能做什么', 'examples')
    .text('⚙️ 系统状态', 'cb_status')
    .row()
    .text('📚 已装技能', 'skills_list')
    .text('❓ 帮助', 'cb_help');

  bot.command('start', async (ctx) => {
    if (!isAllowed(ctx)) { await ctx.reply('⛔ 无权限。\n你的 ID: ' + ctx.from.id); return; }
    touchUser(ctx);
    await ctx.reply(
      'hi 我是 bao, 懒病又犯了吗碧池\n\n' +
      '我可以帮你完成各种任务，例如：\n' +
      '🔍 搜索信息、数据分析\n' +
      '📝 写文案、翻译、总结\n' +
      '📊 处理数据、生成报告\n' +
      '🧮 计算、转换、查询\n' +
      '💡 解答问题、提供建议\n\n' +
      '遇到不会的事，我会自动学习新技能！\n\n' +
      '发消息告诉我你想做什么 👇',
      { reply_markup: welcomeKb }
    );
  });

  bot.command('help', async (ctx) => {
    if (!isAllowed(ctx)) return;
    let text = '📖 命令列表\n\n' +
      '/start - 主菜单\n' +
      '/status - 系统状态\n' +
      '/skills - 已装技能\n' +
      '/mydata - 我的数据用量\n' +
      '/deletedata - 删除我的所有数据\n' +
      '/cancel - 取消当前任务\n' +
      '/clear - 清除对话，开始新对话\n' +
      '/help - 显示此帮助\n';
    if (isAdmin(ctx)) {
      text += '\n👑 管理员命令:\n' +
        '/adduser <ID> - 添加用户\n' +
        '/removeuser <ID> - 移除用户\n' +
        '/listusers - 查看白名单\n' +
        '/submissions - 查看客户咨询\n';
    }
    text += '\n直接发消息即可，不需要命令。';
    if (!isAdmin(ctx)) {
      text += '\n\n💡 你的权限：可读取文件和查询信息，写入/修改需联系管理员。';
    }
    await ctx.reply(text, { reply_markup: welcomeKb });
  });

  bot.command('cancel', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const key = sessionKey(ctx);
    const session = getSession(key);
    if (runningTasks.has(key) && session) {
      try { await session.abort(); } catch {}
      await ctx.reply('🛑 正在取消...');
    } else {
      await ctx.reply('ℹ️ 当前没有正在进行的任务。');
    }
  });

  bot.command('clear', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const key = sessionKey(ctx);
    deleteSession(key);
    lastMessages.delete(key);
    await ctx.reply('🗑 对话已清除，重新开始吧。', { reply_markup: welcomeKb });
  });

  bot.command('status', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const up = process.uptime();
    const mem = process.memoryUsage();
    const db = dbStats();
    await ctx.reply(
      '⚙️ 系统状态\n\n' +
      `⏱ 运行: ${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m\n` +
      `💾 内存: ${Math.round(mem.rss / 1024 / 1024)}MB\n` +
      `🔧 内置工具: read, write, edit, bash\n` +
      `🔌 预置技能: find-skills\n` +
      `📡 模型: ${sharedModel}\n` +
      `🔄 活跃会话: ${sessions.size} | 运行中: ${runningTasks.size}\n` +
      `🗄 数据库: ${db.sizeMB}MB (${db.userCount}用户, ${db.taskCount}任务, ${db.fileCount}文件)`,
      { reply_markup: new InlineKeyboard().text('🏠 主菜单', 'main_menu') }
    );
  });

  bot.command('skills', async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.reply(
      '📚 技能列表\n\n' +
      '🔧 内置工具:\n' +
      '  read - 读取文件\n' +
      '  write - 写入文件\n' +
      '  edit - 编辑文件\n' +
      '  bash - 执行命令\n\n' +
      '🔌 预置技能:\n' +
      '  find-skills - 搜索安装新技能\n\n' +
      '💡 需要新技能时我会自动搜索安装！',
      { reply_markup: new InlineKeyboard().text('🏠 主菜单', 'main_menu') }
    );
  });

  bot.command('mydata', async (ctx) => {
    if (!isAllowed(ctx)) return;
    touchUser(ctx);
    const stats = userRepo.getStats(ctx.from.id);
    if (!stats) { await ctx.reply('暂无数据。'); return; }
    const files = fileRepo.listByUser(ctx.from.id);
    let fileList = files.length > 0
      ? files.slice(0, 10).map(f => `  📄 ${f.file_name} (${formatBytes(f.size_bytes)})`).join('\n')
      : '  (无)';
    if (files.length > 10) fileList += `\n  ... 还有 ${files.length - 10} 个文件`;
    await ctx.reply(
      '📊 我的数据\n\n' +
      `📋 累计任务: ${stats.task_count} 次\n` +
      `📅 今日任务: ${stats.tasksToday} 次\n` +
      `💾 存储用量: ${formatBytes(stats.storage_bytes)} / ${formatBytes(stats.storage_limit)}\n` +
      `📁 文件数: ${stats.fileCount}\n\n` +
      `最近文件:\n${fileList}`,
      {
        reply_markup: new InlineKeyboard()
          .text('🗑 删除所有数据', 'confirm_delete')
          .text('🏠 主菜单', 'main_menu'),
      }
    );
  });

  bot.command('deletedata', async (ctx) => {
    if (!isAllowed(ctx)) return;
    await ctx.reply(
      '⚠️ 确认删除你的所有数据？\n\n这将清除：\n• 所有上传的文件\n• 任务历史记录\n• 使用统计\n\n此操作不可恢复！',
      {
        reply_markup: new InlineKeyboard()
          .text('✅ 确认删除', 'do_delete')
          .text('❌ 取消', 'main_menu'),
      }
    );
  });

  // ==================== Admin 命令 ====================

  bot.command('adduser', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) {
      await ctx.reply('用法: /adduser <用户ID>\n\n用户需要先给 @userinfobot 发消息获取 ID。');
      return;
    }
    const targetId = Number(args[0]);
    if (!targetId || isNaN(targetId)) {
      await ctx.reply('❌ 无效的用户 ID，必须是数字。');
      return;
    }
    if (targetId === ADMIN_USER) {
      await ctx.reply('ℹ️ 管理员不需要添加。');
      return;
    }
    allowRepo.add(targetId, ctx.from.id);
    const list = allowRepo.list();
    await ctx.reply(
      `✅ 已添加用户 ${targetId}\n\n当前白名单 (${list.length} 人):\n` +
      list.map(u => `  ${u.user_id}${u.username ? ' (@' + u.username + ')' : ''}`).join('\n'),
    );
  });

  bot.command('removeuser', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) {
      await ctx.reply('用法: /removeuser <用户ID>');
      return;
    }
    const targetId = Number(args[0]);
    if (!targetId || isNaN(targetId)) {
      await ctx.reply('❌ 无效的用户 ID。');
      return;
    }
    allowRepo.remove(targetId);
    const key = `${targetId}_${ctx.chat.id}`;
    deleteSession(key);
    await ctx.reply(`✅ 已移除用户 ${targetId}，该用户的会话已清除。`);
  });

  bot.command('listusers', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const dbUsers = allowRepo.list();
    let text = '👥 用户白名单\n\n';
    text += `👑 管理员: ${ADMIN_USER}\n\n`;
    if (ENV_ALLOWED_USERS.length > 0) {
      text += `📋 .env 白名单 (${ENV_ALLOWED_USERS.length}):\n`;
      text += ENV_ALLOWED_USERS.map(id => `  ${id}`).join('\n') + '\n\n';
    }
    if (dbUsers.length > 0) {
      text += `📋 动态白名单 (${dbUsers.length}):\n`;
      text += dbUsers.map(u => {
        const name = u.username ? ` (@${u.username})` : '';
        const date = new Date(u.added_at).toLocaleDateString('zh-CN');
        return `  ${u.user_id}${name} — ${date} 添加`;
      }).join('\n');
    } else {
      text += '📋 动态白名单: (空)';
    }
    await ctx.reply(text, {
      reply_markup: new InlineKeyboard().text('🏠 主菜单', 'main_menu'),
    });
  });

  bot.command('submissions', async (ctx) => {
    if (!isAdmin(ctx)) return;
    if (!pgPool) {
      await ctx.reply('⚠️ 未配置 PostgreSQL 数据库。请在 .env 中设置 PG_CONNECTION_STRING。');
      return;
    }
    try {
      const result = await pgPool.query(`
        SELECT id, name, contact_method, contact_value, message, status, created_at
        FROM vsmaios_contact_submission
        ORDER BY created_at DESC
        LIMIT 10
      `);
      if (result.rows.length === 0) {
        await ctx.reply('📭 暂无客户咨询记录。');
        return;
      }
      let text = '📬 最近 10 条客户咨询\n\n';
      for (const row of result.rows) {
        const time = new Date(row.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        text += `━━━━━━━━━━━━━━━\n`;
        text += `👤 ${row.name || '未知'}\n`;
        text += `📱 ${row.contact_method}: ${row.contact_value}\n`;
        text += `💬 ${(row.message || '').slice(0, 100)}${row.message?.length > 100 ? '...' : ''}\n`;
        text += `📊 状态: ${row.status || '待处理'}\n`;
        text += `⏰ ${time}\n`;
      }
      await ctx.reply(text, {
        reply_markup: new InlineKeyboard().text('🏠 主菜单', 'main_menu'),
      });
    } catch (err) {
      await ctx.reply(`❌ 查询失败: ${err.message}`);
    }
  });

  // ==================== 按钮回调 ====================

  bot.callbackQuery('main_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('hi 我是 bao, 有什么需要帮忙的？', { reply_markup: welcomeKb });
  });

  bot.callbackQuery('examples', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '💡 使用示例：\n\n' +
      '• "帮我总结这篇文章"\n' +
      '• "把这段话翻译成英文"\n' +
      '• "查一下今天的天气"\n' +
      '• "分析这份数据找出趋势"\n' +
      '• "帮我写一封邮件给客户"\n' +
      '• "计算一下这笔贷款的利息"\n\n' +
      '📎 你也可以直接发文件给我处理\n\n' +
      '直接说就行！',
      { reply_markup: new InlineKeyboard().text('🏠 主菜单', 'main_menu') }
    );
  });

  bot.callbackQuery('cb_status', async (ctx) => {
    await ctx.answerCallbackQuery();
    const up = process.uptime();
    const mem = process.memoryUsage();
    await ctx.reply(
      '⚙️ 系统状态\n\n' +
      `⏱ 运行: ${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m\n` +
      `💾 内存: ${Math.round(mem.rss / 1024 / 1024)}MB\n` +
      `🔧 工具: read, write, edit, bash\n` +
      `🔌 技能: find-skills\n` +
      `📡 模型: ${sharedModel}`,
      { reply_markup: new InlineKeyboard().text('🏠 主菜单', 'main_menu') }
    );
  });

  bot.callbackQuery('skills_list', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '📚 技能列表\n\n🔧 内置: read, write, edit, bash\n🔌 预置: find-skills\n\n💡 需要时自动搜索安装更多！',
      { reply_markup: new InlineKeyboard().text('🏠 主菜单', 'main_menu') }
    );
  });

  bot.callbackQuery('cb_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '📖 使用方法\n\n直接发消息描述你的需求即可。\n发文件给我，我会帮你处理。\n\n' +
      '命令: /cancel 取消 | /clear 清除 | /mydata 数据 | /status 状态',
      { reply_markup: new InlineKeyboard().text('🏠 主菜单', 'main_menu') }
    );
  });

  bot.callbackQuery('cancel_task', async (ctx) => {
    if (!isAllowed(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery({ text: '正在取消...' });
    const key = sessionKey(ctx);
    const session = getSession(key);
    if (session) try { await session.abort(); } catch {}
  });

  bot.callbackQuery('clear_session', async (ctx) => {
    if (!isAllowed(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery({ text: '对话已清除' });
    const key = sessionKey(ctx);
    deleteSession(key);
    lastMessages.delete(key);
  });

  bot.callbackQuery('retry_task', async (ctx) => {
    if (!isAllowed(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery({ text: '重试中...' });
    const key = sessionKey(ctx);
    const lastMsg = lastMessages.get(key);
    if (lastMsg) {
      await processUserMessage(ctx, lastMsg);
    }
  });

  bot.callbackQuery('confirm_delete', async (ctx) => {
    if (!isAllowed(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '⚠️ 最后确认：真的要删除所有数据吗？',
      {
        reply_markup: new InlineKeyboard()
          .text('✅ 是，全部删除', 'do_delete')
          .text('❌ 不，保留', 'main_menu'),
      }
    );
  });

  bot.callbackQuery('do_delete', async (ctx) => {
    if (!isAllowed(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery({ text: '数据已删除' });
    const key = sessionKey(ctx);
    deleteSession(key);
    lastMessages.delete(key);
    const count = userRepo.deleteAllData(ctx.from.id);
    await ctx.reply(`🗑 已删除你的所有数据（${count} 个文件已清理）。`, { reply_markup: welcomeKb });
  });

  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  // ==================== 消息处理核心 ====================

  async function processUserMessage(ctx, userText) {
    const key = sessionKey(ctx);
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
    if (!userText.trim()) return;

    if (runningTasks.has(key)) {
      await ctx.reply('⏳ 上一个任务还在进行中...', {
        reply_markup: new InlineKeyboard()
          .text('🛑 取消当前任务', 'cancel_task'),
      });
      return;
    }

    touchUser(ctx);
    lastMessages.set(key, userText);
    runningTasks.set(key, true);
    const progress = new ProgressMessage(ctx);
    const startTime = Date.now();
    let taskStatus = 'ok';

    try {
      await ctx.api.sendChatAction(chatId, 'typing');
    } catch {}

    const timer = setTimeout(async () => {
      const session = getSession(key);
      if (session) try { await session.abort(); } catch {}
    }, TIMEOUT_MS);

    try {
      await progress.init('🔄 正在处理你的请求...');

      let session = getSession(key);
      if (!session) {
        await progress.update('🧠 初始化 AI...', 15);
        session = await createPiSession(isAdmin(ctx));
        setSession(key, session);
      }

      await progress.update('💭 思考中...', 25);
      const response = await runAgent(session, userText, progress);
      const duration = Date.now() - startTime;
      const durationStr = duration > 60000
        ? `${(duration / 60000).toFixed(1)}分钟`
        : `${(duration / 1000).toFixed(1)}秒`;

      progress.phase = 100;
      const doneKb = new InlineKeyboard()
        .text('🗑 清除对话', 'clear_session')
        .text('🏠 主菜单', 'main_menu');

      if (response && response.trim()) {
        await progress.finish(`✅ 完成 (${durationStr})`);
        await sendLongText(ctx, response, doneKb);
      } else {
        await progress.finish(`✅ 完成 (${durationStr})`);
      }

      taskRepo.add(ctx.from.id, userText, duration, 'ok');
    } catch (err) {
      taskStatus = 'error';
      const duration = Date.now() - startTime;
      if (err.name === 'AbortError') {
        await progress.error('任务已取消或超时。');
        taskStatus = 'cancelled';
      } else if (err.status === 429) {
        await progress.error('请求过于频繁，请稍后再试。');
      } else if (err.status >= 500) {
        await progress.error('AI 服务暂时不可用，请稍后重试。');
      } else {
        console.error('[Bot]', err);
        await progress.error(`出错了: ${err.message?.slice(0, 200) || '未知错误'}`);
      }
      taskRepo.add(ctx.from.id, userText, duration, taskStatus);
    } finally {
      clearTimeout(timer);
      runningTasks.delete(key);
    }
  }

  bot.on('message:text', async (ctx) => {
    if (!isAllowed(ctx)) {
      await ctx.reply('⛔ 无权限。\n你的 ID: ' + ctx.from.id);
      return;
    }
    await processUserMessage(ctx, ctx.message.text);
  });

  // ==================== 文件上传 ====================

  bot.on(['message:document', 'message:photo'], async (ctx) => {
    if (!isAllowed(ctx)) return;
    touchUser(ctx);
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
      const uploadsDir = resolve(process.cwd(), 'uploads', String(ctx.from.id));
      await mkdir(uploadsDir, { recursive: true });
      const rawName = ctx.message.document?.file_name || `file_${Date.now()}`;
      const safeName = rawName.replace(/[/\\:*?"<>|]/g, '_').replace(/^\.*/, '') || `file_${Date.now()}`;
      const ext = safeName.includes('.') ? '.' + safeName.split('.').pop() : '';
      const base = safeName.includes('.') ? safeName.slice(0, safeName.lastIndexOf('.')) : safeName;
      let fileName = safeName;
      let savePath = resolve(uploadsDir, fileName);
      let n = 1;
      while (existsSync(savePath)) {
        fileName = `${base}_${n}${ext}`;
        savePath = resolve(uploadsDir, fileName);
        n++;
      }
      const resp = await fetch(url);
      const buffer = Buffer.from(await resp.arrayBuffer());

      const user = userRepo.get(ctx.from.id);
      if (user && user.storage_bytes + buffer.length > user.storage_limit) {
        await ctx.reply(
          `⚠️ 存储空间不足\n\n当前: ${formatBytes(user.storage_bytes)} / ${formatBytes(user.storage_limit)}\n` +
          `文件: ${formatBytes(buffer.length)}\n\n用 /deletedata 清理数据或联系管理员。`,
        );
        return;
      }

      await writeFile(savePath, buffer);
      fileRepo.add(ctx.from.id, fileName, savePath, buffer.length);

      const sizeKB = Math.round(buffer.length / 1024);
      const caption = ctx.message.caption;

      if (caption) {
        await processUserMessage(ctx, `[已上传文件: ${fileName} (${sizeKB}KB) 保存在 ${savePath}]\n\n用户说: ${caption}`);
      } else {
        await ctx.reply(
          `✅ 文件已收到\n\n📄 ${fileName} (${sizeKB}KB)\n\n你想让我怎么处理？`,
          {
            reply_markup: new InlineKeyboard()
              .text('📋 总结内容', 'file_summarize')
              .text('🔍 提取关键信息', 'file_extract')
              .row()
              .text('🌐 翻译', 'file_translate')
              .text('💬 我来说明', 'file_custom'),
          }
        );
        lastMessages.set(sessionKey(ctx), `[已上传文件: ${fileName} (${sizeKB}KB) 保存在 ${savePath}]`);
      }
    } catch (err) {
      await ctx.reply(`❌ 文件处理失败: ${err.message}`);
    }
  });

  bot.callbackQuery(/^file_/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const key = sessionKey(ctx);
    const fileInfo = lastMessages.get(key) || '';
    const actions = {
      file_summarize: '请总结这个文件的内容',
      file_extract: '请提取这个文件中的关键信息',
      file_translate: '请将这个文件内容翻译成英文',
      file_custom: null,
    };
    const action = actions[ctx.callbackQuery.data];
    if (action === null) {
      await ctx.reply('请告诉我你想怎么处理这个文件：');
      return;
    }
    if (action) {
      await processUserMessage(ctx, `${fileInfo}\n\n${action}`);
    }
  });

  // ==================== Session 定时清理 ====================

  setInterval(evictSessions, 5 * 60 * 1000);

  // 启动 PostgreSQL 轮询
  if (pgPool && ADMIN_USER) {
    setInterval(pollNewSubmissions, PG_POLL_INTERVAL);
    console.log(`📡 客户咨询监控已启动，间隔 ${PG_POLL_INTERVAL / 1000}秒`);
  }

  // ==================== 注册命令菜单 ====================

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
      { command: 'submissions', description: '客户咨询' },
      { command: 'adduser', description: '添加用户' },
      { command: 'removeuser', description: '移除用户' },
      { command: 'listusers', description: '查看白名单' },
      { command: 'cancel', description: '取消当前任务' },
      { command: 'clear', description: '清除对话' },
    ], { scope: { type: 'chat', chat_id: ADMIN_USER } });
  }

  // ==================== 错误处理 ====================

  bot.catch((err) => console.error('[Bot] grammY 错误:', err));

  function gracefulShutdown() {
    console.log('🛑 正在停机...');
    bot.stop();
    if (pgPool) pgPool.end();
    closeDb();
    process.exit(0);
  }
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
  process.on('unhandledRejection', (err) => console.error('[Process] unhandledRejection:', err));
  process.on('uncaughtException', (err) => { console.error('[Process] uncaughtException:', err); closeDb(); process.exit(1); });

  console.log('🤖 botk 已启动');
  console.log(`🔧 工具: read, write, edit, bash`);
  console.log(`🔌 技能: find-skills`);
  console.log(`📡 模型: ${sharedModel}`);
  console.log(`🗄 数据库: data/botk.db`);
  if (ADMIN_USER) console.log(`👑 管理员: ${ADMIN_USER}`);
  else console.log('⚠️  未设置 ADMIN_USER');
  if (pgPool) console.log(`📬 客户咨询监控: 已启用`);
  else console.log(`📬 客户咨询监控: 未配置`);
  if (ENV_ALLOWED_USERS.length > 0) console.log(`🔒 .env 白名单: [${ENV_ALLOWED_USERS.join(', ')}]`);
  const dbAllowed = allowRepo.list();
  if (dbAllowed.length > 0) console.log(`🔒 DB 白名单: [${dbAllowed.map(u => u.user_id).join(', ')}]`);

  await bot.start();
}

main();
