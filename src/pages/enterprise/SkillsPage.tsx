/**
 * 技能库页 - Phase 6 重构
 *
 * 核心改动：
 * - 左侧竖向分类导航（240px 宽）：Skills / Prompts / Agents
 * - 简化英雄区（160px 高）
 * - 技能卡片大幅简化（260px 宽 x 200px 高），去掉描述文字
 * - 4 列网格布局（280px 每列）
 */

import { BookOpen, FileText, RefreshCw, Search, Bot } from 'lucide-react';
import { useState } from 'react';
import { Empty } from '../../components/enterprise/atoms';
import { SkillDetail } from '../../components/enterprise/skills/SkillDetail';
import type { EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { SkillLibraryItem } from '../../shared/skill-library';
import '../../styles/skills.css';

type CategoryType = 'skills' | 'prompts' | 'agents';

const CATEGORIES = [
  { id: 'skills' as const, icon: BookOpen, label: 'Skills' },
  { id: 'prompts' as const, icon: FileText, label: 'Prompts' },
  { id: 'agents' as const, icon: Bot, label: 'Agents' },
] as const;

interface Props { workspace: EnterpriseWorkspace; skillId?: string }

export function SkillsPage({ workspace, skillId }: Props) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryType>('skills');

  const skill = workspace.skills.find(item => item.capability.id === skillId);
  if (skill) return <SkillDetail key={skill.capability.id} workspace={workspace} skill={skill} />;

  const matches = workspace.skills.filter(item =>
    `${item.capability.name} ${item.capability.description}`.toLowerCase().includes(query.trim().toLowerCase())
  );

  const hasPersonalVersions = workspace.skills.filter(item =>
    item.versions.some(version => version.scope === 'PERSONAL') || item.localVersions.length
  ).length;

  return (
    <div className="ent-skills-page">
      {/* 左侧分类导航 - 240px 宽 */}
      <nav className="ent-skills-sidebar" role="tablist" aria-label="技能分类">
        {CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const isActive = category === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`ent-skills-nav-item${isActive ? ' active' : ''}`}
              onClick={() => setCategory(cat.id)}
            >
              <Icon size={20} aria-hidden />
              <span>{cat.label}</span>
            </button>
          );
        })}
      </nav>

      {/* 右侧主内容区 */}
      <div className="ent-skills-main">
        {/* 简化英雄区 - 160px 高 */}
        <div className="ent-skills-hero">
          <div className="ent-skills-hero-text">
            <span className="ent-skills-eyebrow">KNOWLEDGE BASE</span>
            <h1 className="ent-skills-hero-title">
              技能<em>库</em>
            </h1>
            <p className="ent-skills-hero-stats">
              {workspace.skills.length} 项技能，{hasPersonalVersions} 项有个人版本
            </p>
          </div>
          <div className="ent-skills-hero-image" aria-hidden="true">
            <div className="ent-skills-hero-placeholder" />
          </div>
        </div>

        {/* 工具栏 - 48px 高 */}
        <div className="ent-skills-toolbar">
          <label className="ent-find">
            <Search size={14} aria-hidden />
            <input
              type="search"
              value={query}
              placeholder="搜索技能、提示词..."
              aria-label="搜索技能"
              onChange={event => setQuery(event.target.value)}
            />
          </label>
          <span className="ent-ask-spacer" />
          <button
            type="button"
            className="ent-btn sm"
            disabled={workspace.skillsLoading}
            onClick={() => void workspace.refreshSkills()}
          >
            <RefreshCw size={13} aria-hidden />
            刷新
          </button>
        </div>

        {/* 内容区 */}
        <div className="ent-skills-content">
          {workspace.skillsError ? (
            <div className="ent-banner danger" role="alert">
              {workspace.skillsError}，请点击刷新重试。
            </div>
          ) : null}

          {workspace.skillsLoading && !workspace.skills.length ? (
            <div role="status">正在加载技能…</div>
          ) : null}

          {skillId && !workspace.skillsLoading ? (
            <div className="ent-banner info">此技能不在当前授权列表中。</div>
          ) : null}

          {category === 'skills' ? (
            <>
              <p className="ent-result-note">
                共 {matches.length} 个技能
              </p>

              {!workspace.skillsLoading && !matches.length && !workspace.skillsError ? (
                <Empty title={query ? '没有匹配的技能' : '暂无可用技能'}>
                  企业给你的硅基员工配置技能后，会显示在这里。
                </Empty>
              ) : null}

              <div className="ent-skills-grid">
                {matches.map(item => (
                  <SkillCard key={item.capability.id} skill={item} workspace={workspace} />
                ))}
              </div>
            </>
          ) : (
            <Empty title="即将上线">
              {category === 'prompts' ? 'Prompts 提示词模板功能正在开发中。' : 'Agents 代理配置功能正在开发中。'}
            </Empty>
          )}
        </div>
      </div>
    </div>
  );
}

function SkillCard({ skill, workspace }: { skill: SkillLibraryItem; workspace: EnterpriseWorkspace }) {
  const hasPersonal = skill.versions.some(v => v.scope === 'PERSONAL') || skill.localVersions.length;
  const hasEnterprise = skill.versions.some(v => v.scope === 'ENTERPRISE');

  return (
    <article className="ent-skill-card">
      {/* 大图标 */}
      <div className="ent-skill-icon">
        <BookOpen size={32} aria-hidden />
      </div>

      {/* 技能名称 */}
      <h3 className="ent-skill-name">{skill.capability.name}</h3>

      {/* 版本标签 */}
      <div className="ent-skill-badges">
        {hasEnterprise ? (
          <span className="ent-skill-badge enterprise">🏢 企业版</span>
        ) : null}
        {hasPersonal ? (
          <span className="ent-skill-badge personal">👤 个人版</span>
        ) : null}
      </div>

      {/* 操作按钮 */}
      <div className="ent-skill-actions">
        <button
          type="button"
          className="ent-btn sm primary"
          onClick={() => workspace.navigate({ name: 'skills', skillId: skill.capability.id })}
        >
          查看详情
        </button>
        {hasPersonal ? (
          <button
            type="button"
            className="ent-btn sm ghost"
            onClick={() => workspace.navigate({ name: 'skills', skillId: skill.capability.id })}
          >
            编辑
          </button>
        ) : null}
      </div>
    </article>
  );
}
