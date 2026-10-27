import { useArrangementPlans } from './use-arrangement-plans';
import { useSkillLibrary, type SkillLibraryWorkspace } from './use-skill-library';
import { needsSkillLibrary } from './skill-load-state';
import { conversationDocument } from './run-settings';
import { generalAssistant, GENERAL_ASSISTANT_ID } from './general-assistant';
import { useOperationFeedback } from '../../components/feedback/use-operation-feedback';
import { UserFeedbackError, responseError } from '../../shared/arrangement-feedback';
/**
 * 把平台数据与本地状态聚合成业务域模型。
 *
 * 数据来源分三类：
 * 1. 真实 IPC —— 订阅目录、本地工作、工作事件。
 * 2. 本地设置 —— 本机操作权限、个人技能版本、当前活跃员工。
 * 3. 占位数据 —— 见 placeholder.ts，平台接口补齐后逐项替换。
 *
 * 页面组件只消费这里返回的对象，不直接调用 window.electronAPI。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArrangementDraftDocument, ClientTask, ClientTaskMessage, EmployeeAvatarSource, EmployeeStatus, Subscription } from '../../shared/types';
import {
  WORK_TEMPLATES,
  defaultPermissions,
} from './placeholder';
import type {
  AppRoute,
  EnterpriseOverview,
  OperationPermission,
  OperationPermissionId,
  SavedWorkFlow,
  SiliconEmployee,
  WorkActivity,
  WorkDraftStep,
  WorkItem,
  WorkTemplate,
} from './types';
import { upgradeDraftSteps, validateGraph } from './work-graph';
import { buildWorkItem, completedStepCount, getArrangementDisplayEvents } from './work-mapping';
import { applyRuntimeEvent, runtimeKey } from '../../shared/work-activity';
import type { EnterpriseOrganization } from '../../shared/platform-supplement-contracts';
import { mapEnterpriseOrganization, mapOrganizationEmployees } from './organization-mapping';
import type { OrganizationCarbonEmployee } from './organization-model';
import { TaskReadCache, mergeInitialTaskQuery, mergeTaskList, mergeTaskUpdate } from './task-read-cache';
import type { AttachmentRef, AttachmentView, DraftAttachmentCandidate } from '../../shared/attachment-contracts';

/**
 * 谁被一项正在跑的工作占着 —— 处在其中的员工不算「空闲」。
 *
 * 判定口径是「他名下有一项工作正在跑」，不是「他是当前负责人」：一项流程工作跑起来之后，
 * 参与其中的同事都在这项工作里，只认当前那一位会让其余人显示成空闲。
 *
 * 「等你拍板」和「中断了」不算：那些工作已经不在推进了，这位员工现在确实能接新活。
 * 这两件事由员工卡上状态旁边的小图标、顶栏铃铛和工作记录来说。
 */
function busyEmployeeIds(works: WorkItem[]): Set<string> {
  const busy = new Set<string>();
    works.filter(work => work.isActive === true).forEach(work => {
    busy.add(work.currentEmployeeId);
    work.participants.forEach(id => busy.add(id));
    work.steps.forEach(step => busy.add(step.employeeId));
  });
  return busy;
}

/** 「安排工作」页提交的内容。 */
export interface ArrangeWorkDraft {
  modelId?: string;
  permissions?: ArrangementDraftDocument['permissions'];
  title: string;
  goal: string;
  templateId?: string;
  workDir: string;
  steps: WorkDraftStep[];
  /** 用户已确认可以交给员工的资料说明。 */
  confirmedInputs: string[];
  /** 整个工作共享的技能。这一版只跟着工作一起记住，不下发给员工。 */
  sharedSkillIds: string[];
  attachmentSessionId?: string;
  attachmentCandidates?: DraftAttachmentCandidate[];
  mustUseAttachments?: boolean;
}

/** 从模板或已保存的常用工作带到安排工作页的初始内容。 */
export interface ArrangeSeed {
  goal: string;
  steps: WorkDraftStep[];
  /** 从已保存的常用工作带回时有值，用来预填工作名称。 */
  title?: string;
  confirmedInputs?: string[];
  sharedSkillIds?: string[];
}

/**
 * 开一段对话式工作时的可选设置。
 * workDir 会真的传给主进程；skillIds 这一版只记在界面上，
 * 技能还没有下发通道，所以页面必须写清它现在生效到哪一层。
 */
export interface ConversationOptions {
  modelId?: string;
  permissions?: ArrangementDraftDocument['permissions'];
  workDir?: string;
  skillIds?: string[];
  attachmentSessionId?: string;
  attachmentRefs?: AttachmentRef[];
}

/**
 * 常用工作存在浏览器本地，按企业隔离。
 * 平台还没有「个人流程模板」接口，先落本地；接口补齐后换成远端读写即可，
 * 页面消费的是 workspace.savedFlows，不需要跟着改。
 */
const savedFlowsKey = (enterpriseId: string) => `sep.savedFlows.${enterpriseId}`;

function readSavedFlows(enterpriseId: string): SavedWorkFlow[] {
  try {
    const raw = window.localStorage.getItem(savedFlowsKey(enterpriseId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is SavedWorkFlow =>
        Boolean(item) && typeof item === 'object'
        && typeof (item as SavedWorkFlow).id === 'string'
        && typeof (item as SavedWorkFlow).name === 'string'
        && Array.isArray((item as SavedWorkFlow).steps))
      // v1 存的是线性链，升级成依赖图并补上画布坐标，否则旧记录进画布会没有连线。
      .map(item => ({ ...item, version: 2 as const, steps: upgradeDraftSteps(item.steps) }));
  } catch {
    // 本地数据坏了不能拖垮首页，按「没有保存过」处理。
    return [];
  }
}

function departmentName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') return value.name;
  return null;
}

