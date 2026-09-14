import type { RunSettings } from './run-settings';
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
import type { ArrangementPlanSnapshot, ClientTask, ClientTaskMessage, Subscription } from '../../shared/types';
import {
  ENTERPRISE_TOTAL_EMPLOYEES,
  ARRANGEMENT_TEMPLATES,
  defaultPermissions,
  initialSkills,
  profileForRole,
  unassignedEmployees,
} from './placeholder';
import type {
  AppRoute,
  EmployeeSkill,
  EnterpriseOverview,
  MySkillVersion,
  OperationPermission,
  OperationPermissionId,
  SavedArrangement,
  SiliconEmployee,
  WorkActivity,
  WorkDraftStep,
  WorkItem,
  ArrangementTemplate,
} from './types';
import { upgradeDraftSteps, layoutSteps } from './work-graph';
import { buildWorkItem, completedStepCount } from './work-mapping';
import { applyRuntimeEvent, runtimeKey } from '../../shared/work-activity';

/**
 * 谁被一项正在跑的工作占着 —— 处在其中的员工不算「空闲」。
 *
 * 判定口径是「他名下有一项工作正在跑」，不是「他是当前负责人」：一项编排工作跑起来之后，
 * 参与其中的同事都在这项工作里，只认当前那一位会让其余人显示成空闲。
 *
 * 「等你拍板」和「中断了」不算：那些工作已经不在推进了，这位员工现在确实能接新活。
 * 这两件事由员工卡上状态旁边的小图标、顶栏铃铛和工作记录来说。
 */
function busyEmployeeIds(works: WorkItem[]): Set<string> {
  const busy = new Set<string>();
  works.filter(work => work.status === 'running').forEach(work => {
    busy.add(work.currentEmployeeId);
    work.participants.forEach(id => busy.add(id));
    work.steps.forEach(step => busy.add(step.employeeId));
  });
  return busy;
}

/** 「安排工作」页提交的内容。 */
export interface ArrangeWorkDraft {
  title: string;
  goal: string;
  workDir: string;
  steps: WorkDraftStep[];
  /** 用户已确认可以交给员工的资料说明。 */
  confirmedInputs: string[];
  /** 整个工作共享的技能包。这一版只跟着工作一起记住，不下发给员工。 */
  sharedSkillIds: string[];
  arrangementMode?: 'auto' | 'manual';
  execution?: Omit<RunSettings, 'workDir'>;
}

/** 从模板、已保存的常用工作或「复制为新工作」带到安排工作页的初始内容。 */
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
 * 技能包还没有下发通道，所以页面必须写清它现在生效到哪一层。
 */
export interface ConversationOptions {
  workDir?: string;
  model?: string;
  permissionPreset?: 'read-only' | 'workspace-edit' | 'full-local';
  allowWithoutApproval?: boolean;
  skillIds?: string[];
}

/**
 * 常用工作存在浏览器本地，按企业隔离。
 * 这类安排暂时没有独立远端接口，因此按企业隔离保存在本地。
 */
const savedArrangementsKey = (enterpriseId: string) => `sep.savedArrangements.${enterpriseId}`;

