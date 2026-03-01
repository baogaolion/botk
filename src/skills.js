/**
 * Skill 管理模块
 * 扫描已安装的 skill，优先使用本地 skill
 * 
 * PI SDK skill 位置：
 * - 全局: ~/.pi/agent/skills/
 * - 项目: .pi/agent/skills/ 或 .pi/skills/
 */

import { resolve } from 'path';
import { readdirSync, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { AGENT_DIR } from './config.js';

// 所有可能的 skill 目录
const SKILL_DIRS = [
  resolve(AGENT_DIR, 'skills'),           // 项目: .pi/agent/skills/
  resolve(process.cwd(), '.pi', 'skills'), // 项目: .pi/skills/
  resolve(homedir(), '.pi', 'agent', 'skills'), // 全局: ~/.pi/agent/skills/
  resolve(homedir(), '.agents', 'skills'), // 全局: ~/.agents/skills/ (PI SDK 实际存储位置)
];

// 缓存已安装的 skill 列表
let installedSkills = [];

/**
 * 扫描单个目录下的 skill
 */
function scanSkillDir(skillsDir, foundNames) {
  if (!existsSync(skillsDir)) return;
  
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      // 处理目录（包含 SKILL.md）
      if (entry.isDirectory()) {
        const skillName = entry.name;
        if (foundNames.has(skillName)) continue; // 避免重复
        
        const skillPath = resolve(skillsDir, skillName);
        const skillMdPath = resolve(skillPath, 'SKILL.md');
        
        if (existsSync(skillMdPath)) {
          const skillInfo = parseSkillMd(skillMdPath, skillName, skillPath);
          installedSkills.push(skillInfo);
          foundNames.add(skillName);
        }
      }
      // 处理直接的 .md 文件（根目录的 skill 文件）
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
        const skillName = entry.name.replace(/\.md$/, '');
        if (foundNames.has(skillName)) continue;
        
        const skillPath = resolve(skillsDir, entry.name);
        const skillInfo = parseSkillMd(skillPath, skillName, skillsDir);
        installedSkills.push(skillInfo);
        foundNames.add(skillName);
      }
    }
  } catch (err) {
    console.error(`[Skills] 扫描 ${skillsDir} 失败:`, err.message);
  }
}

/**
 * 解析 SKILL.md 文件
 */
function parseSkillMd(mdPath, skillName, skillPath) {
  let description = '';
  let keywords = [];
  
  try {
    const content = readFileSync(mdPath, 'utf-8');
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
  
  return {
    name: skillName,
    path: skillPath,
    description: description || skillName,
    keywords
  };
}

/**
 * 扫描已安装的 skill
 * 读取多个目录下的 SKILL.md 获取描述
 */
export function scanInstalledSkills() {
  installedSkills = [];
  const foundNames = new Set();
  
  for (const dir of SKILL_DIRS) {
    scanSkillDir(dir, foundNames);
  }
  
  console.log(`[Skills] 扫描目录: ${SKILL_DIRS.filter(d => existsSync(d)).join(', ')}`);
  console.log(`[Skills] 已安装 ${installedSkills.length} 个技能:`, installedSkills.map(s => s.name).join(', ') || '无');
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
