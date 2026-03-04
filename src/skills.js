/**
 * Skill 管理模块
 * 扫描已安装的 skill，优先使用本地 skill
 * 
 * PI SDK skill 位置：
 * - 全局: ~/.pi/agent/skills/
 * - 项目: .pi/agent/skills/ 或 .pi/skills/
 */

import { resolve } from 'path';
import { readdirSync, existsSync, readFileSync, lstatSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { AGENT_DIR } from './config.js';
import { skillUsageRepo } from '../db.js';

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
 * 检查路径是否为目录（跟随符号链接）
 */
function isDirectoryOrSymlinkToDir(fullPath) {
  try {
    const stat = statSync(fullPath); // statSync 会跟随符号链接
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 扫描单个目录下的 skill
 */
function scanSkillDir(skillsDir, foundNames) {
  if (!existsSync(skillsDir)) return;
  
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const skillName = entry.name;
      if (foundNames.has(skillName)) continue; // 避免重复
      
      const fullPath = resolve(skillsDir, skillName);
      
      // 处理目录或符号链接指向的目录
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        // 检查是否为目录（跟随符号链接）
        if (!isDirectoryOrSymlinkToDir(fullPath)) {
          // 符号链接断开或指向文件，跳过
          continue;
        }
        
        const skillMdPath = resolve(fullPath, 'SKILL.md');
        
        if (existsSync(skillMdPath)) {
          const skillInfo = parseSkillMd(skillMdPath, skillName, fullPath);
          installedSkills.push(skillInfo);
          foundNames.add(skillName);
        }
      }
      // 处理直接的 .md 文件（根目录的 skill 文件）
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
        const skillInfo = parseSkillMd(fullPath, skillName.replace(/\.md$/, ''), skillsDir);
        installedSkills.push(skillInfo);
        foundNames.add(skillName.replace(/\.md$/, ''));
      }
    }
  } catch (err) {
    console.error(`[Skills] 扫描 ${skillsDir} 失败:`, err.message);
  }
}

/**
 * 解析 SKILL.md 文件，并自动缓存使用方式
 */
function parseSkillMd(mdPath, skillName, skillPath) {
  let description = '';
  let keywords = [];
  let usageExample = '';
  
  console.log(`[Skills] 解析 SKILL.md: ${mdPath}`);
  
  try {
    const content = readFileSync(mdPath, 'utf-8');
    console.log(`[Skills]   文件大小: ${content.length} 字符`);
    
    // 提取第一行作为描述（通常是 # 标题）
    const firstLine = content.split('\n').find(line => line.trim());
    if (firstLine) {
      description = firstLine.replace(/^#+\s*/, '').trim();
      console.log(`[Skills]   描述: ${description}`);
    }
    
    // 提取关键词（如果有 keywords: 行）
    const keywordsMatch = content.match(/keywords?:\s*(.+)/i);
    if (keywordsMatch) {
      keywords = keywordsMatch[1].split(/[,，]/).map(k => k.trim()).filter(Boolean);
      console.log(`[Skills]   关键词:`, keywords);
    }
    
    // 提取使用方式：查找代码块中的 curl 或 bash 命令
    const codeBlockMatch = content.match(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      usageExample = codeBlockMatch[1].trim();
      console.log(`[Skills]   使用示例 (前100字符): ${usageExample.substring(0, 100)}`);
    } else {
      console.log(`[Skills]   未找到使用示例代码块`);
    }
    
    // 如果没有缓存且有使用方式，自动保存
    if (usageExample && skillName !== 'find-skills') {
      const cached = skillUsageRepo.get(skillName);
      if (!cached) {
        skillUsageRepo.set(skillName, usageExample, description);
        console.log(`[Skills] ✅ 自动缓存技能用法: ${skillName}`);
      } else {
        console.log(`[Skills] ✅ 技能已有缓存: ${skillName}`);
      }
    }
  } catch (err) {
    console.log(`[Skills] ⚠️ 解析失败: ${err.message}`);
  }
  
  return {
    name: skillName,
    path: skillPath,
    description: description || skillName,
    keywords,
    usageExample
  };
}

/**
 * 扫描已安装的 skill
 * 读取多个目录下的 SKILL.md 获取描述
 */
export function scanInstalledSkills() {
  installedSkills = [];
  const foundNames = new Set();
  
  console.log('[Skills] ========== 开始扫描技能目录 ==========');
  for (const dir of SKILL_DIRS) {
    console.log(`[Skills] 检查目录: ${dir}`);
    console.log(`[Skills]   存在: ${existsSync(dir)}`);
    if (existsSync(dir)) {
      try {
        const entries = readdirSync(dir);
        console.log(`[Skills]   内容 (${entries.length} 项):`, entries.join(', '));
      } catch (err) {
        console.log(`[Skills]   读取失败: ${err.message}`);
      }
    }
    scanSkillDir(dir, foundNames);
  }
  
  console.log(`[Skills] ========== 扫描完成 ==========`);
  console.log(`[Skills] 已安装 ${installedSkills.length} 个技能:`, installedSkills.map(s => s.name).join(', ') || '无');
  if (installedSkills.length > 0) {
    installedSkills.forEach(s => {
      console.log(`[Skills]   - ${s.name}: ${s.path}`);
    });
  }
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
 * 如果有缓存的使用方式，直接提供；否则提示读取 SKILL.md
 */
export function getInstalledSkillsPrompt() {
  const skills = installedSkills.filter(s => s.name !== 'find-skills');
  
  if (skills.length === 0) {
    return '';
  }
  
  let prompt = '## 已安装的技能（必须优先使用）\n';
  prompt += '以下技能已安装，**直接使用，不要搜索**：\n\n';
  
  // 分类：有缓存使用方式的 和 没有的
  const cachedSkills = [];
  const uncachedSkills = [];
  
  for (const skill of skills) {
    const cached = skillUsageRepo.get(skill.name);
    if (cached && cached.usage_example) {
      cachedSkills.push({ ...skill, cached });
    } else {
      uncachedSkills.push(skill);
    }
  }
  
  // 有缓存的技能：直接提供使用方式
  if (cachedSkills.length > 0) {
    prompt += '### 可直接使用（已学习用法）\n';
    for (const skill of cachedSkills) {
      prompt += `\n**${skill.name}**`;
      if (skill.cached.description) {
        prompt += `: ${skill.cached.description}`;
      }
      prompt += '\n```\n' + skill.cached.usage_example + '\n```\n';
    }
  }
  
  // 没有缓存的技能：需要先读取 SKILL.md
  if (uncachedSkills.length > 0) {
    prompt += '\n### 需要先读取用法\n';
    for (const skill of uncachedSkills) {
      prompt += `- **${skill.name}**`;
      if (skill.description && skill.description !== skill.name) {
        prompt += `: ${skill.description}`;
      }
      prompt += ` → 先 \`read ${skill.path}/SKILL.md\`\n`;
    }
    prompt += '\n读取后，请用以下格式保存使用方式（方便下次直接用）：\n';
    prompt += '```\n[SAVE_SKILL_USAGE]\nskill: 技能名\nusage: 具体的命令或调用方式\ndesc: 简短描述\n[/SAVE_SKILL_USAGE]\n```\n';
  }
  
  prompt += '\n**规则**：直接执行，不要解释过程，只输出结果。\n';
  
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