function readSavedArrangements(enterpriseId: string): SavedArrangement[] {
  try {
    const raw = window.localStorage.getItem(savedArrangementsKey(enterpriseId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is SavedArrangement =>
        Boolean(item) && typeof item === 'object'
        && typeof (item as SavedArrangement).id === 'string'
        && typeof (item as SavedArrangement).name === 'string'
        && Array.isArray((item as SavedArrangement).steps))
      // v1 存的是线性链，升级成依赖图并补上画布坐标，否则旧记录进画布会没有连线。
      .map(item => ({ ...item, version: 2 as const, steps: upgradeDraftSteps(item.steps) }));
  } catch {
    // 本地数据坏了不能拖垮首页，按「没有保存过」处理。
    return [];
  }
}

interface Options {
  userName: string;
  enterpriseId: string;
  enterpriseName: string;
  instances: Subscription[];
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

/**
 * 个人技能版本也存在浏览器本地，按企业隔离。
 *
 * 只存「用户自己改的那一层」（我的版本状态 + 每个字段的我的值），
 * 企业标准每次都从企业侧重新读 —— 否则企业改了标准，本地旧值会把它盖住，
 * 用户会以为自己在看最新的企业版本。
 *
 * 平台没有个人技能写接口，所以这一层只到本地为止；界面上必须写清这一点。
 */
interface MySkillEdit {
  my: MySkillVersion;
  /** fieldId → 我的值。 */
  values: Record<string, string>;
}

const mySkillsKey = (enterpriseId: string) => `sep.mySkills.${enterpriseId}`;

function readMySkillEdits(enterpriseId: string): Record<string, MySkillEdit> {
  try {
    const raw = window.localStorage.getItem(mySkillsKey(enterpriseId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, MySkillEdit> = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const { my, values } = entry as Partial<MySkillEdit>;
      if (!my || typeof my !== 'object' || typeof my.state !== 'string') continue;
      out[id] = { my, values: values && typeof values === 'object' ? values : {} };
    }
    return out;
  } catch {
    // 本地数据坏了不能拖垮技能页，按「没有个人版本」处理。
    return {};
  }
}

function writeMySkillEdits(enterpriseId: string, skills: EmployeeSkill[]): void {
  try {
    const out: Record<string, MySkillEdit> = {};
    for (const skill of skills) {
      if (skill.my.state === 'none') continue;
      out[skill.id] = {
        my: skill.my,
        values: Object.fromEntries(skill.fields.map(field => [field.id, field.myValue])),
      };
    }
    window.localStorage.setItem(mySkillsKey(enterpriseId), JSON.stringify(out));
  } catch {
    // 写不进去（隐私模式、配额满）不该让用户的这一次操作失败，界面上已经说明只存本机。
  }
}

/** 把本地存的个人修改叠回企业标准上。企业标准里已经没有的字段直接丢掉。 */
function applyMySkillEdits(skills: EmployeeSkill[], edits: Record<string, MySkillEdit>): EmployeeSkill[] {
  return skills.map(skill => {
    const edit = edits[skill.id];
    if (!edit) return skill;
    return {
      ...skill,
      my: edit.my,
      fields: skill.fields.map(field => {
        const mine = edit.values[field.id];
        return typeof mine === 'string' ? { ...field, myValue: mine } : field;
      }),
    };
  });
}

export interface EnterpriseWorkspace {
  overview: EnterpriseOverview;
  /** 企业全部员工，含未分配给我的。 */
  employees: SiliconEmployee[];
  /** 我可以直接安排的员工。 */
  myEmployees: SiliconEmployee[];
  templates: ArrangementTemplate[];
  /** 用户自己保存的常用安排。 */
  savedArrangements: SavedArrangement[];
  skills: EmployeeSkill[];
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
  goBack: () => void;
  dismissError: () => void;
  startConversation: (employeeId: string, text: string, options?: ConversationOptions) => Promise<void>;
  arrangeWork: (draft: ArrangeWorkDraft) => Promise<void>;
  sendMessage: (workId: string, text: string) => void;
  switchEmployee: (workId: string, employeeId: string) => Promise<void>;
  confirmStep: (workId: string) => Promise<void>;
  stopWork: (workId: string, reason: string) => Promise<void>;
  retryWork: (workId: string) => Promise<void>;
  deleteWork: (workId: string) => Promise<void>;
  duplicateWork: (workId: string) => void;
  /** 把当前安排好的工作存成常用工作，返回是否存成功。 */
  saveArrangement: (arrangement: Omit<SavedArrangement, 'id' | 'savedAt'>) => boolean;
  deleteSavedArrangement: (arrangementId: string) => void;
  /** 用已保存的安排重新打开安排工作页。 */
  runSavedArrangement: (arrangementId: string) => void;
  setPermission: (employeeId: string, permissionId: OperationPermissionId, enabled: boolean) => void;
  setPermissionScope: (employeeId: string, permissionId: OperationPermissionId, scope: string) => void;
  chooseFolder: () => Promise<string | null>;
  createMySkillVersion: (skillId: string) => void;
  updateSkillField: (skillId: string, fieldId: string, value: string) => void;
  saveMySkillVersion: (skillId: string) => void;
  submitSkillForReview: (skillId: string) => void;
  discardMySkillVersion: (skillId: string) => void;
}

export function useEnterpriseWorkspace({ userName, enterpriseId, enterpriseName, instances }: Options): EnterpriseWorkspace {
  const [tasks, setTasks] = useState<ClientTask[]>([]);
  const [route, setRoute] = useState<AppRoute>({ name: 'home' });
  const [history, setHistory] = useState<AppRoute[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [skills, setSkills] = useState<EmployeeSkill[]>(() => applyMySkillEdits(initialSkills(), readMySkillEdits(enterpriseId)));
  const [permissionOverrides, setPermissionOverrides] = useState<Record<string, OperationPermission[]>>({});
  const [activeEmployeeByWork, setActiveEmployeeByWork] = useState<Record<string, string>>({});
  const [arrangeSeed, setArrangeSeed] = useState<ArrangeSeed | null>(null);
  const [savedArrangements, setSavedArrangements] = useState<SavedArrangement[]>(() => readSavedArrangements(enterpriseId));
  const [arrangementPlans, setArrangementPlans] = useState<Record<string, ArrangementPlanSnapshot>>({});
  const [reviewedAt, setReviewedAt] = useState<Record<string, number>>(() => readReviewed(enterpriseId));
  const streamingText = useRef(new Map<string, string>());
  const runtimeActivities = useRef(new Map<string, WorkActivity[]>());
  const latestRunByTask = useRef(new Map<string, string>());
  const messagesByTask = useRef(new Map<string, ClientTaskMessage[]>());
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
    const profile = profileForRole(roleName);
    const permissions = permissionOverrides[instance.subscriptionId] ?? defaultPermissions();
    const revoked = instance.status !== 'ACTIVE';
    return {
      id: instance.subscriptionId,
      name: instance.name,
      mark: instance.template.avatar || instance.name.slice(0, 1),
      roleName,
      availability: revoked ? 'unavailable' : permissions.some(item => item.enabled) ? 'ready' : 'needs-auth',
      assignedToMe: true,
      intro: profile.intro,
      goodAt: profile.goodAt,
      cannotDo: profile.cannotDo,
      lastWorkedAt: null,
      allowedModels: Array.isArray(instance.allowedModels) ? instance.allowedModels : [],
      skillIds: [],
      permissions,
      version: instance.templateVersion,
    };
  }), [instances, permissionOverrides]);

  // ── 工作 ─────────────────────────────────────────────────────────────
  const works = useMemo<WorkItem[]>(() => {
    const items = tasks.map(task => buildWorkItem({
      task,
      employees: myEmployees,
      messages: messagesByTask.current.get(task.id),
      plan: arrangementPlans[task.id],
      streamingText: streamingText.current.get(runtimeKey(task.id, task.activeRunId ?? latestRunByTask.current.get(task.id) ?? '')),
      activities: runtimeActivities.current.get(runtimeKey(task.id, task.activeRunId ?? latestRunByTask.current.get(task.id) ?? '')) ?? [],
      activeEmployeeId: activeEmployeeByWork[task.id],
    }));
    return items.sort((left, right) => right.updatedAt - left.updatedAt);
  }, [tasks, myEmployees, activeEmployeeByWork, arrangementPlans]);

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
      skillIds: skills.filter(skill => !skill.employeeIds.length || skill.employeeIds.includes(employee.id)).map(skill => skill.id),
    }));
    return [...mine, ...unassignedEmployees(mine.map(employee => employee.roleName))];
  }, [myEmployees, works, skills]);

  const overview = useMemo<EnterpriseOverview>(() => ({
    id: enterpriseId,
    name: enterpriseName,
    mark: enterpriseName.slice(0, 1) || '企',
    // TODO 平台接口未开放：企业员工总数。至少不小于我可用的数量。
    totalEmployees: Math.max(ENTERPRISE_TOTAL_EMPLOYEES, myEmployees.length),
    availableToMe: myEmployees.length,
    activeWorkCount: works.filter(work => work.status === 'running' || work.status === 'arranging').length,
    needsMeCount: works.filter(work => work.status === 'waiting-user' || work.status === 'failed').length,
  }), [enterpriseId, enterpriseName, myEmployees.length, works]);

  /** 模板的默认参与员工按职能匹配到我可用的员工上。 */
  const templates = useMemo<ArrangementTemplate[]>(() => ARRANGEMENT_TEMPLATES.map(template => ({
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

    const loadTaskDetails = async (list: ClientTask[], prune = false) => {
      const fetchedPlans = new Map<string, ArrangementPlanSnapshot>();
      await Promise.all(list.map(async task => {
        const [messagesResult, planResult] = await Promise.allSettled([
          api.getTaskMessages(task.id),
          api.getArrangementPlan(task.id),
        ]);
        if (messagesResult.status === 'fulfilled' && messagesResult.value.success && messagesResult.value.messages) {
          messagesByTask.current.set(task.id, messagesResult.value.messages);
        }
        if (planResult.status === 'fulfilled' && planResult.value.success && planResult.value.plan) {
          fetchedPlans.set(task.id, planResult.value.plan);
        }
      }));
      if (!active) return;
      setArrangementPlans(current => {
        const next: Record<string, ArrangementPlanSnapshot> = prune
          ? Object.fromEntries(list.flatMap(task => current[task.id] ? [[task.id, current[task.id]]] : []))
          : { ...current };
        fetchedPlans.forEach((plan, taskId) => { next[taskId] = plan; });
        return next;
      });
      setTasks(current => [...current]);
    };

    void api.getAllTasks().then(result => {
      if (!active || !result.success) return;
      const list = result.tasks ?? [];
      setTasks(list);
      void loadTaskDetails(list, true);
    }).catch(() => {
      if (active) setTasks([]);
    });

    const unsubscribeList = api.onTaskListUpdated(list => {
      if (!active) return;
      setTasks(list);
      void loadTaskDetails(list, true);
    });
    const unsubscribeTask = api.onTaskUpdated(task => {
      if (!active) return;
      setTasks(current => {
        const index = current.findIndex(item => item.id === task.id);
        if (index === -1) return [task, ...current];
        return current.map(item => (item.id === task.id ? task : item));
      });
      void loadTaskDetails([task]);
    });
    const unsubscribePi = api.onPiEvent(event => {
      if (!active) return;
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
      if (event.type === 'agent_end' || event.type === 'session_error') streamingText.current.delete(key);
      setTasks(current => [...current]);
    });

    return () => {
      active = false;
      unsubscribeList();
      unsubscribeTask();
      unsubscribePi();
    };
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
    const goal = text.trim();
    if (!goal) return;
    const employee = myEmployees.find(item => item.id === employeeId);
    if (!employee) { setError('请先选择一位硅基员工'); return; }
    const api = window.electronAPI;
    const title = goal.length > 40 ? `${goal.slice(0, 40)}…` : goal;
    setBusy(true);
    setError(null);
    try {
      const model = options?.model?.trim();
      if (!model) throw new Error('请在执行设置中选择模型');
      const draftResult = await api.createArrangementDraft({
        mode: 'conversation', title, goal, confirmedInputs: [], sharedSkillIds: options?.skillIds ?? [],
        conversation: { participants: [{ subscriptionId: employeeId, modelId: model }], activeSubscriptionId: employeeId },
        nodes: [], workspace: { mode: 'shared', path: options?.workDir?.trim() || null },
        permissions: { preset: options?.permissionPreset ?? 'read-only', allowWithoutApproval: options?.allowWithoutApproval === true }, lastPlanning: null,
      }) as { success: boolean; draft?: { id: string; revision: number }; error?: { message?: string } };
      if (!draftResult.success || !draftResult.draft) throw new Error(draftResult.error?.message || '创建工作失败');
      const started = await api.confirmAndStartArrangement({ draftId: draftResult.draft.id, expectedRevision: draftResult.draft.revision, idempotencyKey: crypto.randomUUID() }) as { success: boolean; plan?: { id: string }; error?: { message?: string } };
      if (!started.success || !started.plan) throw new Error(started.error?.message || '员工没能接单，请重试');
      clearRuntimeState(started.plan.id);
      setActiveEmployeeByWork(current => ({ ...current, [started.plan!.id]: employeeId }));
      navigate({ name: 'work', workId: started.plan.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '工作创建失败');
    } finally {
      setBusy(false);
    }
  }, [clearRuntimeState, myEmployees, navigate]);

  const arrangeWork = useCallback(async (draft: ArrangeWorkDraft) => {
    const steps = draft.steps.filter(step => step.employeeId && step.title.trim());
    if (!steps.length) { setError('请至少安排一个工作步骤'); return; }
    const kept = new Set(steps.map(step => step.id));
    const planned = steps.map(step => ({
      id: step.id,
      employeeId: step.employeeId,
      title: step.title,
      input: step.input,
      output: step.output,
      dependsOn: step.dependsOn.filter(dep => kept.has(dep)),
      needsConfirm: step.needsConfirm,
      skillIds: [...step.skillIds],
    }));
    const goal = draft.goal.trim() || draft.title.trim();
    const title = draft.title.trim() || goal.slice(0, 40);
    const execution = draft.execution ?? {
      model: '',
      modelStrategy: 'per-employee' as const,
      permissionPreset: 'read-only' as const,
      allowWithoutApproval: false,
    };
    const api = window.electronAPI;
    setBusy(true);
    setError(null);
    try {
      const employeeModels = new Map(myEmployees.map(employee => [employee.id, employee.allowedModels]));
      const commonModels = planned.reduce<string[]>((common, step) => {
        const allowed = employeeModels.get(step.employeeId) ?? [];
        return common.length ? common.filter(model => allowed.includes(model)) : [...allowed];
      }, []);
      const modelIds = draft.arrangementMode === 'auto' && execution.modelStrategy === 'same-model' && commonModels.length
        ? planned.map(() => commonModels[0]!)
        : planned.map(step => {
          const allowed = employeeModels.get(step.employeeId) ?? [];
          if (execution.model && allowed.includes(execution.model)) return execution.model;
          return allowed[0] ?? '';
        });
      if (modelIds.some(model => !model)) throw new Error('参与员工没有可用模型');

      const draftResult = await api.createArrangementDraft({
        mode: draft.arrangementMode ?? 'manual',
        title,
        goal,
        confirmedInputs: draft.confirmedInputs.filter(Boolean),
        sharedSkillIds: draft.sharedSkillIds.filter(Boolean),
        conversation: null,
        nodes: planned.map((step, index) => ({
          id: step.id,
          subscriptionId: step.employeeId,
          modelId: modelIds[index]!,
          title: step.title,
          instruction: [step.title, step.input && '需要：' + step.input].filter(Boolean).join('\n'),
          expectedOutput: step.output || step.title,
          dependsOn: step.dependsOn,
          skillIds: step.skillIds,
          requiresUserConfirmation: execution.allowWithoutApproval ? false : step.needsConfirm,
        })),
        workspace: { mode: 'shared', path: draft.workDir.trim() || null },
        permissions: { preset: execution.permissionPreset, allowWithoutApproval: execution.allowWithoutApproval },
        lastPlanning: null,
      }) as { success: boolean; draft?: { id: string; revision: number }; error?: { message?: string } };
      if (!draftResult.success || !draftResult.draft) throw new Error(draftResult.error?.message || '创建工作失败');
      const started = await api.confirmAndStartArrangement({
        draftId: draftResult.draft.id,
        expectedRevision: draftResult.draft.revision,
        idempotencyKey: crypto.randomUUID(),
      }) as { success: boolean; plan?: { id: string }; error?: { message?: string } };
      if (!started.success || !started.plan) throw new Error(started.error?.message || '工作没能开始，请重试');
      navigate({ name: 'work', workId: started.plan.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '工作创建失败');
    } finally {
      setBusy(false);
    }
  }, [myEmployees, navigate]);

  const sendMessage = useCallback((workId: string, text: string) => {
    const prompt = text.trim();
    if (!prompt) return;
    setError(null);
    void run(() => window.electronAPI.continueTask({ taskId: workId, prompt }), '消息没能发送，请重试');
  }, [run]);

  const switchEmployee = useCallback(async (workId: string, employeeId: string) => {
    if (!myEmployees.some(item => item.id === employeeId)) { setError('这位员工当前不可用'); return; }
    setActiveEmployeeByWork(current => ({ ...current, [workId]: employeeId }));
    await run(() => window.electronAPI.switchConversationEmployee({ taskId: workId, subscriptionId: employeeId }), '切换员工失败，已保留原来的员工');
  }, [myEmployees, run]);

  const confirmStep = useCallback(async (workId: string) => {
    // 平台暂无按步骤确认接口，先用继续执行表达「我确认了，继续」。
    await run(() => window.electronAPI.continueTask({ taskId: workId, prompt: '我已确认当前结果，请继续下一步。' }), '确认没能提交，请重试');
  }, [run]);

  const stopWork = useCallback(async (workId: string, reason: string) => {
    const ok = await run(() => window.electronAPI.cancelTask(workId), '终止失败，请重试');
    if (ok) setTasks(current => current.map(task => (task.id === workId ? { ...task, error: task.error ?? reason } : task)));
  }, [run]);

  const retryWork = useCallback(async (workId: string) => {
    await run(() => window.electronAPI.retryTask(workId), '重试失败，请稍后再试');
  }, [run]);

  const deleteWork = useCallback(async (workId: string) => {
    const ok = await run(() => window.electronAPI.deleteTask(workId), '删除失败，请重试');
    if (ok) {
      messagesByTask.current.delete(workId);
      clearRuntimeState(workId);
      setTasks(current => current.filter(task => task.id !== workId));
      setRoute(current => (current.name === 'work' && current.workId === workId ? { name: 'records' } : current));
    }
  }, [clearRuntimeState, run]);

  const duplicateWork = useCallback((workId: string) => {
    const work = works.find(item => item.id === workId);
    if (!work) return;
    // 运行期的步骤没有画布坐标，自动布局按依赖分层补上，进「自己编排」时直接是一条链。
    setArrangeSeed({
      goal: work.goal,
      steps: layoutSteps(work.steps.map(step => ({
        id: step.id,
        employeeId: step.employeeId,
        title: step.title,
        input: step.input,
        output: step.output,
        dependsOn: [...step.dependsOn],
        needsConfirm: step.needsConfirm,
        skillIds: [],
        x: 0,
        y: 0,
      }))),
    });
    navigate({ name: 'arrange', mode: 'manual' });
  }, [works, navigate]);

  // ── 常用工作 ──────────────────────────────────────────────────────────
  /** 写盘失败（无痕模式、配额满）不阻断界面：内存里仍然保留，只是下次打开会丢。 */
  const persistArrangements = useCallback((next: SavedArrangement[]) => {
    setSavedArrangements(next);
    try {
      window.localStorage.setItem(savedArrangementsKey(enterpriseId), JSON.stringify(next));
      return true;
    } catch {
      setError('常用安排已在本次使用中生效，但没能保存到本机');
      return false;
    }
  }, [enterpriseId]);

  const saveArrangement = useCallback((arrangement: Omit<SavedArrangement, 'id' | 'savedAt'>) => {
    const name = arrangement.name.trim();
    if (!name) { setError('请先给这个常用安排起个名字'); return false; }
    if (!arrangement.steps.length) { setError('至少要有一个安排步骤才能保存'); return false; }
    const entry: SavedArrangement = {
      ...arrangement,
      name,
      id: `arrangement-${Date.now().toString(36)}`,
      savedAt: Date.now(),
    };
    // 同名视为覆盖，避免列表里堆出一串「客户周报」。
    return persistArrangements([entry, ...savedArrangements.filter(item => item.name !== name)]);
  }, [savedArrangements, persistArrangements]);

  const deleteSavedArrangement = useCallback((arrangementId: string) => {
    persistArrangements(savedArrangements.filter(item => item.id !== arrangementId));
  }, [savedArrangements, persistArrangements]);

  const runSavedArrangement = useCallback((arrangementId: string) => {
    const arrangement = savedArrangements.find(item => item.id === arrangementId);
    if (!arrangement) return;
    // 保存时的员工可能已经不归我用了，进页面前先剔掉，让用户重新指派。
    const available = new Set(myEmployees.map(employee => employee.id));
    setArrangeSeed({
      title: arrangement.name,
      goal: arrangement.goal,
      confirmedInputs: arrangement.confirmedInputs,
      sharedSkillIds: arrangement.sharedSkillIds,
      steps: arrangement.steps.map(step => ({ ...step, employeeId: available.has(step.employeeId) ? step.employeeId : '' })),
    });
    navigate({ name: 'arrange', mode: 'manual' });
  }, [savedArrangements, myEmployees, navigate]);

  const chooseFolder = useCallback(async () => {
    try {
      const result = await window.electronAPI.selectDirectory();
      return result.success ? result.path ?? null : null;
    } catch {
      return null;
    }
  }, []);

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
  const patchSkill = useCallback((skillId: string, patch: (skill: EmployeeSkill) => EmployeeSkill) => {
    setSkills(current => {
      const next = current.map(skill => (skill.id === skillId ? patch(skill) : skill));
      writeMySkillEdits(enterpriseId, next);
      return next;
    });
  }, [enterpriseId]);

  const createMySkillVersion = useCallback((skillId: string) => {
    patchSkill(skillId, skill => ({
      ...skill,
      // 个人版本从企业标准复制而来，企业标准本身永远不被改写。
      fields: skill.fields.map(field => ({ ...field, myValue: field.myValue || field.enterpriseValue })),
      my: { state: 'draft', updatedAt: Date.now(), submittedAt: null, reviewNote: null },
    }));
  }, [patchSkill]);

  const updateSkillField = useCallback((skillId: string, fieldId: string, value: string) => {
    patchSkill(skillId, skill => ({
      ...skill,
      fields: skill.fields.map(field => (field.id === fieldId ? { ...field, myValue: value } : field)),
      my: skill.my.state === 'none' ? { state: 'draft', updatedAt: Date.now(), submittedAt: null, reviewNote: null } : skill.my,
    }));
  }, [patchSkill]);

  const saveMySkillVersion = useCallback((skillId: string) => {
    patchSkill(skillId, skill => ({ ...skill, my: { ...skill.my, state: 'draft', updatedAt: Date.now() } }));
  }, [patchSkill]);

  const submitSkillForReview = useCallback((skillId: string) => {
    // TODO 平台接口未开放：提交个人技能版本供企业审核。
    patchSkill(skillId, skill => ({ ...skill, my: { state: 'submitted', updatedAt: Date.now(), submittedAt: Date.now(), reviewNote: null } }));
  }, [patchSkill]);

  const discardMySkillVersion = useCallback((skillId: string) => {
    patchSkill(skillId, skill => ({
      ...skill,
      fields: skill.fields.map(field => ({ ...field, myValue: field.enterpriseValue })),
      my: { state: 'none', updatedAt: 0, submittedAt: null, reviewNote: null },
    }));
  }, [patchSkill]);

  return {
    overview, employees, myEmployees, templates, savedArrangements, skills, works, unreviewedWorkIds, route, error, busy,
    canGoBack: history.length > 0,
    arrangeSeed, seedArrange: setArrangeSeed, userName,
    navigate, goBack, dismissError: () => setError(null),
    startConversation, arrangeWork, sendMessage, switchEmployee, confirmStep,
    stopWork, retryWork, deleteWork, duplicateWork,
    saveArrangement, deleteSavedArrangement, runSavedArrangement,
    setPermission, setPermissionScope, chooseFolder,
    createMySkillVersion, updateSkillField, saveMySkillVersion, submitSkillForReview, discardMySkillVersion,
  };
}

/** 「已完成 N 个步骤」的统一算法，供页面直接使用。 */
export { completedStepCount };

