/**
 * Telegram 命令处理模块
 */

import { InlineKeyboard } from 'grammy';
import { ADMIN_USER, ENV_ALLOWED_USERS } from '../config.js';
import { getAvailableModels, getCurrentModelName, getCurrentModelIndex, setCurrentModelIndex } from '../models.js';
import { getSession, deleteSession, getSessionCount, clearAllSessions } from '../session.js';
import { getPgPool, querySubmissions, markAsDone } from '../submissions.js';
import { formatBytes } from '../utils.js';
import { welcomeKb, createMainMenuKb, createModelKb, createSubmissionsMenuKb, createSubmissionsListKb } from './keyboards.js';
import { userRepo, fileRepo, taskRepo, dbStats, allowRepo } from '../../db.js';

// ==================== 权限检查 ====================

export function isAdmin(ctx) {
  return ctx.from && ctx.from.id === ADMIN_USER;
}

export function isAllowed(ctx) {
  if (!ctx.from) return false;
  if (ctx.from.id === ADMIN_USER) return true;
  if (ENV_ALLOWED_USERS.includes(ctx.from.id)) return true;
  return allowRepo.has(ctx.from.id);
}

export function sessionKey(ctx) {
  return `${ctx.from.id}_${ctx.chat.id}`;
}

export function touchUser(ctx) {
  if (ctx.from) userRepo.upsert(ctx.from.id, ctx.from.username || ctx.from.first_name);
}

// ==================== 注册命令 ====================

export function registerCommands(bot, runningTasks, lastMessages) {
  
  // /start
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

  // /help
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

  // /cancel
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

  // /clear
  bot.command('clear', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const key = sessionKey(ctx);
    deleteSession(key);
    lastMessages.delete(key);
    await ctx.reply('🗑 对话已清除，重新开始吧。', { reply_markup: welcomeKb });
  });

  // /status
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
      `📡 模型: ${getCurrentModelName()}\n` +
      `🔄 活跃会话: ${getSessionCount()} | 运行中: ${runningTasks.size}\n` +
      `🗄 数据库: ${db.sizeMB}MB (${db.userCount}用户, ${db.taskCount}任务, ${db.fileCount}文件)`,
      { reply_markup: createMainMenuKb() }
    );
  });

  // /skills
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
      { reply_markup: createMainMenuKb() }
    );
  });

  // /mydata
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

  // /deletedata
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

  // /models
  bot.command('models', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const available = getAvailableModels();
    if (!available.length) {
      await ctx.reply('❌ 没有可用的模型，请检查 API Key 配置。');
      return;
    }
    
    let text = '📡 可用模型\n\n';
    available.forEach((m, i) => {
      const isCurrent = i === getCurrentModelIndex();
      text += `${isCurrent ? '✅' : '⬜'} ${i + 1}. ${m.name} (${m.provider})\n`;
    });
    text += `\n当前: ${getCurrentModelName()}`;
    await ctx.reply(text, { reply_markup: createModelKb(available, getCurrentModelIndex()) });
  });

  // /submissions
  bot.command('submissions', async (ctx) => {
    if (!isAdmin(ctx)) return;
    if (!getPgPool()) {
      await ctx.reply('⚠️ 未配置 PostgreSQL 数据库。请在 .env 中设置 PG_CONNECTION_STRING。');
      return;
    }
    await ctx.reply('📬 客户咨询管理', { reply_markup: createSubmissionsMenuKb() });
  });

  // ==================== 管理员命令 ====================

  // /adduser
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

  // /removeuser
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

  // /listusers
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
    await ctx.reply(text, { reply_markup: createMainMenuKb() });
  });
}
