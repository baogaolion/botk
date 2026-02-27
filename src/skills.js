/**
 * Skill 管理模块
 * 扫描已安装的 skill，优先使用本地 skill
 */

import { resolve } from 'path';
import { readdirSync, existsSync, readFileSync } from 'fs';
import { AGENT_DIR } from './config.js';

const SKILLS_DIR = resolve(AGENT_DIR, 'skills');

// 缓存已安装的 skill 列表
let installedSkills = [];

/**
 * 扫描已安装的 skill
 * 读取每个 skill 目录下的 SKILL.md 获取描述
 */
export function scanInstalledSkills() {
  installedSkills = [];
  
  if (!existsSync(SKILLS_DIR)) {
    return installedSkills;
  }
  
  try {
    const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true });
    
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      
      const skillName = dir.name;
      const skillPath = resolve(SKILLS_DIR, skillName);
      const skillMdPath = resolve(skillPath, 'SKILL.md');
      
      let description = '';
      let keywords = [];
      
      // 尝试读取 SKILL.md 获取描述
      if (existsSync(skillMdPath)) {
        try {
          const content = readFileSync(skillMdPath, 'utf-8');
          // 提取第一行作为描述（通常是 # 标题）
          const firstLine = content.split('\n').find(line => line.trim());
          if (firstLine) {
            description = firstLine.replace(/^#+\s*/, '').trim();
          }
          // 提取关键词（如果有 keywords: 行）
          const keywordsMatch = content.match(/keywords?:\s*(.+)/i);
          if (keywordsMatch) {
            keywords = keywordsMatch[1].split(/[,，]/).map(k => k.trim()).filter(Boolean);
          }
        } catch {}
      }
      
      installedSkills.push({
        name: skillName,
        path: skillPath,
        description: description || skillName,
        keywords
      });
    }
  } catch (err) {
    console.error('[Skills] 扫描失败:', err.message);
  }
  
  console.log(`[Skills] 已安装 ${installedSkills.length} 个技能:`, installedSkills.map(s => s.name).join(', '));
  return installedSkills;
}

/**
 * 获取已安装的 skill 列表
 */
export function getInstalledSkills() {
  return installedSkills;
}

/**
 * 获取已安装 skill 的名称列表（不包括 find-skills）
 */
export function getInstalledSkillNames() {
  return installedSkills
    .filter(s => s.name !== 'find-skills')
    .map(s => s.name);
}

/**
 * 生成已安装 skill 的提示文本
 */
export function getInstalledSkillsPrompt() {
  const skills = installedSkills.filter(s => s.name !== 'find-skills');
  
  if (skills.length === 0) {
    return '';
  }
  
  let prompt = '## 已安装的技能（优先使用）\n';
  prompt += '以下技能已安装在本地，请优先使用，无需重新搜索安装：\n\n';
  
  for (const skill of skills) {
    prompt += `- **${skill.name}**`;
    if (skill.description && skill.description !== skill.name) {
      prompt += `: ${skill.description}`;
    }
    prompt += '\n';
  }
  
  prompt += '\n只有当以上技能无法满足需求时，才使用 find-skills 搜索新技能。\n';
  
  return prompt;
}

/**
 * 检查是否有匹配的已安装 skill
 * @param {string} query - 用户查询或关键词
 * @returns {object|null} 匹配的 skill 或 null
 */
export function findMatchingSkill(query) {
  const lowerQuery = query.toLowerCase();
  
  for (const skill of installedSkills) {
    if (skill.name === 'find-skills') continue;
    
    // 检查名称匹配
    if (skill.name.toLowerCase().includes(lowerQuery) || 
        lowerQuery.includes(skill.name.toLowerCase())) {
      return skill;
    }
    
    // 检查关键词匹配
    for (const keyword of skill.keywords) {
      if (keyword.toLowerCase().includes(lowerQuery) || 
          lowerQuery.includes(keyword.toLowerCase())) {
        return skill;
      }
    }
    
    // 检查描述匹配
    if (skill.description.toLowerCase().includes(lowerQuery)) {
      return skill;
    }
  }
  
  return null;
}
