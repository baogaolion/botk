/**
 * Telegram 键盘定义
 */

import { InlineKeyboard } from 'grammy';

// 主菜单键盘
export const welcomeKb = new InlineKeyboard()
  .text('📚 已装技能', 'skills_list')
  .text('🤖 切换模型', 'select_model')
  .row()
  .text('📬 客户咨询', 'submissions_menu');

// 创建完成键盘
export function createDoneKb() {
  return new InlineKeyboard()
    .text('🗑 清除对话', 'clear_session')
    .text('🏠 主菜单', 'main_menu');
}

// 创建主菜单按钮
export function createMainMenuKb() {
  return new InlineKeyboard().text('🏠 主菜单', 'main_menu');
}

// 创建模型选择键盘
export function createModelKb(models, currentIndex) {
  const kb = new InlineKeyboard();
  models.forEach((m, i) => {
    const isCurrent = i === currentIndex;
    kb.text(`${isCurrent ? '✅' : ''} ${m.name}`, `set_model_${i}`);
    if ((i + 1) % 2 === 0) kb.row();
  });
  kb.row().text('🏠 主菜单', 'main_menu');
  return kb;
}

// 创建咨询菜单键盘
export function createSubmissionsMenuKb() {
  return new InlineKeyboard()
    .text('🟡 处理中', 'submissions_processing_0')
    .text('✅ 已处理', 'submissions_done_0')
    .row()
    .text('📝 全部', 'submissions_all_0')
    .text('🏠 主菜单', 'main_menu');
}

// 创建咨询列表键盘
export function createSubmissionsListKb(filter, offset, limit, total, rows) {
  const kb = new InlineKeyboard();
  if (offset > 0) {
    kb.text('⬅️ 上一页', `submissions_${filter}_${offset - limit}`);
  }
  if (offset + limit < total) {
    kb.text('下一页 ➡️', `submissions_${filter}_${offset + limit}`);
  }
  kb.row();
  
  if (filter === 'processing') {
    for (const row of rows) {
      kb.text(`✅ #${row.id}`, `mark_done_${row.id}`);
    }
    kb.row();
  }
  
  kb.text('🟡 处理中', 'submissions_processing_0')
    .text('✅ 已处理', 'submissions_done_0')
    .row()
    .text('🏠 主菜单', 'main_menu');
  
  return kb;
}
