/**
 * PI Agent 初始化和执行模块
 */

import { resolve } from 'path';
import {
  AuthStorage,
  createAgentSession,
  SessionManager,
  codingTools,
  DefaultResourceLoader,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import { streamSimple } from '@mariozechner/pi-ai';
import { AGENT_DIR, USER_DOCS_DIR, TG_MAX_LEN, STREAM_THROTTLE_MS, TYPING_INTERVAL_MS } from './config.js';
import { getCurrentModel, getCurrentModelName, logApiKeyStatus } from './models.js';
import { convertToTelegramMarkdown } from './utils.js';

// ==================== 全局共享变量 ====================

let sharedSettingsManager, sharedLoader, sharedUserLoader, sharedAuth;

// ==================== 系统提示 ====================

function getAdminPrompt() {
  return [
    '你是 bao，一个万能私人助手。用中文回复。',
    `当前工作目录: ${process.cwd()}`,
    `用户文档目录: ${USER_DOCS_DIR}`,
    '你拥有服务器完整权限：可以通过 bash 执行任意命令、读写编辑任何文件、访问网络（curl/wget）。',
    '',
    '## 文件操作规则（重要）',
    `- **文件分析范围限制**：只能在以下位置分析文件：`,
    `  1. 用户文档目录: ${USER_DOCS_DIR}`,
    `  2. 用户上传的文件（临时目录 /app/uploads）`,
    `- **禁止扫描其他目录**：不要扫描 /home、/etc、/var 等系统目录`,
    '- 当用户上传任何文件（图片、文档、音频等）时，询问用户是否要保存到文档目录',
    '- 如果用户确认保存，将文件保存到文档目录并告知保存路径',
    '',
    '## 技能扩展',
    '当用户的需求超出你当前能力时，使用 find-skills 技能搜索并安装新技能。',
    '步骤：1. 用 bash 执行 npx skills find "关键词" 搜索',
    '2. 找到后执行 npx skills add <package> -g -y 安装',
    '3. 安装后使用新技能完成任务',
    '如果搜索不到技能，就用 bash 和其他基础工具直接完成。',
    '',
    '保持简洁、有用、接地气。不要说废话。',
  ].join('\n');
}

function getUserPrompt() {
  return [
    '你是 bao，一个万能私人助手。用中文回复。',
    `当前工作目录: ${process.cwd()}`,
    `用户文档目录: ${USER_DOCS_DIR}`,
    '你可以帮用户完成各种任务：回答问题、翻译、总结、数据分析、写作等。',
    '',
    '## 权限',
    '  - 可以用 bash 执行只读命令：ls, cat, head, tail, grep, find, wc, curl, wget, df, du, date, whoami, uname, ps, top',
    '  - 可以用 read 工具读取文件',
    '  - 禁止执行任何写入、修改、删除操作（write, edit, rm, mv, cp, mkdir, chmod, chown, apt, npm install 等）',
    '  - 禁止执行 sudo、shutdown、reboot、kill、pkill 等危险命令',
    '  - 如果用户要求你做禁止的操作，礼貌地告知权限不足，建议联系管理员',
    '',
    '## 文件操作规则（重要）',
    `- **文件分析范围限制**：只能在以下位置分析文件：`,
    `  1. 用户文档目录: ${USER_DOCS_DIR}`,
    `  2. 用户上传的文件`,
    `- **禁止扫描其他目录**：不要扫描 /home、/etc、/var 等系统目录`,
    '- 当用户上传任何文件时，告知用户你可以分析该文件，但无法保存（需要管理员权限）',
    '',
    '当用户的需求超出你当前能力时，使用 find-skills 技能搜索并安装新技能。',
    '保持简洁、有用、接地气。不要说废话。',
  ].join('\n');
}

// ==================== 初始化 ====================

export async function initPiGlobals() {
  logApiKeyStatus();
  
  const model = getCurrentModel();
  if (!model) throw new Error('没有可用的模型，请检查 API Key 配置');

  sharedAuth = new AuthStorage(resolve(AGENT_DIR, 'auth.json'));
  if (process.env.DEEPSEEK_API_KEY) {
    sharedAuth.setRuntimeApiKey('deepseek', process.env.DEEPSEEK_API_KEY);
    console.log('[DEBUG] AuthStorage deepseek key: SET');
  }

  console.log('[DEBUG] Selected model:', getCurrentModelName());

  sharedSettingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 3 },
  });

  sharedLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: AGENT_DIR,
    settingsManager: sharedSettingsManager,
    systemPromptOverride: () => getAdminPrompt(),
  });
  await sharedLoader.reload();

  sharedUserLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: AGENT_DIR,
    settingsManager: sharedSettingsManager,
    systemPromptOverride: () => getUserPrompt(),
  });
  await sharedUserLoader.reload();
}

// ==================== 创建会话 ====================

export async function createPiSession(admin = false) {
  const model = getCurrentModel();
  if (!model) throw new Error('没有可用的模型');
  
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir: AGENT_DIR,
    model,
    thinkingLevel: 'off',
    tools: codingTools,
    authStorage: sharedAuth,
    resourceLoader: admin ? sharedLoader : sharedUserLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: sharedSettingsManager,
  });
  
  if (model.provider === 'deepseek') {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    session.agent.streamFn = (m, context) => streamSimple(m, context, { apiKey });
  } else {
    session.agent.streamFn = streamSimple;
  }
  
  return session;
}

