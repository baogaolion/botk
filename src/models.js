/**
 * AI 模型管理模块
 */

import { getModel } from '@mariozechner/pi-ai';

// ==================== 可用模型配置 ====================

const MODEL_DEFINITIONS = [
  { 
    provider: 'deepseek', 
    id: 'deepseek-chat', 
    name: 'DeepSeek Chat', 
    envKey: 'DEEPSEEK_API_KEY',
    customModel: {
      id: 'deepseek-chat',
      name: 'DeepSeek Chat',
      api: 'openai-completions',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnvVar: 'DEEPSEEK_API_KEY',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64000,
      maxTokens: 8192,
    }
  },
  { 
    provider: 'deepseek', 
    id: 'deepseek-reasoner', 
    name: 'DeepSeek R1', 
    envKey: 'DEEPSEEK_API_KEY',
    customModel: {
      id: 'deepseek-reasoner',
      name: 'DeepSeek R1',
      api: 'openai-completions',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnvVar: 'DEEPSEEK_API_KEY',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64000,
      maxTokens: 8192,
    }
  },
  { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', envKey: 'OPENAI_API_KEY' },
  { provider: 'openai', id: 'gpt-4o-mini', name: 'GPT-4o Mini', envKey: 'OPENAI_API_KEY' },
  { provider: 'openai', id: 'gpt-4-turbo', name: 'GPT-4 Turbo', envKey: 'OPENAI_API_KEY' },
  { provider: 'google', id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', envKey: 'GEMINI_API_KEY' },
  { provider: 'google', id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', envKey: 'GEMINI_API_KEY' },
  { provider: 'google', id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', envKey: 'GEMINI_API_KEY' },
  { provider: 'kimi', id: 'moonshot-v1-32k', name: 'Kimi 32K', envKey: 'MOONSHOT_API_KEY' },
  { provider: 'kimi', id: 'moonshot-v1-128k', name: 'Kimi 128K', envKey: 'MOONSHOT_API_KEY' },
];

// 当前选择的模型索引
let currentModelIndex = 0;

// 获取当前可用的模型（API Key 已配置的）
export function getAvailableModels() {
  return MODEL_DEFINITIONS.filter(m => process.env[m.envKey]);
}

// 获取当前选择的模型对象
export function getCurrentModel() {
  const available = getAvailableModels();
  if (!available.length) return null;
  if (currentModelIndex >= available.length) currentModelIndex = 0;
  const modelDef = available[currentModelIndex];
  
  if (modelDef.customModel) {
    return modelDef.customModel;
  }
  
  return getModel(modelDef.provider, modelDef.id);
}

// 获取当前模型的显示名称
export function getCurrentModelName() {
  const available = getAvailableModels();
  if (!available.length) return '无可用模型';
  if (currentModelIndex >= available.length) currentModelIndex = 0;
  return available[currentModelIndex].name;
}

// 获取当前模型索引
export function getCurrentModelIndex() {
  return currentModelIndex;
}

// 设置当前模型索引
export function setCurrentModelIndex(index) {
  const available = getAvailableModels();
  if (index >= 0 && index < available.length) {
    currentModelIndex = index;
    return true;
  }
  return false;
}

// 打印 API Key 状态（调试用）
export function logApiKeyStatus() {
  console.log('[DEBUG] API Key status:');
  console.log('  DEEPSEEK_API_KEY:', process.env.DEEPSEEK_API_KEY ? 'SET' : 'NOT SET');
  console.log('  OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'SET' : 'NOT SET');
  console.log('  GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET');
  console.log('  MOONSHOT_API_KEY:', process.env.MOONSHOT_API_KEY ? 'SET' : 'NOT SET');
  const available = getAvailableModels();
  console.log('[DEBUG] Available models count:', available.length);
  console.log('[DEBUG] Available models:', available.map(m => m.name).join(', '));
}
