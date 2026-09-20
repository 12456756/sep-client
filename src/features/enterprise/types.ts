import type { WorkActivity } from '../../shared/work-activity'

/**
 * 客户端业务域模型 —— 面向「企业 / 硅基员工 / 工作」而非「Agent / 任务 / DAG」。
 *
 * 这一层刻意不复用 shared/types.ts 的传输结构：IPC 契约随平台演进，
 * 而界面表达要稳定在业务语言上。两者的映射集中在 useEnterpriseWorkspace。
 */

// ──────────────────────────────── 企业 ────────────────────────────────

export interface EnterpriseOverview {
  id: string;
  name: string;
  /** 企业标识文字，取企业名首字，用于顶栏方形标记。 */
  mark: string;
  /** 企业硅基员工总数。平台接口未开放，暂由占位数据提供。 */
  totalEmployees: number;
  /** 当前成员被授权的员工数，来自订阅目录，真实数据。 */
  availableToMe: number;
  /** 正在进行的工作数，来自本地任务。 */
  activeWorkCount: number;
  /** 待我处理的结果数（等待确认 + 失败）。 */
  needsMeCount: number;
}

// ────────────────────────────── 硅基员工 ──────────────────────────────

/** 员工可用状态。展示上同时使用颜色、图标和文字，不依赖单一颜色。 */
export type EmployeeAvailability = 'ready' | 'working' | 'unavailable' | 'needs-auth';

/** 用户可自行设置的本机操作权限。开启时提醒，不出现工具名与协议参数。 */
export type OperationPermissionId = 'read-files' | 'write-files' | 'browser' | 'desktop-app' | 'shell';

export interface OperationPermission {
  id: OperationPermissionId;
  label: string;
  /** 面向非技术用户的一句话说明：员工能做什么。 */
  summary: string;
  risk: 'low' | 'medium' | 'high';
  enabled: boolean;
  /** 生效范围，例如被授权的目录。空表示无需范围。 */
  scope?: string;
  /** 首次开启时展示的提醒：会做什么、影响范围、可随时关闭。 */
  notice: string;
  /** 每次动作都单独确认（高风险项默认开启）。 */
  confirmEachTime: boolean;
}

export interface SiliconEmployee {
  /** 等于平台的 subscriptionId。 */
  id: string;
  name: string;
  /** 头像文字，无图时使用。 */
  mark: string;
  /** 职能名称，例如「数据分析」。 */
  roleName: string;
  department: string | null;
  availability: EmployeeAvailability;
  /** 是否已分配给当前用户。未分配的员工只用于展示企业规模，不作为操作对象。 */
  assignedToMe: boolean;
  /** 员工介绍。平台接口未开放，占位。 */
  intro: string;
  /** 擅长的工作类型。平台接口未开放，占位。 */
  goodAt: string[];
  /** 不能处理的工作类型，用于管理预期。平台接口未开放，占位。 */
  cannotDo: string[];
  lastWorkedAt: number | null;
  allowedModels: string[];
  skillIds: string[];
  permissions: OperationPermission[];
  /** 员工版本，仅在详情页作为次要信息展示。 */
  templateVersion: string;
}

// ─────────────────────────────── 工作 ────────────────────────────────

export type WorkStatus = 'arranging' | 'running' | 'waiting-user' | 'completed' | 'failed' | 'paused';

export type WorkStepState = 'pending' | 'running' | 'waiting-user' | 'done' | 'failed' | 'skipped';

/** 一个工作步骤只表达业务信息：由谁完成、完成什么、需要什么、产出什么。 */
export interface WorkStep {
  id: string;
  employeeId: string;
  employeeName: string;
  /** 完成什么。 */
  title: string;
  /** 需要什么输入。 */
  input: string;
  /** 产生什么结果。 */
  output: string;
  /**
   * 需要哪些上游步骤全部完成后才开始。空数组表示可以立刻开工。
   *
   * 这里是依赖图而不是「上一步」：一个步骤连到多个步骤表示后面可以并行，
   * 多个步骤连到同一个步骤表示它要等全部前置完成。
   */
  dependsOn: string[];
  /** 这一步完成后是否需要用户确认。 */
  needsConfirm: boolean;
  state: WorkStepState;
}

/**
 * 编排画布上的一个工作步骤。和运行期的 WorkStep 分开：
 * 坐标只在编排时有意义，状态只在运行时有意义，混在一个类型里两边都要写假字段。
 *
 * 员工与步骤是两个概念：同一位员工可以承担多个步骤，所以 id 独立于 employeeId。
 */
export interface WorkDraftStep {
  id: string;
  employeeId: string;
  title: string;
  input: string;
  output: string;
  dependsOn: string[];
  needsConfirm: boolean;
  /** 这一步单独追加的技能。工作级的共享技能不在这里。 */
  skillIds: string[];
  /** 画布坐标。 */
  x: number;
  y: number;
}