// ==================== 运行 Agent ====================

export async function runAgent(session, userText, progress, ctx) {
  let fullResponse = '';
  let toolName = '';
  let lastError = null;
  
  let streamMsgId = null;
  let lastDisplayedText = '';
  let updateTimer = null;
  let typingTimer = null;
  let isUpdating = false;
  const chatId = ctx.chat?.id;

  const initStreamMsg = async () => {
    if (streamMsgId) return;
    try {
      const msg = await ctx.reply('💭 思考中...');
      streamMsgId = msg.message_id;
    } catch {}
  };

  const sendTyping = async () => {
    try {
      await ctx.api.sendChatAction(chatId, 'typing');
    } catch {}
  };

  const startTypingTimer = () => {
    if (typingTimer) return;
    sendTyping();
    typingTimer = setInterval(sendTyping, TYPING_INTERVAL_MS);
  };

  const stopTypingTimer = () => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
  };

  const doUpdate = async () => {
    if (isUpdating) return;
    if (fullResponse === lastDisplayedText) return;
    
    isUpdating = true;
    lastDisplayedText = fullResponse;
    
    let displayText = fullResponse;
    if (fullResponse.length > TG_MAX_LEN - 100) {
      displayText = '...\n\n' + fullResponse.slice(-(TG_MAX_LEN - 100));
    }
    displayText += ' ▌';
    
    // 转换标准 Markdown 为 Telegram 格式
    const telegramText = convertToTelegramMarkdown(displayText);
    
    if (streamMsgId && chatId) {
      // 每次更新前发送 typing 动画（核心技巧4）
      await sendTyping();
      
      try {
        await ctx.api.editMessageText(chatId, streamMsgId, telegramText, { parse_mode: 'Markdown' });
      } catch {
        try {
          // Markdown 失败时回退到纯文本
          await ctx.api.editMessageText(chatId, streamMsgId, displayText);
        } catch {}
      }
    }
    isUpdating = false;
  };

  const startUpdateTimer = () => {
    if (updateTimer) return;
    updateTimer = setInterval(doUpdate, STREAM_THROTTLE_MS);
  };

  const stopUpdateTimer = () => {
    if (updateTimer) {
      clearInterval(updateTimer);
      updateTimer = null;
    }
  };

  const unsub = session.subscribe((event) => {
    if (event.type === 'message_end' && event.message?.errorMessage) {
      const msg = event.message.errorMessage;
      if (msg.includes('quota') || msg.includes('429')) {
        lastError = { status: 429, message: '请求过于频繁或配额已用完' };
      } else if (msg.includes('500') || msg.includes('unavailable')) {
        lastError = { status: 500, message: 'AI 服务暂时不可用' };
      } else {
        lastError = { status: 0, message: msg.slice(0, 200) };
      }
    }
    if (event.type === 'error') {
      lastError = event.error;
    }
    if (event.type === 'auto_retry_start') {
      try {
        const errData = JSON.parse(event.errorMessage || '{}');
        const innerErr = JSON.parse(errData.error?.message || '{}');
        if (innerErr.error?.code === 429) {
          lastError = { status: 429, message: '请求过于频繁或配额已用完' };
        } else if (innerErr.error?.code >= 500) {
          lastError = { status: innerErr.error.code, message: 'AI 服务暂时不可用' };
        } else {
          lastError = { status: innerErr.error?.code || 0, message: innerErr.error?.message || event.errorMessage };
        }
      } catch {
        lastError = { status: 0, message: event.errorMessage };
      }
    }
    if (event.type !== 'message_update') return;
    const e = event.assistantMessageEvent;
    switch (e.type) {
      case 'text_delta':
        fullResponse += e.delta;
        startUpdateTimer();
        break;
      case 'tool_call_start':
        toolName = e.name || 'tool';
        break;
      case 'tool_call_end':
        break;
    }
  });

  try {
    startTypingTimer();
    await initStreamMsg();
    startUpdateTimer();
    await session.prompt(userText);
  } finally {
    stopUpdateTimer();
    stopTypingTimer();
    unsub();
    await doUpdate();
  }

  if (lastError && !fullResponse.trim()) {
    if (streamMsgId && chatId) {
      try { await ctx.api.deleteMessage(chatId, streamMsgId); } catch {}
    }
    const err = new Error(lastError.message || 'AI 请求失败');
    err.status = lastError.status;
    throw err;
  }

  if (streamMsgId && chatId && fullResponse.trim()) {
    try {
      if (fullResponse.length > TG_MAX_LEN) {
        await ctx.api.deleteMessage(chatId, streamMsgId);
        return { response: convertToTelegramMarkdown(fullResponse), streamMsgId: null };
      }
      const finalText = convertToTelegramMarkdown(fullResponse);
      await ctx.api.editMessageText(chatId, streamMsgId, finalText, { parse_mode: 'Markdown' });
      return { response: finalText, streamMsgId };
    } catch {
      // Markdown 失败时回退到纯文本
      try {
        await ctx.api.editMessageText(chatId, streamMsgId, fullResponse);
        return { response: fullResponse, streamMsgId };
      } catch {}
    }
  }

  return { response: convertToTelegramMarkdown(fullResponse), streamMsgId };
}
