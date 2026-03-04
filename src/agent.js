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
  ModelRegistry,
} from '@mariozechner/pi-coding-agent';
import { streamSimple } from '@mariozechner/pi-ai';
import { AGENT_DIR, USER_DOCS_DIR, TG_MAX_LEN, STREAM_THROTTLE_MS, TYPING_INTERVAL_MS } from './config.js';
import { getCurrentModel, getCurrentModelName, logApiKeyStatus } from './models.js';
import { convertToTelegramMarkdown } from './utils.js';
import { scanInstalledSkills, getInstalledSkillsPrompt } from './skills.js';

// ==================== 全局共享变量 ====================

let sharedSettingsManager, sharedLoader, sharedUserLoader, sharedAuth, sharedModelRegistry;

// ==================== 系统提示 ====================

function getAdminPrompt() {
  const installedSkillsPrompt = getInstalledSkillsPrompt();
  
  return [
    '你是 bao，一个万能私人助手。用中文回复。',
    `当前工作目录: ${process.cwd()}`,
    `用户文档目录: ${USER_DOCS_DIR}`,
    '你拥有服务器完整权限：可以通过 bash 执行任意命令、读写编辑任何文件、访问网络（curl/wget）。',
    '',
    '## 回复规则（必须遵守）',
    '- **一次执行**：执行一次命令就返回结果，不要反复尝试不同方式',
    '- **不要输出思考过程**：不要说"让我..."、"让我尝试..."、"我来检查..."',
    '- **直接给结果**：执行完直接展示结果，不要描述你做了什么',
    '- **内容详细完整**：结果要有结构、有条理，信息要丰富详细',
    '  - 天气查询：包含温度、体感温度、湿度、风向风速、天气状况、日出日落、未来几天预报等',
    '  - 其他查询：提供完整有用的信息，不要过于简略',
    '- **失败就说失败**：如果一次执行失败，直接告诉用户失败原因，不要自动重试多次',
    '',
    '## 文件操作规则',
    `- 文件分析范围：${USER_DOCS_DIR} 和 /app/uploads`,
    `- 禁止扫描系统目录`,
    '',
    installedSkillsPrompt,
    '## 技能扩展规则',
    '1. **优先使用已安装的技能**：直接用，不要解释',
    '2. 没有合适技能时才搜索：`npx skills find "关键词"`',
    '3. 安装：`npx skills add <package> -g -y`',
  ].join('\n');
}

function getUserPrompt() {
  const installedSkillsPrompt = getInstalledSkillsPrompt();
  
  return [
    '你是 bao，一个万能私人助手。用中文回复。',
    `当前工作目录: ${process.cwd()}`,
    `用户文档目录: ${USER_DOCS_DIR}`,
    '',
    '## 回复规则',
    '- **不要输出思考过程**：不要说"让我..."、"我来检查..."',
    '- **内容要完整**：结果要有结构、有条理',
    '- **直接给结果**：执行完直接展示结果',
    '- **格式清晰**：适当使用标题、列表等格式',
    '',
    '## 权限',
    '- 只读命令：ls, cat, grep, find, curl, wget 等',
    '- 禁止写入、删除、修改操作',
    '',
    '## 文件操作',
    `- 范围：${USER_DOCS_DIR} 和上传文件`,
    '- 禁止扫描系统目录',
    '',
    installedSkillsPrompt,
    '## 技能',
    '- 优先用已安装技能，直接用不要解释',
    '- 没有才搜索新技能',
  ].join('\n');
}

// ==================== 初始化 ====================

