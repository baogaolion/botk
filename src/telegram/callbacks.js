/**
 * Telegram 回调处理模块
 */

import { InlineKeyboard } from 'grammy';
import { getAvailableModels, getCurrentModelName, getCurrentModelIndex, setCurrentModelIndex } from '../models.js';
import { getSession, deleteSession, getSessionKeys } from '../session.js';
import { getPgPool, querySubmissions, markAsCompleted } from '../submissions.js';
import { welcomeKb, createMainMenuKb, createModelKb, createSubmissionsMenuKb, createSubmissionsListKb } from './keyboards.js';
import { isAdmin, isAllowed, sessionKey, touchUser } from './commands.js';
import { userRepo } from '../../db.js';
import { wrapCallback } from './errorHandler.js';

export function registerCallbacks(bot, runningTasks, lastMessages, processUserMessage) {
  
  // 主菜单
  bot.callbackQuery('main_menu', wrapCallback(async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('hi 我是 bao, 懒病又犯了吗碧池', { reply_markup: welcomeKb });
  }));

  // 示例
  bot.callbackQuery('examples', wrapCallback(async (ctx) => {
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
      { reply_markup: createMainMenuKb() }
    );
  }));

  // 系统状态
  bot.callbackQuery('cb_status', wrapCallback(async (ctx) => {
    await ctx.answerCallbackQuery();
    const up = process.uptime();
    const mem = process.memoryUsage();
    await ctx.reply(
      '⚙️ 系统状态\n\n' +
      `⏱ 运行: ${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m\n` +
      `💾 内存: ${Math.round(mem.rss / 1024 / 1024)}MB\n` +
      `🔧 工具: read, write, edit, bash\n` +
      `🔌 技能: find-skills\n` +
      `📡 模型: ${getCurrentModelName()}`,
      { reply_markup: new InlineKeyboard().text('📡 切换模型', 'show_models').row().text('🏠 主菜单', 'main_menu') }
    );
  }));

  // 显示模型列表
  bot.callbackQuery('show_models', wrapCallback(async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isAdmin(ctx)) {
      await ctx.reply('⚠️ 仅管理员可切换模型。', { reply_markup: createMainMenuKb() });
      return;
    }
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
  }));

  // 切换模型
  bot.callbackQuery(/^set_model_(\d+)$/, wrapCallback(async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: '仅管理员可切换模型' });
      return;
    }
    const newIndex = parseInt(ctx.match[1], 10);
    const oldModel = getCurrentModelName();
    if (setCurrentModelIndex(newIndex)) {
      for (const key of getSessionKeys()) {
        deleteSession(key);
      }
      await ctx.answerCallbackQuery({ text: `已切换到 ${getCurrentModelName()}` });
      await ctx.reply(
        `📡 模型已切换\n\n${oldModel} → ${getCurrentModelName()}\n\n所有会话已重置，新对话将使用新模型。`,
        { reply_markup: createMainMenuKb() }
      );
    } else {
      await ctx.answerCallbackQuery({ text: '无效的模型索引' });
    }
  }));

  // 技能列表
  bot.callbackQuery('skills_list', wrapCallback(async (ctx) => {
    await ctx.answerCallbackQuery();
    
    // 重新扫描已安装的技能
    const { scanInstalledSkills, getInstalledSkills } = await import('../skills.js');
    scanInstalledSkills();
    const installedSkills = getInstalledSkills();
    const customSkills = installedSkills.filter(s => s.name !== 'find-skills');
    
    let text = '📚 技能列表\n\n' +
      '🔧 内置工具:\n' +
      '  read - 读取文件\n' +
      '  write - 写入文件\n' +
      '  edit - 编辑文件\n' +
      '  bash - 执行命令\n\n' +
      '🔌 预置技能:\n' +
      '  find-skills - 搜索安装新技能\n';
    
    if (customSkills.length > 0) {
      text += '\n📦 已安装技能:\n';
      for (const skill of customSkills) {
        text += `  ${skill.name}`;
        if (skill.description && skill.description !== skill.name) {
          text += ` - ${skill.description}`;
        }
        text += '\n';
      }
      text += '\n💡 已安装的技能会优先使用，无需重新搜索！';
    } else {
      text += '\n📦 已安装技能: 无\n\n💡 使用 find-skills 可以搜索和安装新技能！';
    }
    
    await ctx.reply(text, { reply_markup: createMainMenuKb() });
  }));

  // 帮助
  bot.callbackQuery('cb_help', wrapCallback(async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '📖 使用方法\n\n直接发消息描述你的需求即可。\n发文件给我，我会帮你处理。\n\n' +
      '命令: /cancel 取消 | /clear 清除 | /mydata 数据 | /status 状态',
      { reply_markup: createMainMenuKb() }
    );
  }));

  // 取消任务
  bot.callbackQuery('cancel_task', wrapCallback(async (ctx) => {
    if (!isAllowed(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery({ text: '正在取消...' });
    const key = sessionKey(ctx);
    const session = getSession(key);
    if (session) try { await session.abort(); } catch {}
  }));

  // 清除会话
  bot.callbackQuery('clear_session', wrapCallback(async (ctx) => {
    if (!isAllowed(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery({ text: '对话已清除' });
    const key = sessionKey(ctx);
    deleteSession(key);
    lastMessages.delete(key);
  }));

  // 重试任务
  bot.callbackQuery('retry_task', wrapCallback(async (ctx) => {
    if (!isAllowed(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery({ text: '重试中...' });
    const key = sessionKey(ctx);
    const lastMsg = lastMessages.get(key);
    if (lastMsg) {
      await processUserMessage(ctx, lastMsg);
    }
  }));

  // 确认删除
  bot.callbackQuery('confirm_delete', wrapCallback(async (ctx) => {
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
  }));

  // 执行删除
  bot.callbackQuery('do_delete', wrapCallback(async (ctx) => {
    if (!isAllowed(ctx)) { await ctx.answerCallbackQuery(); return; }
    await ctx.answerCallbackQuery({ text: '数据已删除' });
    const key = sessionKey(ctx);
    deleteSession(key);
    lastMessages.delete(key);
    const count = userRepo.deleteAllData(ctx.from.id);
    await ctx.reply(`🗑 已删除你的所有数据（${count} 个文件已清理）。`, { reply_markup: welcomeKb });
  }));

  // ==================== 客户咨询回调 ====================

  // 咨询菜单
  bot.callbackQuery('submissions_menu', wrapCallback(async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isAdmin(ctx)) {
      await ctx.reply('⚠️ 仅管理员可查看客户咨询。');
      return;
    }
    if (!getPgPool()) {
      await ctx.reply('⚠️ 未配置 PostgreSQL 数据库。');
      return;
    }
    await ctx.reply('📬 客户咨询管理', { reply_markup: createSubmissionsMenuKb() });
  }));

  // 咨询列表
  bot.callbackQuery(/^submissions_(processing|completed|all)_(\d+)$/, wrapCallback(async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isAdmin(ctx) || !getPgPool()) return;
    
    const match = ctx.callbackQuery.data.match(/^submissions_(processing|completed|all)_(\d+)$/);
    const filter = match[1];
    const offset = parseInt(match[2]);
    const limit = 5;
    
    let filterLabel = '全部';
    if (filter === 'processing') filterLabel = '🟡 处理中';
    else if (filter === 'completed') filterLabel = '✅ 已处理';
    
    try {
      const { rows, total } = await querySubmissions(filter, offset, limit);
      
      if (rows.length === 0) {
        await ctx.editMessageText(`📭 ${filterLabel} - 暂无记录`, {
          reply_markup: new InlineKeyboard().text('⬅️ 返回', 'submissions_menu')
        });
        return;
      }
      
      let text = `📬 ${filterLabel} (第 ${offset + 1}-${Math.min(offset + limit, total)} 条，共 ${total} 条)\n\n`;
      
      for (const row of rows) {
        const time = new Date(row.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const statusIcon = row.status === 'completed' ? '✅' : (row.status === 'processing' ? '🟡' : '⚪');
        text += `━━━━━━━━━━━━━━━\n`;
        text += `#${row.id} ${statusIcon} ${row.name || '未知'}\n`;
        text += `📱 ${row.contact_method}: ${row.contact_value}\n`;
        text += `💬 ${(row.message || '').slice(0, 80)}${row.message?.length > 80 ? '...' : ''}\n`;
        text += `⏰ ${time}\n`;
      }
      
      await ctx.editMessageText(text, { 
        reply_markup: createSubmissionsListKb(filter, offset, limit, total, rows) 
      });
    } catch (err) {
      await ctx.editMessageText(`❌ 查询失败: ${err.message}`);
    }
  }));

  // 标记已处理
  bot.callbackQuery(/^mark_completed_(\d+)$/, wrapCallback(async (ctx) => {
    await ctx.answerCallbackQuery({ text: '已标记为已处理' });
    if (!isAdmin(ctx) || !getPgPool()) return;
    
    const match = ctx.callbackQuery.data.match(/^mark_completed_(\d+)$/);
    const id = parseInt(match[1]);
    
    if (await markAsCompleted(id)) {
      const msgText = ctx.callbackQuery.message?.text || '';
      await ctx.editMessageText(msgText + '\n\n✅ 已标记为已处理');
    }
  }));

  // 文件处理回调
  bot.callbackQuery(/^file_/, wrapCallback(async (ctx) => {
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
  }));

  // 默认回调处理
  bot.on('callback_query:data', wrapCallback(async (ctx) => {
    await ctx.answerCallbackQuery();
  }));
}