interface Options {
  userId: string;
  userName: string;
  enterpriseId: string;
  enterpriseName: string;
  instances: Subscription[];
  employeeStatuses: EmployeeStatus[];
}

/**
 * 「已查阅」记账，按企业隔离存在本机。
 *
 * 首页员工卡上那个「某项工作做完了，请查阅」的气泡要在用户看过之后消失，
 * 而平台没有「已读」这种字段，所以本机记下 workId → 当时的更新时间：
 * 记的是时间而不是布尔值，工作完成之后又有新进展时会再提醒一次。
 */
const reviewedKey = (enterpriseId: string) => `sep.reviewed.${enterpriseId}`;

function readReviewed(enterpriseId: string): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(reviewedKey(enterpriseId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
    }
    return out;
  } catch {
    // 本地数据坏了不能拖垮首页，按「什么都没看过」处理：最坏情况是多提醒一次。
    return {};
  }
}

export interface EnterpriseWorkspace extends SkillLibraryWorkspace {
  attachmentScopeKey: string;
  overview: EnterpriseOverview;
  /** 企业全部员工，含未分配给我的。 */
  employees: SiliconEmployee[];
  /** 我可以直接安排的员工。 */
  myEmployees: SiliconEmployee[];
  templates: WorkTemplate[];
  /** 用户自己保存的常用工作，和企业预设流程并排出现在首页。 */
  savedFlows: SavedWorkFlow[];
  works: WorkItem[];
  /**
   * 已经做完、但用户还没打开看过的工作。首页员工卡的提醒气泡按它显示。
   * 打开工作详情即视为查阅过，所以这里不需要额外的「标记已读」操作。
   */
  unreviewedWorkIds: ReadonlySet<string>;
  route: AppRoute;
  /** 是否有可返回的上一页，供顶栏决定是否显示返回按钮。 */
  canGoBack: boolean;
  error: string | null;
  busy: boolean;
  /** 当前登录用户名，页面问候语与「你」的表达都用它。 */
  userName: string;
  /** 带入安排工作页的初始内容，使用后由页面自行清空。 */
  arrangeSeed: ArrangeSeed | null;
  seedArrange: (seed: ArrangeSeed | null) => void;
  navigate: (route: AppRoute) => void;
  /** 更新当前路由的筛选条件，不创建返回历史。 */
  replaceRoute: (route: AppRoute) => void;
  retryWorkTypes: () => void;
  goBack: () => void;
  dismissError: () => void;
  startConversation: (employeeId: string, text: string, options?: ConversationOptions) => Promise<boolean>;
  arrangeWork: (draft: ArrangeWorkDraft) => Promise<boolean>;
  sendMessage: (workId: string, text: string, attachments?: AttachmentView[], attachmentSessionId?: string) => Promise<boolean>;
  switchEmployee: (workId: string, employeeId: string) => Promise<void>;
  confirmStep: (workId: string) => Promise<void>;
  stopWork: (workId: string, reason: string) => Promise<boolean>;
  retryWork: (workId: string, nodeId?: string) => Promise<void>;
  renameWork: (workId: string, title: string) => Promise<boolean>;
  setWorkPinned: (workId: string, pinned: boolean) => Promise<boolean>;
  deleteWork: (workId: string) => Promise<boolean>;
  /** 把当前安排好的工作存成常用工作，返回是否存成功。 */
  saveFlow: (flow: Omit<SavedWorkFlow, 'id' | 'savedAt'>) => boolean;
  deleteSavedFlow: (flowId: string) => void;
  /** 用已保存的常用工作重新安排一次：带着原步骤进安排工作页。 */
  runSavedFlow: (flowId: string) => void;
  setPermission: (employeeId: string, permissionId: OperationPermissionId, enabled: boolean) => void;
  setPermissionScope: (employeeId: string, permissionId: OperationPermissionId, scope: string) => void;
  chooseFolder: (currentPath?: string) => Promise<string | null>;
  organizationMembers: OrganizationCarbonEmployee[];
  organizationEmployees: SiliconEmployee[];
  organizationStatus: 'loading' | 'ready' | 'empty' | 'error';
  organizationError: string | null;
  /** Current human member's SEP avatar, if the organization endpoint provides it. */
  currentUserAvatar: EmployeeAvatarSource | null;
  /** Reloads the server-owned organization, including current logo/member avatars. */
  refreshOrganization: () => Promise<void>;
  retryOrganization: () => void;

}

const NOTICE_DURATION_MS = 5_000;