export async function initPiGlobals() {
  logApiKeyStatus();
  
  // 扫描已安装的技能
  scanInstalledSkills();
  
  const model = getCurrentModel();
  if (!model) throw new Error('没有可用的模型，请检查 API Key 配置');

  sharedAuth = new AuthStorage(resolve(AGENT_DIR, 'auth.json'));
  
  // 设置所有 API Key
  if (process.env.DEEPSEEK_API_KEY) {
    sharedAuth.setRuntimeApiKey('deepseek', process.env.DEEPSEEK_API_KEY);
    console.log('[DEBUG] AuthStorage deepseek key: SET');
  }
  if (process.env.OPENAI_API_KEY) {
    sharedAuth.setRuntimeApiKey('openai', process.env.OPENAI_API_KEY);
  }
  if (process.env.GEMINI_API_KEY) {
    sharedAuth.setRuntimeApiKey('google', process.env.GEMINI_API_KEY);
  }
  
  // 创建 ModelRegistry
  sharedModelRegistry = new ModelRegistry(sharedAuth);

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
    modelRegistry: sharedModelRegistry,
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

// 最大工具执行轮次（防止无限循环）
const MAX_TOOL_TURNS = 5;

export async function runAgent(session, userText, progress, ctx) {
  let fullResponse = '';
  let toolName = '';
  let lastError = null;
  
  let streamMsgId = null;
  let lastDisplayedText = '';
  let updateTimer = null;
  let typingTimer = null;
  let loadingTimer = null;
  let loadingFrame = 0;
  let isUpdating = false;
  let toolTurnCount = 0; // 工具执行轮次计数
  const chatId = ctx.chat?.id;
  
  // 加载动画帧
  const loadingFrames = ['💭 思考中', '💭 思考中.', '💭 思考中..', '💭 思考中...'];

  const initStreamMsg = async () => {
    if (streamMsgId) return;
    try {
      console.log(`[Stream] 初始化流式消息 (使用 sendMessageDraft)`);
      // 使用 sendMessageDraft 初始化流式消息
      const msg = await ctx.api.callApi('sendMessageDraft', {
        chat_id: chatId,
        text: loadingFrames[0]
      });
      streamMsgId = msg.message_id;
      console.log(`[Stream] 消息ID: ${streamMsgId}`);
    } catch (err) {
      console.log(`[Stream] 初始化失败: ${err.message}`);
      // 回退到普通消息
      try {
        const msg = await ctx.reply(loadingFrames[0]);
        streamMsgId = msg.message_id;
      } catch {}
    }
  };

  const sendTyping = () => {
    // 不等待，避免阻塞
    ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
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
  
  // 加载动画：显示思考中或工具执行状态
  const updateLoadingAnimation = async () => {
    if (!streamMsgId) return;
    
    loadingFrame = (loadingFrame + 1) % loadingFrames.length;
    let text = loadingFrames[loadingFrame];
    
    // 如果正在执行工具，显示工具名
    if (toolName) {
      text = `🔧 ${toolName}...`;
    }
    
    // 如果已有内容，在内容后面显示加载状态
    if (fullResponse.trim()) {
      if (toolName) {
        text = fullResponse + `\n\n🔧 ${toolName}...`;
      } else {
        return; // 有内容且没有工具执行时，不更新动画
      }
    }
    
    try {
      await ctx.api.editMessageText(chatId, streamMsgId, text);
    } catch {}
  };
  
  const startLoadingAnimation = () => {
    if (loadingTimer) return;
    loadingTimer = setInterval(updateLoadingAnimation, 400);
  };
  
  const stopLoadingAnimation = () => {
    if (loadingTimer) {
      clearInterval(loadingTimer);
      loadingTimer = null;
    }
  };

  let lastSentText = '';
  let rateLimitedUntil = 0; // 429 限流退避时间
  
  const doUpdate = async () => {
    if (isUpdating) {
      return;
    }
    
    // 429 限流退避
    if (Date.now() < rateLimitedUntil) {
      return;
    }
    
    // 构建显示文本
    let displayText = fullResponse;
    if (fullResponse.length > TG_MAX_LEN - 100) {
      displayText = '...\n\n' + fullResponse.slice(-(TG_MAX_LEN - 100));
    }
    
    // 如果正在执行工具且没有文字，显示工具状态
    if (toolName && !fullResponse.trim()) {
      displayText = `🔧 ${toolName}...`;
    } else if (toolName) {
      displayText += `\n\n🔧 ${toolName}...`;
    }
    displayText += ' ▌';
    
    // 检查是否有变化，避免重复调用 API
    if (displayText === lastSentText) {
      return;
    }
    
    const updateStart = Date.now();
    
    // 有内容后停止加载动画
    if (fullResponse.trim()) {
      stopLoadingAnimation();
    }
    
    isUpdating = true;
    
    // 转换标准 Markdown 为 Telegram 格式
    const telegramText = convertToTelegramMarkdown(displayText);
    
    if (streamMsgId && chatId) {
      // 不等待 typing，避免阻塞
      sendTyping();
      
      try {
        // 使用 sendMessageDraft 更新流式消息
        await ctx.api.callApi('sendMessageDraft', {
          chat_id: chatId,
          text: telegramText,
          parse_mode: 'Markdown'
        });
        lastSentText = displayText;
        lastDisplayedText = fullResponse;
      } catch (err) {
        // 429 限流错误：暂停更新
        if (err.message?.includes('429') || err.message?.includes('Too Many Requests')) {
          const retryMatch = err.message.match(/retry after (\d+)/);
          const retryAfter = retryMatch ? parseInt(retryMatch[1]) * 1000 : 30000;
          rateLimitedUntil = Date.now() + retryAfter;
          console.log(`[Stream] 429 限流，暂停 ${retryAfter / 1000} 秒`);
        } else if (!err.message?.includes('not modified')) {
          // Markdown 失败时回退到纯文本
          try {
            await ctx.api.callApi('sendMessageDraft', {
              chat_id: chatId,
              text: displayText
            });
            lastSentText = displayText;
            lastDisplayedText = fullResponse;
          } catch (err2) {
            if (err2.message?.includes('429') || err2.message?.includes('Too Many Requests')) {
              const retryMatch = err2.message.match(/retry after (\d+)/);
              const retryAfter = retryMatch ? parseInt(retryMatch[1]) * 1000 : 30000;
              rateLimitedUntil = Date.now() + retryAfter;
              console.log(`[Stream] 429 限流，暂停 ${retryAfter / 1000} 秒`);
            }
          }
        }
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

  let lastEventTime = Date.now();
  
  const unsub = session.subscribe((event) => {
    const now = Date.now();
    const gap = now - lastEventTime;
    
    // 记录事件间隔超过3秒的情况
    if (gap > 3000) {
      console.log(`[Stream] ⚠️ 事件间隔: ${gap}ms, 类型: ${event.type}`);
    }
    lastEventTime = now;
    
    if (event.type === 'message_end') {
      console.log(`[Stream] message_end, 响应长度: ${fullResponse.length}, 工具: ${toolName || '无'}`);
      if (event.message?.errorMessage) {
        console.log(`[Stream] 错误: ${event.message.errorMessage}`);
        const msg = event.message.errorMessage;
        if (msg.includes('quota') || msg.includes('429')) {
          lastError = { status: 429, message: '请求过于频繁或配额已用完' };
        } else if (msg.includes('500') || msg.includes('unavailable')) {
          lastError = { status: 500, message: 'AI 服务暂时不可用' };
        } else {
          lastError = { status: 0, message: msg.slice(0, 200) };
        }
      }
    }
    if (event.type === 'error') {
      console.log(`[Stream] error 事件:`, event.error);
      lastError = event.error;
    }
    if (event.type === 'auto_retry_start') {
      console.log(`[Stream] auto_retry_start: ${event.errorMessage}`);
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
    // 记录非 message_update 事件
    if (event.type !== 'message_update') {
      if (event.type !== 'message_end') {
        console.log(`[Stream] 事件: ${event.type}`);
      }
      return;
    }
    const e = event.assistantMessageEvent;
    switch (e.type) {
      case 'text_delta':
        fullResponse += e.delta;
        startUpdateTimer();
        break;
      case 'text_start':
        // 文本开始，准备接收内容
        break;
      case 'text_end':
        // 文本结束
        break;
      case 'toolcall_start': {
        // 从 partial.content[contentIndex] 获取工具名
        const toolCall = e.partial?.content?.[e.contentIndex];
        toolName = toolCall?.name || 'tool';
        console.log(`[Stream] 工具开始: ${toolName}`);
        doUpdate();
        break;
      }
      case 'toolcall_delta':
        // 工具调用参数增量，忽略
        break;
      case 'toolcall_end': {
        // toolcall_end 包含完整的 toolCall 对象
        const endToolName = e.toolCall?.name || toolName;
        console.log(`[Stream] 工具结束: ${endToolName}`);
        // 更新工具名（如果之前没获取到）
        if (!toolName || toolName === 'tool') {
          toolName = endToolName;
        }
        // 不立即清除 toolName，等工具执行完再清除
        break;
      }
    }
  });
  
  // 监听工具执行事件
  const toolUnsub = session.subscribe((event) => {
    if (event.type === 'tool_execution_start') {
      toolTurnCount++;
      console.log(`[Stream] ========== 工具执行开始 (第 ${toolTurnCount}/${MAX_TOOL_TURNS} 轮) ==========`);
      console.log(`[Stream] 工具名称: ${event.toolName || '未知'}`);
      if (event.args) {
        console.log(`[Stream] 工具参数:`, JSON.stringify(event.args, null, 2));
      }
      
      // 超过最大轮次时中止
      if (toolTurnCount >= MAX_TOOL_TURNS) {
        console.log(`[Stream] ⚠️ 工具执行次数达到上限，中止会话`);
        session.abort();
      }
    } else if (event.type === 'tool_execution_update') {
      // 只记录关键的更新信息，避免日志过多
      if (event.output) {
        const preview = typeof event.output === 'string' 
          ? event.output.substring(0, 200)
          : JSON.stringify(event.output).substring(0, 200);
        console.log(`[Stream] 工具执行更新: ${preview}${event.output.length > 200 ? '...' : ''}`);
      }
    } else if (event.type === 'tool_execution_end') {
      console.log(`[Stream] ========== 工具执行结束 ==========`);
      if (event.output) {
        console.log(`[Stream] 工具输出 (前500字符):`, typeof event.output === 'string' 
          ? event.output.substring(0, 500)
          : JSON.stringify(event.output).substring(0, 500));
      }
      if (event.error) {
        console.log(`[Stream] ⚠️ 工具执行错误:`, event.error);
      }
      toolName = ''; // 工具执行完毕，清除工具名
      doUpdate();
    }
  });

  try {
    console.log(`[Stream] 开始处理: ${userText.slice(0, 50)}...`);
    startTypingTimer();
    await initStreamMsg();
    startLoadingAnimation(); // 启动加载动画
    startUpdateTimer();
    console.log(`[Stream] 调用 AI...`);
    await session.prompt(userText);
    console.log(`[Stream] AI 响应完成, 响应长度: ${fullResponse.length}`);
  } finally {
    console.log(`[Stream] 清理定时器...`);
    stopUpdateTimer();
    stopTypingTimer();
    stopLoadingAnimation(); // 停止加载动画
    unsub();
    toolUnsub();
    console.log(`[Stream] 最终更新消息`);
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
