/**
 * 会话管理模块 (LRU + TTL)
 */

import { SESSION_TTL_MS, SESSION_MAX } from './config.js';

const sessions = new Map();
let onSessionDelete = null;

// 设置会话删除回调
export function setOnSessionDelete(callback) {
  onSessionDelete = callback;
}

// 获取会话
export function getSession(key) {
  const entry = sessions.get(key);
  if (!entry) return null;
  entry.lastUsed = Date.now();
  return entry.session;
}

// 设置会话
export function setSession(key, session) {
  sessions.set(key, { session, lastUsed: Date.now() });
  evictSessions();
}

// 删除会话
export function deleteSession(key) {
  const entry = sessions.get(key);
  if (entry) {
    try { entry.session.dispose(); } catch {}
    sessions.delete(key);
    if (onSessionDelete) onSessionDelete(key);
  }
}

// 清理过期会话 (LRU + TTL)
export function evictSessions() {
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (now - entry.lastUsed > SESSION_TTL_MS) deleteSession(key);
  }
  if (sessions.size > SESSION_MAX) {
    const sorted = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < sorted.length - SESSION_MAX; i++) deleteSession(sorted[i][0]);
  }
}

// 获取会话数量
export function getSessionCount() {
  return sessions.size;
}

// 获取所有会话 keys
export function getSessionKeys() {
  return [...sessions.keys()];
}

// 清除所有会话
export function clearAllSessions() {
  for (const key of sessions.keys()) {
    deleteSession(key);
  }
}