/** 切换员工时同步给下一位员工的共享背景。 */
export interface SharedContext {
  goal: string;
  confirmedInputs: string[];
  previousResults: string[];
  userNotes: string[];
}

export interface WorkMessage {
  id: string;
  role: 'user' | 'employee' | 'system';
  /** 说话的员工，system 与 user 为空。 */
  employeeId?: string;
  employeeName?: string;
  content: string;
  createdAt: number;
}

export interface WorkDeliverable {
  id: string;
  name: string;
  /** 文件在本机的完整路径。界面上只在需要时展示，复制路径按它。 */
  path: string;
  note: string;
}

export type { WorkActivity, WorkActivityState } from '../../shared/work-activity'

export interface WorkTimelineEntry {
  id: string;
  at: number;
  /** 动作发起方的展示名，例如「资料整理员工」或「你」。 */
  actor: string;
  text: string;
  kind: 'create' | 'employee' | 'user' | 'deliver' | 'stop' | 'fail';
}

export interface WorkItem {
  id: string;
  title: string;
  goal: string;
  /** 对话式工作与流程式工作走不同的页面，但在记录里统一呈现。 */
  kind: 'conversation' | 'flow';
  status: WorkStatus;
  progress: number;
  currentEmployeeId: string;
  currentEmployeeName: string;
  steps: WorkStep[];
  /** 当前需要用户做什么。空表示无需用户介入。 */
  nextUserAction: string | null;
  createdAt: number;
  updatedAt: number;
  participants: string[];
  deliverables: WorkDeliverable[];
  timeline: WorkTimelineEntry[];
  messages: WorkMessage[];
  /** ?????????????????? */
  activities: WorkActivity[];
  sharedContext: SharedContext;
  /** 终止原因。终止后仍保留已完成动作与已产生文件。 */
  stopReason: string | null;
  /** 本地工作目录，仅在需要时展示。 */
  workDir: string | null;
}

// ───────────────────────────── 固定工作流程 ─────────────────────────────

export interface WorkTemplateInput {
  id: string;
  label: string;
  type: 'text' | 'long-text' | 'path' | 'enum';
  required: boolean;
  options?: string[];
  placeholder?: string;
}

/** 企业预设的固定工作流程，是「安排工作」的默认入口。 */
export interface WorkTemplate {
  id: string;
  name: string;
  goal: string;
  /** 默认参与员工，按顺序对应工作步骤。 */
  employeeIds: string[];
  requiredInputs: WorkTemplateInput[];
  /** 最终输出形式，例如「Word 报告」。 */
  outputForm: string;
  /** 预设步骤，进入自定义安排时作为初始内容。 */
  steps: { title: string; input: string; output: string; needsConfirm: boolean }[];
}

/**
 * 用户自己保存下来的常用工作。
 *
 * 和企业预设流程（WorkTemplate）分开：企业预设是企业维护的、只读的；
 * 这里是用户在「安排工作」里调好之后自己存的，只属于自己，可以删。
 * 两者在首页「常做的工作」里并排出现，用标记区分来源。
 */
export interface SavedWorkFlow {
  id: string;
  name: string;
  goal: string;
  /**
   * 数据版本。缺失或 1 表示旧的线性链格式（步骤带 inheritPrevious、没有坐标），
   * 读取时按「每一步依赖上一步」升级成依赖图并补上自动布局坐标。
   */
  version?: 1 | 2;
  /** 保存时的工作步骤，重新使用时原样带回安排工作页。 */
  steps: WorkDraftStep[];
  /** 保存时已确认可以交给员工的资料说明。 */
  confirmedInputs: string[];
  /** 整个工作共享的技能。 */
  sharedSkillIds?: string[];
  savedAt: number;
}

// ─────────────────────────────── 员工技能 ───────────────────────────────

// ─────────────────────────────── 导航 ────────────────────────────────

/**
 * 「安排工作」的四个画面。pick 是入口，另外三个是三种安排方式。
 *
 * - `pick`   选择用哪种方式安排
 * - `chat`   对话式：一位同事，边聊边做
 * - `auto`   自动编排：说清目标，系统自己选人并排出流程
 * - `manual` 自己编排：自己选人、自己决定先后
 */
export type ArrangeMode = 'pick' | 'chat' | 'auto' | 'manual';

export type AppRoute =
  | { name: 'organization' }
  | { name: 'home' }
  /** scope 决定员工页默认看哪一批人：首页「企业硅基员工」进来看全部，「已分配给我」进来只看自己的。 */
  | { name: 'employees'; scope?: 'mine' | 'all' }
  | { name: 'employee'; employeeId: string }
  /** employeeId 只在 chat 下有意义：从员工页点「安排工作」时预选那位同事。 */
  | { name: 'arrange'; templateId?: string; mode?: ArrangeMode; employeeId?: string }
  | { name: 'records'; bucket?: 'all' | 'active' | 'mine' | 'done' | 'stopped' }
  | { name: 'work'; workId: string }
  | { name: 'skills'; skillId?: string };

export type AppRouteName = AppRoute['name'];
