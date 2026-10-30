import { defaultPermissions } from '../features/enterprise/placeholder';
import { GENERAL_ASSISTANT_ID } from '../features/enterprise/general-assistant';
import type { SiliconEmployee, WorkItem } from '../features/enterprise/types';
import { createAvatar } from '@dicebear/core';
import * as toonHead from '@dicebear/toon-head';

export const homePreviewNow = new Date('2026-10-27T15:30:00+08:00').getTime();

const names = [
  ['爆品机会评估师', '爆品机会评估师', '机会评估'],
  ['抖音运营策略师', '抖音运营策略师', '抖音运营'],
  ['电商活动文案策划师', '电商活动文案策划师', '活动文案'],
  ['电商运营方案顾问', '电商运营方案顾问', '运营方案'],
  ['电商运营专家顾问', '电商运营专家顾问', '电商运营'],
  ['多平台电商协同经理', '多平台电商协同经理', '平台协同'],
  ['电商会员权益设计师', '电商会员权益设计师', '会员权益'],
  ['老餐馆介绍策划师', '老餐馆介绍策划师', '餐馆介绍'],
  ['电商社群运营师', '电商社群运营师', '社群运营'],
  ['复购增长顾问', '复购增长顾问', '复购增长'],
  ['优惠券策略师', '优惠券策略师', '优惠券策略'],
];

export const homePreviewEmployees: SiliconEmployee[] = names.map(([name, roleName, goodAt], index) => ({
  id: `preview-employee-${index + 1}`,
  name,
  avatar: createAvatar(toonHead, { seed: `home-preview-${index}` }).toDataUri(),
  avatarAsset: null,
  mark: name.slice(0, 1),
  roleName,
  department: '演示团队',
  availability: 'working',
  assignedToMe: true,
  intro: `${roleName}，用于首页视觉演示。`,
  goodAt: [goodAt],
  cannotDo: [],
  lastWorkedAt: index > 4 ? homePreviewNow - (index + 1) * 86400000 : null,
  allowedModels: ['preview-model'],
  skillIds: [],
  permissions: defaultPermissions(),
  templateVersion: 'preview',
}));

const workTitles = ['本月销售数据分析报告', '电商活动文案策划', 'RPA 自动化流程设计', '品牌图文素材生成', '短视频脚本生成'];
export const homePreviewWorks: WorkItem[] = workTitles.map((title, index) => ({
  id: `preview-work-${index + 1}`,
  title,
  goal: `${title}的演示任务`,
  kind: 'conversation',
  workType: { state: 'resolved', kind: 'conversation' },
  status: index === 0 ? 'running' : 'completed',
  isActive: index === 0,
  progress: index === 0 ? 62 : 100,
  currentEmployeeId: homePreviewEmployees[index].id,
  currentEmployeeName: homePreviewEmployees[index].name,
  steps: [],
  nextUserAction: null,
  createdAt: homePreviewNow - [2, 3, 5, 26, 27][index] * 3600000,
  startedAt: homePreviewNow - [2, 3, 5, 26, 27][index] * 3600000,
  completedAt: index === 0 ? null : homePreviewNow - [2, 3, 5, 26, 27][index] * 3600000,
  updatedAt: homePreviewNow - [2, 3, 5, 26, 27][index] * 3600000,
  participants: [homePreviewEmployees[index].id],
  deliverables: [],
  timeline: [],
  messages: [],
  activities: [],
  sharedContext: { goal: '', confirmedInputs: [], previousResults: [], userNotes: [] },
  stopReason: null,
  workDir: null,
} as WorkItem));

export const homePreviewStats = { total: 27, working: 0, idle: 10 };
export const homePreviewUserName = '刘凌';
export const homePreviewGeneralAssistantId = GENERAL_ASSISTANT_ID;
