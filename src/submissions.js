/**
 * 客户咨询管理模块 (PostgreSQL)
 */

import pg from 'pg';
import { InlineKeyboard } from 'grammy';
import { PG_CONNECTION_STRING, PG_POLL_INTERVAL, ADMIN_USER } from './config.js';

let pgPool = null;
let lastPollTime = new Date();
let connectionErrors = 0;
const MAX_CONNECTION_ERRORS = 5;

// 初始化 PostgreSQL 连接池
export function initPgPool() {
  if (PG_CONNECTION_STRING) {
    pgPool = new pg.Pool({ 
      connectionString: PG_CONNECTION_STRING,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
      max: 5
    });
    pgPool.on('error', (err) => {
      connectionErrors++;
      if (connectionErrors <= MAX_CONNECTION_ERRORS) {
        console.error('[PG] Pool error:', err.message);
      }
      if (connectionErrors === MAX_CONNECTION_ERRORS) {
        console.error('[PG] 达到最大连接错误次数，将静默后续错误');
      }
    });
    console.log('🔗 PostgreSQL 已连接');
    return true;
  }
  return false;
}

// 获取连接池
export function getPgPool() {
  return pgPool;
}

// 关闭连接池
export function closePgPool() {
  if (pgPool) {
    pgPool.end();
    pgPool = null;
  }
}

let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

// 轮询新咨询
export async function pollNewSubmissions(bot) {
  if (!pgPool || !ADMIN_USER) return;
  
  // 连续失败次数过多时跳过本次轮询
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    if (consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
      console.log('[PG] 连续失败次数过多，暂停轮询。数据库恢复后将自动恢复。');
      consecutiveFailures++; // 只打印一次
    }
    return;
  }
  
  try {
    const result = await pgPool.query(`
      SELECT id, name, contact_method, contact_value, message, status, created_at
      FROM vsmaios_contact_submission
      WHERE created_at > $1 AND (status IS NULL OR status = 'pending')
      ORDER BY created_at ASC
    `, [lastPollTime]);

    // 查询成功，重置失败计数
    if (consecutiveFailures > 0) {
      console.log('[PG] 数据库连接已恢复');
      consecutiveFailures = 0;
    }

    for (const row of result.rows) {
      const time = new Date(row.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const text =
        `📬 新客户咨询 #${row.id}\n\n` +
        `👤 姓名: ${row.name || '未知'}\n` +
        `📱 ${row.contact_method}: ${row.contact_value}\n` +
        `💬 消息: ${(row.message || '').slice(0, 500)}\n` +
        `⏰ 时间: ${time}`;
      try {
        await bot.api.sendMessage(ADMIN_USER, text, {
          reply_markup: new InlineKeyboard()
            .text('✅ 标记已处理', `mark_completed_${row.id}`)
        });
        await pgPool.query(`UPDATE vsmaios_contact_submission SET status = 'processing' WHERE id = $1`, [row.id]);
      } catch (err) {
        console.error('[PG] 推送失败:', err.message);
      }
      lastPollTime = new Date(row.created_at);
    }
  } catch (err) {
    consecutiveFailures++;
    // 只记录前几次错误，避免日志过多
    if (consecutiveFailures <= MAX_CONSECUTIVE_FAILURES) {
      console.error('[PG] 轮询失败:', err.message);
    }
  }
}

// 启动轮询
export function startPolling(bot) {
  if (pgPool && ADMIN_USER) {
    setInterval(() => pollNewSubmissions(bot), PG_POLL_INTERVAL);
    console.log(`📡 客户咨询监控已启动，间隔 ${PG_POLL_INTERVAL / 1000}秒`);
  }
}

// 查询咨询列表
export async function querySubmissions(filter, offset, limit) {
  if (!pgPool) return { rows: [], total: 0 };
  
  try {
    let whereClause = '';
    if (filter === 'processing') {
      whereClause = "WHERE status = 'processing'";
    } else if (filter === 'completed') {
      whereClause = "WHERE status = 'completed'";
    }
    
    const countResult = await pgPool.query(`SELECT COUNT(*) FROM vsmaios_contact_submission ${whereClause}`);
    const total = parseInt(countResult.rows[0].count);
    
    const result = await pgPool.query(`
      SELECT id, name, contact_method, contact_value, message, status, created_at
      FROM vsmaios_contact_submission
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    
    return { rows: result.rows, total };
  } catch (err) {
    console.error('[PG] 查询失败:', err.message);
    throw new Error(`数据库查询失败: ${err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' ? '数据库服务器不可用' : err.message}`);
  }
}

// 标记为已处理
export async function markAsCompleted(id) {
  if (!pgPool) return false;
  try {
    await pgPool.query(`UPDATE vsmaios_contact_submission SET status = 'completed' WHERE id = $1`, [id]);
    return true;
  } catch (err) {
    console.error('[PG] 标记失败:', err.message);
    return false;
  }
}
