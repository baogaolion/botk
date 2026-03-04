/**
 * Telegram API 错误处理工具
 */

/**
 * 包装 Telegram API 调用，自动处理 429 限流错误
 */
export async function safeApiCall(ctx, apiFunc) {
  try {
    return await apiFunc();
  } catch (err) {
    // 429 限流错误：返回友好提示
    if (err.error_code === 429 || err.message?.includes('429')) {
      const retryAfter = err.parameters?.retry_after || err.error?.parameters?.retry_after || 60;
      const minutes = Math.ceil(retryAfter / 60);
      
      // 尝试通过 answerCallbackQuery 显示提示（如果是回调查询）
      try {
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({
            text: `⏳ 操作过于频繁，请等待 ${minutes} 分钟后再试`,
            show_alert: true
          });
          return;
        }
      } catch {}
      
      // 如果不是回调或 answerCallbackQuery 失败，尝试发送消息
      try {
        await ctx.reply(`⏳ 操作过于频繁，请等待 ${minutes} 分钟后再试\n\nTelegram 限制了请求频率，请稍后重试。`);
      } catch {}
      
      return;
    }
    
    // 其他错误继续抛出
    throw err;
  }
}

/**
 * 包装回调处理器，自动处理 429 错误
 */
export function wrapCallback(handler) {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (err) {
      // 429 限流错误
      if (err.error_code === 429 || err.message?.includes('429')) {
        const retryAfter = err.parameters?.retry_after || err.error?.parameters?.retry_after || 60;
        const minutes = Math.ceil(retryAfter / 60);
        
        try {
          await ctx.answerCallbackQuery({
            text: `⏳ 操作过于频繁，请等待 ${minutes} 分钟`,
            show_alert: true
          });
        } catch {}
        
        console.log(`[Bot] ⚠️ 429 限流: 需等待 ${retryAfter} 秒`);
        return;
      }
      
      // 其他错误继续抛出
      throw err;
    }
  };
}
