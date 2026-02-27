/**
 * 进度消息管理类
 */

import { InlineKeyboard } from 'grammy';
import { MSG_THROTTLE_MS } from './config.js';

export class ProgressMessage {
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
