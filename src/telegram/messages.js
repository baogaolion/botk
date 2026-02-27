/**
 * Telegram 消息处理模块
 */

import { InlineKeyboard } from 'grammy';
import { resolve } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { TIMEOUT_MS } from '../config.js';
import { getSession, setSession, deleteSession } from '../session.js';
import { createPiSession, runAgent } from '../agent.js';
import { ProgressMessage } from '../progress.js';
import { sendLongText, formatBytes, convertToTelegramMarkdown } from '../utils.js';
import { isAdmin, isAllowed, sessionKey, touchUser } from './commands.js';
import { createDoneKb } from './keyboards.js';
import { userRepo, fileRepo, taskRepo } from '../../db.js';

export function registerMessageHandlers(bot, runningTasks, lastMessages) {
  
  // 创建消息处理函数
  const processUserMessage = async (ctx, userText) => {
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
      let session = getSession(key);
      if (!session) {
        session = await createPiSession(isAdmin(ctx));
        setSession(key, session);
      }

      const result = await runAgent(session, userText, progress, ctx);
      const duration = Date.now() - startTime;
      const durationStr = duration > 60000
        ? `${(duration / 60000).toFixed(1)}分钟`
        : `${(duration / 1000).toFixed(1)}秒`;

      const doneKb = createDoneKb();

      if (result.streamMsgId) {
        try {
          const finalText = result.response + `\n\n⏱ ${durationStr}`;
          await ctx.api.editMessageText(chatId, result.streamMsgId, finalText, { reply_markup: doneKb, parse_mode: 'Markdown' });
        } catch {
          try {
            const finalText = result.response + `\n\n⏱ ${durationStr}`;
            await ctx.api.editMessageText(chatId, result.streamMsgId, finalText, { reply_markup: doneKb });
          } catch {}
        }
      } else if (result.response && result.response.trim()) {
        await sendLongText(ctx, result.response + `\n\n⏱ ${durationStr}`, doneKb);
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
  };

  // 文本消息
  bot.on('message:text', async (ctx) => {
    if (!isAllowed(ctx)) {
      await ctx.reply('⛔ 无权限。\n你的 ID: ' + ctx.from.id);
      return;
    }
    await processUserMessage(ctx, ctx.message.text);
  });

  // 文件上传
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

  return processUserMessage;
}
