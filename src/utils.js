/**
 * 工具函数模块
 */

import { TG_MAX_LEN } from './config.js';

// MarkdownV2 特殊字符转义
export function escapeMarkdownV2(text) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// 将标准 Markdown 转换为 Telegram 支持的格式
export function convertToTelegramMarkdown(text) {
  if (!text) return text;
  
  let result = text;
  
  // 转换标题：## 标题 → *标题*（粗体）
  // 处理 ### 三级标题
  result = result.replace(/^###\s+(.+)$/gm, '*$1*');
  // 处理 ## 二级标题
  result = result.replace(/^##\s+(.+)$/gm, '*$1*');
  // 处理 # 一级标题
  result = result.replace(/^#\s+(.+)$/gm, '*$1*');
  
  // 转换粗体：**文本** → *文本*
  result = result.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  
  // 转换斜体：__文本__ → _文本_（Telegram 使用单下划线）
  // 注意：标准 Markdown 的 *文本* 也是斜体，但 Telegram 用 _文本_
  
  // 保留代码块（```）和行内代码（`）
  // Telegram 原生支持这些
  
  return result;
}

// 格式化字节数
export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

// 工具名称映射
export const TOOL_NAMES = {
  bash: '执行命令',
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  grep: '搜索',
  find: '查找',
  ls: '列目录'
};

// 分段发送长文本（支持 Markdown）
export async function sendLongText(ctx, text, keyboard) {
  if (!text || text.trim().length === 0) {
    text = '✅ 完成（无文字输出）';
  }
  
  // 转换为 Telegram 格式
  const telegramText = convertToTelegramMarkdown(text);
  
  const opts = keyboard ? { reply_markup: keyboard } : {};
  if (telegramText.length <= TG_MAX_LEN) {
    try {
      await ctx.reply(telegramText, { ...opts, parse_mode: 'Markdown' });
    } catch {
      await ctx.reply(text, opts);
    }
    return;
  }
  const chunks = [];
  let remaining = telegramText;
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