export function useEnterpriseWorkspace({ userId, userName, enterpriseId, enterpriseName, instances, employeeStatuses }: Options): EnterpriseWorkspace {
  const [tasks, setTasks] = useState<ClientTask[]>([]);
  const scopeKey = JSON.stringify([userId, enterpriseId]);
  const { capture: captureFeedback } = useOperationFeedback(scopeKey);
  const deletedRecords = useMemo(() => ({ scopeKey, ids: new Set<string>() }), [scopeKey]);
  const deletedTaskIds = deletedRecords.ids;
  const scopedTasks = useMemo(() => tasks.filter(task => task.ownerId === userId && task.ownerEnterpriseId === enterpriseId), [tasks, userId, enterpriseId]);
  const arrangement = useArrangementPlans(scopedTasks, scopeKey);
  const { recordEvent: recordArrangementEvent } = arrangement;
  const [route, setRoute] = useState<AppRoute>({ name: 'organization' });
  const [history, setHistory] = useState<AppRoute[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => setError(null), NOTICE_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [error]);
  const [busy, setBusy] = useState(false);
  const [organizationData, setOrganizationData] = useState<EnterpriseOrganization | null>(null);
  const [organizationMembers, setOrganizationMembers] = useState<OrganizationCarbonEmployee[]>([]);
  const [organizationStatus, setOrganizationStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const organizationRequestRef = useRef(0);
  const skillLibrary = useSkillLibrary(scopeKey, needsSkillLibrary(route));
  const { skills } = skillLibrary;
  const [permissionOverrides, setPermissionOverrides] = useState<Record<string, OperationPermission[]>>({});
  const [activeEmployeeByWork, setActiveEmployeeByWork] = useState<Record<string, string>>({});
  const [arrangeSeed, setArrangeSeed] = useState<ArrangeSeed | null>(null);
  const [savedFlows, setSavedFlows] = useState<SavedWorkFlow[]>(() => readSavedFlows(enterpriseId));
  const [reviewedAt, setReviewedAt] = useState<Record<string, number>>(() => readReviewed(enterpriseId));
  const streamingText = useRef(new Map<string, string>());
  const runtimeActivities = useRef(new Map<string, WorkActivity[]>());
  const latestRunByTask = useRef(new Map<string, string>());
  const messagesByTask = useRef(new Map<string, ClientTaskMessage[]>());
  const pendingMessages = useRef(new Map<string, ClientTaskMessage[]>());
  const taskTypeCache = useRef<TaskReadCache | null>(null);
  const refreshOrganization = useCallback(async (): Promise<void> => {
    const requestId = organizationRequestRef.current + 1;
    organizationRequestRef.current = requestId;
    setOrganizationError(null);
    setOrganizationStatus(enterpriseId ? 'loading' : 'empty');

    if (!enterpriseId) {
      setOrganizationData(null);
      setOrganizationMembers([]);
      return;
    }

    try {
      const result = await window.electronAPI.getEnterpriseOrganization();
      if (requestId !== organizationRequestRef.current) return;
      if (!result.success || !result.data) {
        setOrganizationStatus('error');
        setOrganizationError(result.error?.message ?? '组织架构加载失败');
        return;
      }

      const mapped = mapEnterpriseOrganization(result.data, userId);
      setOrganizationData(result.data);
      setOrganizationMembers(mapped);
      setOrganizationStatus(mapped.length > 0 ? 'ready' : 'empty');
    } catch (error: unknown) {
      if (requestId !== organizationRequestRef.current) return;
      setOrganizationStatus('error');
      setOrganizationError(error instanceof Error ? error.message : '组织架构加载失败');
    }
  }, [enterpriseId, userId]);

  useEffect(() => {
    void refreshOrganization();
  }, [refreshOrganization]);

  const clearRuntimeState = useCallback((taskId: string): void => {
    for (const key of [...streamingText.current.keys()]) {
      if (key.startsWith(`${taskId}:`)) streamingText.current.delete(key);
    }
    for (const key of [...runtimeActivities.current.keys()]) {
      if (key.startsWith(`${taskId}:`)) runtimeActivities.current.delete(key);
    }
    latestRunByTask.current.delete(taskId);
  }, []);

  // ── 员工 ─────────────────────────────────────────────────────────────
  const myEmployees = useMemo<SiliconEmployee[]>(() => instances.map(instance => {
    const roleName = instance.template.name || '硅基员工';
    const platformStatus = employeeStatuses.find(item => item.employeeId === instance.employeeId)?.status;
    const permissions = permissionOverrides[instance.subscriptionId] ?? defaultPermissions();
    const availability = instance.status !== 'ACTIVE' ? 'unavailable' : platformStatus === 'WORKING' ? 'working' : permissions.some(item => item.enabled) ? 'ready' : 'needs-auth';
    return {
      id: instance.subscriptionId,
      name: instance.name,
      avatar: instance.template.avatar,
      avatarAsset: instance.template.avatarAsset ?? null,
      mark: instance.name.slice(0, 1),
      roleName,
      department: departmentName(instance.department),
      availability,
      assignedToMe: true,
      intro: instance.description || '',
      goodAt: [],
      cannotDo: [],
      lastWorkedAt: null,
      allowedModels: Array.isArray(instance.allowedModels) ? instance.allowedModels : [],
      skillIds: [],
      permissions,
      templateVersion: instance.templateVersion,
    };
  }), [instances, permissionOverrides, employeeStatuses]);

  // ── 工作 ─────────────────────────────────────────────────────────────
  const works = useMemo<WorkItem[]>(() => {
    const items = scopedTasks.map(task => {
      const history = messagesByTask.current.get(task.id);
      const pending = pendingMessages.current.get(task.id) ?? [];
      return buildWorkItem({
        task,
        employees: myEmployees,
        messages: pending.length ? [
          ...(history?.length ? history : [{ id: `${task.id}-goal`, role: 'user' as const,
            content: task.prompt, createdAt: task.createdAt, runId: '' }]),
          ...pending,
        ] : history,
        streamingText: streamingText.current.get(runtimeKey(task.id, task.activeRunId ?? latestRunByTask.current.get(task.id) ?? '')),
        streamingRunId: task.activeRunId ?? latestRunByTask.current.get(task.id),
        activities: runtimeActivities.current.get(runtimeKey(task.id, task.activeRunId ?? latestRunByTask.current.get(task.id) ?? '')) ?? [],
        activeEmployeeId: activeEmployeeByWork[task.id],
        plan: arrangement.plans[task.id],
        arrangementEvents: getArrangementDisplayEvents(arrangement.events, task.id, task.activeRunId ?? latestRunByTask.current.get(task.id) ?? ''),
        arrangementExecution: arrangement.executions[task.id],
      });
    });
    return items.sort((left, right) => right.updatedAt - left.updatedAt);
  }, [scopedTasks, myEmployees, activeEmployeeByWork, arrangement.plans, arrangement.events, arrangement.executions]);

  /** 员工是否正在处理工作，用于卡片状态。 */
  const employees = useMemo<SiliconEmployee[]>(() => {
    const busyIds = busyEmployeeIds(works);
    const lastWorked = new Map<string, number>();
    works.forEach(work => {
      work.participants.forEach(id => {
        lastWorked.set(id, Math.max(lastWorked.get(id) ?? 0, work.updatedAt));
      });
    });
    const mine = myEmployees.map(employee => ({
      ...employee,
      availability: busyIds.has(employee.id) && employee.availability === 'ready' ? 'working' as const : employee.availability,
      lastWorkedAt: lastWorked.get(employee.id) ?? null,
      skillIds: skills.filter(skill => skill.bindings.some(binding => binding.subscriptionId === employee.id)).map(skill => skill.capability.id),
    }));
    return mine;
  }, [myEmployees, works, skills]);

  const organizationEmployees = useMemo(() => organizationData
    ? mapOrganizationEmployees(organizationData, employees) : [], [organizationData, employees]);

  const currentUserAvatar = useMemo(() => {
    const member = organizationData?.members.find(item => item.userId === userId);
    return member ? { name: member.name, avatar: member.avatar, avatarAsset: member.avatarAsset ?? null } : null;
  }, [organizationData, userId]);

  const overview = useMemo<EnterpriseOverview>(() => ({
    id: enterpriseId,
    name: organizationData?.enterprise.name ?? enterpriseName,
    logo: organizationData?.enterprise.logo ?? null,
    mark: (organizationData?.enterprise.name ?? enterpriseName).slice(0, 1) || '企',
    // TODO 平台接口未开放：企业员工总数。至少不小于我可用的数量。
    totalEmployees: myEmployees.length,
    availableToMe: myEmployees.length,
    activeWorkCount: works.filter(work => work.isActive === true).length,
    needsMeCount: works.filter(work => work.status === 'waiting-user' || work.status === 'failed').length,
  }), [enterpriseId, enterpriseName, organizationData, myEmployees.length, works]);

  /** 模板的默认参与员工按职能匹配到我可用的员工上。 */
  const templates = useMemo<WorkTemplate[]>(() => WORK_TEMPLATES.map(template => ({
    ...template,
    employeeIds: template.steps.map((_, index) => myEmployees[index % Math.max(1, myEmployees.length)]?.id ?? '').filter(Boolean),
  })), [myEmployees]);

  // ── 已查阅 ────────────────────────────────────────────────────────────
  /**
   * 打开一项工作就算查阅过它。只有这一个记账点 ——
   * 记在导航这一层而不是各个入口上，从首页气泡、工作记录还是弹窗进来都算。
   */
  useEffect(() => {
    if (route.name !== 'work') return;
    const work = works.find(item => item.id === route.workId);
    if (!work) return;
    setReviewedAt(current => {
      if ((current[work.id] ?? 0) >= work.updatedAt) return current;
      // 顺手丢掉已经不存在的工作，否则这条记录会随删掉的工作一直堆下去。
      const next: Record<string, number> = { [work.id]: work.updatedAt };
      for (const item of works) {
        if (item.id !== work.id && current[item.id] !== undefined) next[item.id] = current[item.id]!;
      }
      try {
        window.localStorage.setItem(reviewedKey(enterpriseId), JSON.stringify(next));
      } catch {
        // 写不进去（无痕模式、配额满）只影响下次打开时会不会再提醒一次，不阻断本次使用。
      }
      return next;
    });
  }, [route, works, enterpriseId]);

  const unreviewedWorkIds = useMemo(
    () => new Set(works
      .filter(work => work.status === 'completed' && (reviewedAt[work.id] ?? 0) < work.updatedAt)
      .map(work => work.id)),
    [works, reviewedAt],
  );

  // ── 订阅本地工作与执行事件 ──────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    const api = window.electronAPI;
    const belongsToScope = (task: ClientTask) => task.ownerId === userId && task.ownerEnterpriseId === enterpriseId
      && !deletedTaskIds.has(task.id);
    setTasks([]);
    streamingText.current.clear();
    runtimeActivities.current.clear();
    latestRunByTask.current.clear();
    messagesByTask.current.clear();
    pendingMessages.current.clear();

    const messageVersions = new Map<string, number>();
    const observedRuns = new Map<string, string | null>();
    let receivedTaskList = false;
    const pushedTaskIds = new Set<string>();
    const typeCache = new TaskReadCache(async task => {
      const result = await api.getTask(task.id);
      return result.success && result.task?.workType ? result.task.workType : { state: 'unavailable' };
    }, (taskId, workType) => {
      if (!active) return;
      setTasks(current => current.map(task => task.id === taskId ? { ...task, workType } : task));
    });
    taskTypeCache.current = typeCache;
    const loadMessages = async (list: ClientTask[]) => {
      await Promise.all(list.map(async task => {
        const version = (messageVersions.get(task.id) ?? 0) + 1;
        messageVersions.set(task.id, version);
        const runId = task.activeRunId ?? latestRunByTask.current.get(task.id);
        const settled = task.activeRunId === null;
        try {
          const result = await api.getTaskMessages(task.id);
          if (!active || deletedTaskIds.has(task.id) || messageVersions.get(task.id) !== version || !result.success || !result.messages) return;
          const messages = result.messages;
          // Early admission snapshots may not contain the new run yet. Only a new
          // persisted user message can acknowledge one optimistic send (not old identical text).
          const matchedIds = new Set((messagesByTask.current.get(task.id) ?? []).map(message => message.id));
          pendingMessages.current.set(task.id, (pendingMessages.current.get(task.id) ?? []).filter(pending => {
            const match = messages.find(message => message.role === 'user'
              && !matchedIds.has(message.id) && message.createdAt >= pending.createdAt
              && message.content === pending.content);
            if (!match) return true;
            matchedIds.add(match.id);
            return false;
          }));
          messagesByTask.current.set(task.id, messages);
          if (settled && runId) streamingText.current.delete(runtimeKey(task.id, runId));
        } catch {
          // Keep the live response until persisted messages can be read successfully.
        }
      }));
      if (active) setTasks(current => [...current]);
    };
    const refreshMessages = (task: ClientTask) => {
      const previousRun = observedRuns.get(task.id);
      observedRuns.set(task.id, task.activeRunId);
      if (previousRun !== task.activeRunId) void loadMessages([task]);
    };

    void api.getAllTasks().then(result => {
      if (!active || !result.success) return;
      const list = (result.tasks ?? []).filter(belongsToScope);
      setTasks(current => {
        const next = mergeInitialTaskQuery(current, list, pushedTaskIds, receivedTaskList, deletedTaskIds);
        typeCache.retain(next);
        next.forEach(typeCache.ensure.bind(typeCache));
        return next.map(task => typeCache.preserve(task));
      });
      list.forEach(refreshMessages);
    }).catch(() => {
      if (active && !receivedTaskList && pushedTaskIds.size === 0) setTasks([]);
    });

    const unsubscribeList = api.onTaskListUpdated(incoming => {
      if (!active) return;
      const list = incoming.filter(belongsToScope);
      receivedTaskList = true;
      setTasks(current => {
        const next = mergeTaskList(current, list, deletedTaskIds);
        typeCache.retain(next);
        list.forEach(typeCache.ensure.bind(typeCache));
        return next.map(task => typeCache.preserve(task));
      });
      list.forEach(refreshMessages);
    });
    const unsubscribeTask = api.onTaskUpdated(task => {
      if (!active || !belongsToScope(task)) return;
      pushedTaskIds.add(task.id);
      refreshMessages(task);
      setTasks(current => {
        const next = mergeTaskUpdate(current, task, deletedTaskIds);
        typeCache.retain(next);
        typeCache.ensure(task);
        return next.map(item => typeCache.preserve(item));
      });
    });
    const unsubscribePi = api.onPiEvent(event => {
      if (!active || deletedTaskIds.has(event.taskId)) return;
      recordArrangementEvent(event);
      latestRunByTask.current.set(event.taskId, event.runId);
      const key = runtimeKey(event.taskId, event.runId);
      if (event.type === 'text_delta') {
        const data = event.data as { text?: unknown };
        if (typeof data.text === 'string') {
          streamingText.current.set(key, `${streamingText.current.get(key) ?? ''}${data.text}`);
        }
      }
      const previous = runtimeActivities.current.get(key) ?? [];
      const next = applyRuntimeEvent(previous, event);
      if (next !== previous) runtimeActivities.current.set(key, next);
      // agent_end can precede SDK retries; only retire live text after reading settled messages.
      setTasks(current => [...current]);
    });

    return () => {
      active = false;
      unsubscribeList();
      unsubscribeTask();
      unsubscribePi();
      typeCache.dispose();
      if (taskTypeCache.current === typeCache) taskTypeCache.current = null;
    };
  }, [recordArrangementEvent, scopeKey, userId, enterpriseId, deletedTaskIds]);

  const retryWorkTypes = useCallback(() => {
    const cache = taskTypeCache.current;
    if (!cache) return;
    setTasks(current => current.map(task => {
      if (task.workType?.state !== 'unavailable') return task;
      cache.retry(task);
      return { ...task, workType: undefined };
    }));
  }, []);

  // ── 导航 ─────────────────────────────────────────────────────────────
  const navigate = useCallback((next: AppRoute) => {
    setRoute(current => {
      setHistory(stack => [...stack.slice(-19), current]);
      return next;
    });
    setError(null);
  }, []);

  const goBack = useCallback(() => {
    setHistory(stack => {
      if (!stack.length) return stack;
      setRoute(stack[stack.length - 1]);
      return stack.slice(0, -1);
    });
  }, []);

  const replaceRoute = useCallback((next: AppRoute) => {
    setRoute(next);
    setError(null);
  }, []);

  // ── 工作动作 ──────────────────────────────────────────────────────────
  const run = useCallback(async (action: () => Promise<{ success: boolean; error?: { message: string } }>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.success) setError(result.error?.message || fallback);
      return result.success;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const startConversation = useCallback(async (employeeId: string, text: string, options?: ConversationOptions) => {
    const notice = captureFeedback();
    const goal = text.trim();
    if (!goal) return false;
    const employee = employeeId === GENERAL_ASSISTANT_ID
      ? generalAssistant(myEmployees.filter(item => item.availability !== 'unavailable'))
      : myEmployees.find(item => item.id === employeeId);
    if (!employee) { notice.show('请选择需要使用的员工', 'warning'); return false; }
    const api = window.electronAPI;
    const title = goal.length > 40 ? `${goal.slice(0, 40)}…` : goal;
    setBusy(true);
    setError(null);
    try {
      const modelId = options?.modelId || employee.allowedModels[0];
      if (!modelId || !employee.allowedModels.includes(modelId)) throw new UserFeedbackError(employeeId === GENERAL_ASSISTANT_ID ? '通用助手没有可用的模型授权，请联系平台管理员' : '所选员工不支持当前模型，请重新选择');
      const document = { ...conversationDocument(title, goal, employeeId, modelId, options), ...(options?.attachmentRefs?.length ? { attachmentCandidates: options.attachmentRefs.map(attachment => ({ attachment, mustUse: true })), attachmentSessionId: options.attachmentSessionId } : {}) };
      const created = await api.createArrangementDraft(document);
      if (!notice.isCurrent()) return false;
      if (!created.success || !created.draft) throw responseError(created, 'create');
      let draft = created.draft;
      if (draft.attachmentCandidates?.length && draft.attachmentSessionId) {
        const updated = await api.updateArrangementInputs({ draftId: draft.id, expectedRevision: draft.revision, inputs: { attachmentSessionId: draft.attachmentSessionId, attachmentCandidates: draft.attachmentCandidates } });
        if (!notice.isCurrent()) return false;
        if (!updated.success || !updated.draft) throw responseError(updated, 'attachments');
        draft = updated.draft;
      }
      const input = { draftId: draft.id, expectedRevision: draft.revision };
      const preflight = await api.preflightArrangementDraft(input);
      if (!notice.isCurrent()) return false;
      if (!preflight.success || !preflight.preflight?.canStart) {
        throw responseError({ error: preflight.error ?? (preflight.preflight?.message ? { message: preflight.preflight.message } : undefined) }, 'preflight');
      }
      const started = await api.confirmAndStartArrangement({ ...input, idempotencyKey: crypto.randomUUID() });
      if (!notice.isCurrent()) return false;
      if (!started.success || !started.execution) throw responseError(started, 'start');
      setActiveEmployeeByWork(current => ({ ...current, [started.execution!.id]: employeeId }));
      navigate({ name: 'work', workId: started.execution.id });
      return true;
    } catch (cause) {
      notice.fail(cause, 'create');
      return false;
    } finally {
      if (notice.isCurrent()) setBusy(false);
    }
  }, [myEmployees, navigate, captureFeedback]);

  const arrangeWork = useCallback(async (draft: ArrangeWorkDraft): Promise<boolean> => {
    const notice = captureFeedback();
    const steps = draft.steps;
    const problem = validateGraph(steps);
    if (!steps.length || problem) { notice.show(problem || '请先添加工作步骤', 'warning'); return false; }
    const kept = new Set(steps.map(step => step.id));
    const nodes = steps.map(step => {
      const employee = myEmployees.find(item => item.id === step.employeeId);
      return {
        id: step.id,
        subscriptionId: step.employeeId,
        modelId: draft.modelId || employee?.allowedModels[0] || '',
        title: step.title,
        instruction: [step.title, step.input && `输入：${step.input}`].filter(Boolean).join('\n'),
        expectedOutput: step.output || step.title,
        dependsOn: step.dependsOn.filter(dep => kept.has(dep)),
        skillIds: [...step.skillIds],
        inputRefs: step.inputRefs ?? [],
      };
    });
    if (nodes.some(node => !node.modelId)) { notice.show('请选择需要使用的模型', 'warning'); return false; }
    const document: ArrangementDraftDocument = {
      schemaVersion: 1,
      mode: 'manual',
      title: draft.title.trim() || draft.goal.trim().slice(0, 40),
      goal: draft.goal.trim() || draft.title.trim(),
      confirmedInputs: draft.confirmedInputs.filter(Boolean),
      sharedSkillIds: draft.sharedSkillIds.filter(Boolean),
      conversation: null,
      nodes,
      attachmentCandidates: draft.attachmentCandidates,
      attachmentSessionId: draft.attachmentSessionId,
      workspace: { mode: 'shared', path: draft.workDir?.trim() || null },
      permissions: { ...(draft.permissions ?? { preset: 'read-only', approvalMode: 'confirm-each' }) },
      lastPlanning: null,
    };
    const api = window.electronAPI;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createArrangementDraft(document);
      if (!notice.isCurrent()) return false;
      if (!created.success || !created.draft) throw responseError(created, 'create');
      let createdDraft = created.draft;
      if (draft.attachmentSessionId && draft.attachmentCandidates?.length) {
        const updated = await api.updateArrangementInputs({ draftId: createdDraft.id, expectedRevision: createdDraft.revision, inputs: { attachmentSessionId: draft.attachmentSessionId, attachmentCandidates: draft.attachmentCandidates, nodes: nodes.map(node => ({ nodeId: node.id, inputRefs: node.inputRefs ?? [] })) } });
        if (!notice.isCurrent()) return false;
        if (!updated.success || !updated.draft) throw responseError(updated, 'attachments');
        createdDraft = updated.draft;
      }
      const preflight = await api.preflightArrangementDraft({ draftId: createdDraft.id, expectedRevision: createdDraft.revision });
      if (!notice.isCurrent()) return false;
      if (!preflight.success || !preflight.preflight?.canStart) throw responseError({ error: preflight.error ?? (preflight.preflight?.message ? { message: preflight.preflight.message } : undefined) }, 'preflight');
      const started = await api.confirmAndStartArrangement({ draftId: createdDraft.id, expectedRevision: createdDraft.revision, idempotencyKey: crypto.randomUUID() });
      if (!notice.isCurrent()) return false;
      if (!started.success || !started.execution) throw responseError(started, 'start');
      navigate({ name: 'work', workId: started.execution.id });
      return true;
    } catch (cause) {
      notice.fail(cause, 'start');
      return false;
    } finally {
      if (notice.isCurrent()) setBusy(false);
    }
  }, [myEmployees, navigate, captureFeedback]);

  const sendMessage = useCallback(async (workId: string, text: string, attachments: AttachmentView[] = [], attachmentSessionId?: string): Promise<boolean> => {
    const prompt = text.trim();
    if (!prompt || attachments.length && !attachmentSessionId) return false;
    setError(null);
    const message: ClientTaskMessage = {
      id: `pending-${crypto.randomUUID()}`, role: 'user', content: prompt, createdAt: Date.now(), runId: '',
    };
    pendingMessages.current.set(workId, [...(pendingMessages.current.get(workId) ?? []), message]);
    setTasks(current => [...current]);
    const ok = await run(() => window.electronAPI.continueTask({ taskId: workId, prompt, ...(attachments.length ? { attachmentSessionId, attachmentRefs: attachments.map(item => ({ attachmentId: item.attachmentId, sha256: item.sha256 })) } : {}) }), '消息没能发送，请重试');
    if (ok) return true;
      pendingMessages.current.set(workId, (pendingMessages.current.get(workId) ?? []).filter(item => item.id !== message.id));
      setTasks(current => [...current]);
    return false;
  }, [run]);

  const switchEmployee = useCallback(async (workId: string, employeeId: string) => {
    if (!myEmployees.some(item => item.id === employeeId)) { setError('这位员工当前不可用'); return; }
    setActiveEmployeeByWork(current => ({ ...current, [workId]: employeeId }));
    await run(() => window.electronAPI.switchConversationEmployee({ taskId: workId, subscriptionId: employeeId }), '切换员工失败，已保留原来的员工');
  }, [myEmployees, run]);

  const confirmStep = useCallback(async (workId: string) => {
    const work = works.find(item => item.id === workId);
    const execution = work?.arrangementExecution ?? arrangement.executions[workId];
    const nodeIds = execution?.nodes.filter(node => node.pendingConfirmation).map(node => node.nodeId) ?? [];
    if (nodeIds.length) await run(() => window.electronAPI.confirmArrangementNodes({ taskId: workId, nodeIds }), '确认没能提交，请重试');
    else if (work?.workType.state === 'resolved' && work.workType.kind === 'conversation') await run(() => window.electronAPI.continueTask({ taskId: workId, prompt: '我已确认当前结果，请继续下一步。' }), '确认没能提交，请重试');
  }, [arrangement.executions, run, works]);

  const stopWork = useCallback(async (workId: string, reason: string) => {
    const ok = await run(() => window.electronAPI.cancelTask(workId, reason), '终止失败，请重试');
    return ok;
  }, [run]);

  const retryWork = useCallback(async (workId: string, nodeId?: string) => {
    await run(() => window.electronAPI.retryTask(nodeId ? { taskId: workId, nodeId } : workId), '重试失败，请稍后再试');
  }, [run]);

  const updateWorkDetails = useCallback(async (workId: string, patch: { title?: string; pinned?: boolean }): Promise<boolean> => {
    const cache = taskTypeCache.current;
    const ok = await run(async () => {
      const result = await window.electronAPI.updateTaskDetails({ taskId: workId, ...patch });
      if (taskTypeCache.current === cache && result.success && result.task) {
        const updated = result.task;
        setTasks(current => current.map(task => task.id === workId ? {
          ...task,
          ...(patch.title !== undefined ? { title: updated.title } : {}),
          ...(patch.pinned !== undefined ? { pinnedAt: updated.pinnedAt ?? null } : {}),
        } : task));
      }
      return result;
    }, '修改工作记录失败，请重试');
    return ok && taskTypeCache.current === cache;
  }, [run]);

  const renameWork = useCallback((workId: string, title: string) => updateWorkDetails(workId, { title }), [updateWorkDetails]);
  const setWorkPinned = useCallback((workId: string, pinned: boolean) => updateWorkDetails(workId, { pinned }), [updateWorkDetails]);

  const deleteWork = useCallback(async (workId: string): Promise<boolean> => {
    const cache = taskTypeCache.current;
    const ok = await run(() => window.electronAPI.deleteTask(workId), '删除失败，请重试');
    if (ok && taskTypeCache.current === cache) {
      // Only successful deletions suppress snapshots already in flight before the IPC reply.
      deletedTaskIds.add(workId);
      messagesByTask.current.delete(workId);
      pendingMessages.current.delete(workId);
      clearRuntimeState(workId);
      setTasks(current => {
        const next = current.filter(task => task.id !== workId);
        cache?.retain(next);
        return next;
      });
      setRoute(current => (current.name === 'work' && current.workId === workId ? { name: 'records' } : current));
    }
    return ok && taskTypeCache.current === cache;
  }, [clearRuntimeState, deletedTaskIds, run]);

  // ── 常用工作 ──────────────────────────────────────────────────────────
  /** 写盘失败（无痕模式、配额满）不阻断界面：内存里仍然保留，只是下次打开会丢。 */
  const persistFlows = useCallback((next: SavedWorkFlow[]) => {
    setSavedFlows(next);
    try {
      window.localStorage.setItem(savedFlowsKey(enterpriseId), JSON.stringify(next));
      return true;
    } catch {
      captureFeedback().show('常用工作未能保存到本机，请联系平台管理员');
      return false;
    }
  }, [enterpriseId, captureFeedback]);

  const saveFlow = useCallback((flow: Omit<SavedWorkFlow, 'id' | 'savedAt'>) => {
    const name = flow.name.trim();
    if (!name) { captureFeedback().show('请先给这个常用工作起个名字', 'warning'); return false; }
    if (!flow.steps.length) { captureFeedback().show('至少要有一个工作步骤才能保存', 'warning'); return false; }
    const entry: SavedWorkFlow = {
      ...flow,
      name,
      id: `flow-${Date.now().toString(36)}`,
      savedAt: Date.now(),
    };
    // 同名视为覆盖，避免列表里堆出一串「客户周报」。
    const saved = persistFlows([entry, ...savedFlows.filter(item => item.name !== name)]);
    if (saved) captureFeedback().show('常用工作保存成功', 'success');
    return saved;
  }, [savedFlows, persistFlows, captureFeedback]);

  const deleteSavedFlow = useCallback((flowId: string) => {
    persistFlows(savedFlows.filter(item => item.id !== flowId));
  }, [savedFlows, persistFlows]);

  const runSavedFlow = useCallback((flowId: string) => {
    const flow = savedFlows.find(item => item.id === flowId);
    if (!flow) return;
    // 保存时的员工可能已经不归我用了，进页面前先剔掉，让用户重新指派。
    const available = new Set(myEmployees.map(employee => employee.id));
    setArrangeSeed({
      title: flow.name,
      goal: flow.goal,
      confirmedInputs: flow.confirmedInputs,
      sharedSkillIds: flow.sharedSkillIds,
      steps: flow.steps.map(step => ({ ...step, employeeId: available.has(step.employeeId) ? step.employeeId : '' })),
    });
    navigate({ name: 'arrange', mode: 'manual' });
  }, [savedFlows, myEmployees, navigate]);

  const chooseFolder = useCallback(async (currentPath?: string) => {
    const notice = captureFeedback();
    try {
      const result = await window.electronAPI.selectDirectory(currentPath);
      if (!notice.isCurrent()) return null;
      if (result.error) throw responseError(result, 'directory');
      return result.success ? result.path ?? null : null;
    } catch (error) {
      notice.fail(error, 'directory');
      return null;
    }
  }, [captureFeedback]);

  // ── 本机操作权限 ───────────────────────────────────────────────────────
  const patchPermission = useCallback((employeeId: string, permissionId: OperationPermissionId, patch: Partial<OperationPermission>) => {
    setPermissionOverrides(current => {
      const base = current[employeeId] ?? defaultPermissions();
      return { ...current, [employeeId]: base.map(item => (item.id === permissionId ? { ...item, ...patch } : item)) };
    });
  }, []);

  const setPermission = useCallback((employeeId: string, permissionId: OperationPermissionId, enabled: boolean) => {
    patchPermission(employeeId, permissionId, { enabled });
  }, [patchPermission]);

  const setPermissionScope = useCallback((employeeId: string, permissionId: OperationPermissionId, scope: string) => {
    patchPermission(employeeId, permissionId, { scope, enabled: true });
  }, [patchPermission]);

  // ── 个人技能版本 ───────────────────────────────────────────────────────
  /**
   * 每次改动都顺手落盘。写操作放在 updater 里是为了拿到「改完之后」的完整数组：
   * StrictMode 下 updater 会跑两次，但写入内容完全相同，所以是幂等的。
   */
  return {
    ...skillLibrary,
    attachmentScopeKey: scopeKey,
    overview, employees, myEmployees, templates, savedFlows, works, unreviewedWorkIds, route, error, busy,
    canGoBack: history.length > 0,
    arrangeSeed, seedArrange: setArrangeSeed, userName,
    navigate, replaceRoute, retryWorkTypes, goBack, dismissError: () => setError(null),
    startConversation, arrangeWork, sendMessage, switchEmployee, confirmStep,
    stopWork, retryWork, renameWork, setWorkPinned, deleteWork,
    saveFlow, deleteSavedFlow, runSavedFlow,
    setPermission, setPermissionScope, chooseFolder,
    organizationMembers, organizationEmployees, organizationStatus, organizationError, currentUserAvatar,
    refreshOrganization,
    retryOrganization: () => { void refreshOrganization(); },
  };
}

/** 「已完成 N 个步骤」的统一算法，供页面直接使用。 */
export { completedStepCount };
