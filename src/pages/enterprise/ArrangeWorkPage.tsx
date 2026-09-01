/**
 * 安排工作。默认先给企业固定流程，用户只在需要时才自己安排步骤。
 *
 * 三个界面共用一个入口：
 * 1. 固定流程列表 —— 每张卡片说清目标、参与员工、步骤数、需要你提供什么、最后给你什么。
 * 2. 固定流程四步走 —— 填写目标和资料 → 确认参与员工 → 检查安排 → 开始工作。
 * 3. 自定义安排 —— 纵向步骤列表，不使用画布与连线。
 *
 * 界面默认不出现节点 ID、Agent ID、Session、DAG、接口参数；
 * 工作目录这类技术性设置收进「高级设置」。
 */

import { BookmarkPlus, ClipboardCheck, FileText, FolderOpen, FolderTree, LineChart, PenLine, Radar, Rocket, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { StepEditor, createStep } from '../../components/enterprise/StepEditor';
import { Empty, EmployeeAvatar } from '../../components/enterprise/atoms';
import type { ArrangeWorkDraft, EnterpriseWorkspace } from '../../features/enterprise/useEnterpriseWorkspace';
import type { WorkTemplate, WorkTemplateInput } from '../../features/enterprise/types';

const TEMPLATE_ICON: Record<string, typeof FileText> = {
  'customer-weekly': FileText,
  'contract-precheck': ClipboardCheck,
  'material-tidy': FolderTree,
  'data-summary': LineChart,
  'market-scan': Radar,
};

const STAGES = ['填写目标和资料', '确认参与员工', '检查安排'] as const;

interface Props {
  workspace: EnterpriseWorkspace;
  templateId?: string;
  custom: boolean;
}

export function ArrangeWorkPage({ workspace, templateId, custom }: Props) {
  const template = templateId ? workspace.templates.find(item => item.id === templateId) : undefined;

  if (custom) return <CustomFlow workspace={workspace} />;
  if (templateId && !template) {
    return (
      <div className="ent-page">
        <Empty title="这个固定流程已经不可用">企业可能调整了流程配置。你可以换一个流程，或者自己安排步骤。</Empty>
      </div>
    );
  }
  if (template) return <TemplateFlow key={template.id} workspace={workspace} template={template} />;
  return <Gallery workspace={workspace} />;
}

/** 固定流程列表。这是「安排工作」的默认界面。 */
function Gallery({ workspace }: { workspace: EnterpriseWorkspace }) {
  const { templates, myEmployees, savedFlows } = workspace;

  return (
    <div className="ent-page">
      {savedFlows.length ? (
        <section className="ent-section">
          <div className="ent-section-head">
            <div>
              <h2>我保存的常用工作</h2>
              <p>你之前调好的安排，点一下就带着原来的步骤重新开始。</p>
            </div>
          </div>
          <div className="ent-template-row">
            {savedFlows.map(flow => (
              <div key={flow.id} className="ent-template-card saved">
                <button type="button" className="ent-template-main" onClick={() => workspace.runSavedFlow(flow.id)}>
                  <span className="ent-template-icon" aria-hidden><BookmarkPlus size={17} /></span>
                  <strong>{flow.name}</strong>
                  <small>{flow.goal}</small>
                </button>
                <span className="ent-template-foot">
                  <span className="ent-saved-flag">我保存的 · {flow.steps.length} 个步骤</span>
                  <button type="button" className="ent-template-del" onClick={() => workspace.deleteSavedFlow(flow.id)} aria-label={`删除常用工作 ${flow.name}`}>
                    删除
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="ent-section-head">
        <div>
          <h2>企业固定流程</h2>
          <p>这些流程由企业配置好，选一个填几项资料就能开始，不需要你安排步骤。</p>
        </div>
        <button type="button" className="link" onClick={() => workspace.navigate({ name: 'arrange', custom: true })}>我要自己安排步骤</button>
      </div>

      {!myEmployees.length ? (
        <div className="ent-banner attention">你名下还没有可用的硅基员工，安排工作前请先联系企业管理员分配员工。</div>
      ) : null}

      <div className="ent-template-grid">
        {templates.map(template => {
          const Icon = TEMPLATE_ICON[template.id] ?? FileText;
          const owners = template.employeeIds.map(id => myEmployees.find(item => item.id === id)).filter(Boolean);
          return (
            <button key={template.id} type="button" className="ent-template-card" onClick={() => workspace.navigate({ name: 'arrange', templateId: template.id })} disabled={!myEmployees.length}>
              <span className="ent-template-top">
                <span className="ent-template-icon"><Icon size={18} aria-hidden /></span>
                <strong>{template.name}</strong>
              </span>
              <span className="ent-template-goal">{template.goal}</span>
              <dl className="ent-template-meta">
                <div><dt>参与员工</dt><dd>{owners.length ? owners.map(item => item!.name).join('、') : '开始前由你指定'}</dd></div>
                <div><dt>预计步骤</dt><dd>{template.steps.length} 步</dd></div>
                <div><dt>需要你提供</dt><dd>{template.requiredInputs.filter(input => input.required).map(input => input.label).join('、') || '无'}</dd></div>
                <div><dt>最终给你</dt><dd>{template.outputForm}</dd></div>
              </dl>
              <span className="ent-template-cta">选这个流程</span>
            </button>
          );
        })}

        <button type="button" className="ent-template-card custom" onClick={() => workspace.navigate({ name: 'arrange', custom: true })} disabled={!myEmployees.length}>
          <span className="ent-template-top">
            <span className="ent-template-icon"><PenLine size={18} aria-hidden /></span>
            <strong>自己安排步骤</strong>
          </span>
          <span className="ent-template-goal">没有合适的固定流程时，自己决定每一步由谁完成、完成什么、产出什么。</span>
          <span className="ent-template-cta">开始自定义</span>
        </button>
      </div>
    </div>
  );
}
/** 固定流程的四步走。步骤内容由企业定义，用户只调整参与员工与确认点。 */
function TemplateFlow({ workspace, template }: { workspace: EnterpriseWorkspace; template: WorkTemplate }) {
  const employees = workspace.myEmployees;
  const [stage, setStage] = useState(0);
  const [title, setTitle] = useState(template.name);
  const [goal, setGoal] = useState(template.goal);
  const [workDir, setWorkDir] = useState('');
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    template.requiredInputs.map(input => [input.id, input.type === 'enum' ? input.options?.[0] ?? '' : '']),
  ));
  const [steps, setSteps] = useState<ArrangeWorkDraft['steps']>(() => template.steps.map((step, index) => ({
    id: `step-${template.id}-${index}`,
    employeeId: template.employeeIds[index] ?? employees[0]?.id ?? '',
    title: step.title,
    input: step.input,
    output: step.output,
    inheritPrevious: index > 0,
    needsConfirm: step.needsConfirm,
  })));

  const missing = template.requiredInputs.filter(input => input.required && !values[input.id]?.trim());
  const confirmedInputs = useMemo(
    () => template.requiredInputs.map(input => (values[input.id]?.trim() ? `${input.label}：${values[input.id].trim()}` : '')).filter(Boolean),
    [template.requiredInputs, values],
  );
  const ready = !missing.length && steps.length > 0 && steps.every(step => step.employeeId) && employees.length > 0;

  const start = () => {
    void workspace.arrangeWork({
      title: title.trim() || template.name,
      goal: goal.trim() || template.goal,
      templateId: template.id,
      workDir,
      steps,
      confirmedInputs,
    });
  };

  return (
    <div className="ent-page">
      <Stages current={stage} onJump={setStage} />

      {stage === 0 ? (
        <section className="ent-card pad ent-form">
          <h2>这次要完成什么</h2>
          <label className="ent-field">
            <span>工作名称</span>
            <input className="ent-input" value={title} onChange={event => setTitle(event.target.value)} placeholder={template.name} />
          </label>
          <label className="ent-field">
            <span>工作目标</span>
            <textarea className="ent-textarea" value={goal} onChange={event => setGoal(event.target.value)} />
            <small>员工按这个目标干活，写得越具体，结果越贴近你的预期。</small>
          </label>
          <h3>需要你提供的资料</h3>
          <p className="ent-hint">这些内容会作为「已确认资料」同步给参与的每一位员工。</p>
          {template.requiredInputs.map(input => (
            <InputField
              key={input.id}
              input={input}
              value={values[input.id] ?? ''}
              onChange={value => setValues(current => ({ ...current, [input.id]: value }))}
              onPickFolder={async () => {
                const path = await workspace.chooseFolder();
                if (path) setValues(current => ({ ...current, [input.id]: path }));
              }}
            />
          ))}
        </section>
      ) : null}

      {stage === 1 ? (
        <section className="ent-card pad">
          <h2>确认参与员工</h2>
          <p className="ent-hint">流程内容由企业定义，不能修改。你可以换人、调整顺序，或者标记哪一步做完先让你确认。</p>
          <StepEditor steps={steps} employees={employees} onChange={setSteps} lockContent />
        </section>
      ) : null}

      {stage === 2 ? (
        <Review title={title.trim() || template.name} goal={goal.trim() || template.goal} steps={steps} employees={employees} confirmedInputs={confirmedInputs} outputForm={template.outputForm} workDir={workDir} onWorkDir={setWorkDir} onPickFolder={workspace.chooseFolder} />
      ) : null}

      {missing.length && stage > 0 ? (
        <div className="ent-banner attention">还差 {missing.map(input => input.label).join('、')} 没有填写，回到第一步补齐后才能开始。</div>
      ) : null}

      <div className="ent-form-foot">
        <button type="button" className="ent-btn ghost" onClick={() => (stage === 0 ? workspace.navigate({ name: 'arrange' }) : setStage(stage - 1))}>
          {stage === 0 ? '换一个流程' : '上一步'}
        </button>
        <SaveFlowButton
          workspace={workspace}
          name={title.trim() || template.name}
          goal={goal.trim() || template.goal}
          steps={steps}
          confirmedInputs={confirmedInputs}
        />
        {stage < STAGES.length - 1 ? (
          <button type="button" className="ent-btn primary" onClick={() => setStage(stage + 1)}>下一步：{STAGES[stage + 1]}</button>
        ) : (
          <button type="button" className="ent-btn primary lg" onClick={start} disabled={!ready || workspace.busy}>
            <Rocket size={14} aria-hidden />
            {workspace.busy ? '正在安排…' : '开始工作'}
          </button>
        )}
      </div>
    </div>
  );
}
/** 自定义安排：一串从上到下的步骤，没有画布也没有连线。 */
function CustomFlow({ workspace }: { workspace: EnterpriseWorkspace }) {
  const employees = workspace.myEmployees;
  const seed = workspace.arrangeSeed;
  const [title, setTitle] = useState(seed?.title ?? '');
  const [goal, setGoal] = useState(seed?.goal ?? '');
  const [materials, setMaterials] = useState(seed?.confirmedInputs?.join('\n') ?? '');
  const [workDir, setWorkDir] = useState('');
  const [steps, setSteps] = useState<ArrangeWorkDraft['steps']>(() => (
    seed?.steps.length ? seed.steps.map(step => ({ ...step })) : [createStep(employees[0]?.id ?? '', 0)]
  ));

  // 初始内容只用一次，用过就清掉，避免下次进来又被带入旧内容。
  useEffect(() => {
    if (seed) workspace.seedArrange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmedInputs = materials.split('\n').map(line => line.trim()).filter(Boolean);
  const fallbackTitle = goal.trim().slice(0, 40) || '自定义工作';
  const ready = Boolean(goal.trim()) && steps.length > 0 && steps.every(step => step.employeeId && step.title.trim()) && employees.length > 0;

  const start = () => {
    void workspace.arrangeWork({
      title: title.trim() || fallbackTitle,
      goal: goal.trim(),
      workDir,
      steps,
      confirmedInputs,
    });
  };

  if (!employees.length) {
    return (
      <div className="ent-page">
        <Empty title="还没有可以安排的硅基员工">企业管理员给你分配员工后，就可以在这里安排工作了。</Empty>
      </div>
    );
  }

  return (
    <div className="ent-page">
      <section className="ent-card pad ent-form">
        <h2>这次要完成什么</h2>
        <label className="ent-field">
          <span>工作名称</span>
          <input className="ent-input" value={title} onChange={event => setTitle(event.target.value)} placeholder={fallbackTitle} />
        </label>
        <label className="ent-field">
          <span>工作目标</span>
          <textarea className="ent-textarea" value={goal} onChange={event => setGoal(event.target.value)} placeholder="例如：把上个月的客户往来整理成一份周报，重点说明续约风险" />
          <small>目标会同步给参与的每一位员工，换人也不需要重新交代。</small>
        </label>
        <label className="ent-field">
          <span>你已经准备好的资料</span>
          <textarea className="ent-textarea" value={materials} onChange={event => setMaterials(event.target.value)} placeholder={'一行写一项，例如：\n客户资料在「客户/2026」文件夹\n上季度周报可以作为格式参考'} />
          <small>写在这里的内容表示你确认可以交给员工使用。</small>
        </label>
      </section>

      <section className="ent-card pad">
        <div className="ent-section-head" style={{ margin: 0 }}>
          <div>
            <h2 style={{ margin: 0 }}>工作步骤</h2>
            <p>从上到下依次执行。每一步只需要说清：由谁完成、完成什么、需要什么、产出什么。</p>
          </div>
          <span className="ent-tag"><Users size={12} aria-hidden /> 共 {new Set(steps.map(step => step.employeeId)).size} 位员工参与</span>
        </div>
        <StepEditor steps={steps} employees={employees} onChange={setSteps} />
      </section>

      <Review title={title.trim() || fallbackTitle} goal={goal.trim()} steps={steps} employees={employees} confirmedInputs={confirmedInputs} outputForm={steps[steps.length - 1]?.output || '最后一步的产出'} workDir={workDir} onWorkDir={setWorkDir} onPickFolder={workspace.chooseFolder} />

      <div className="ent-form-foot">
        <button type="button" className="ent-btn ghost" onClick={() => workspace.navigate({ name: 'arrange' })}>看看企业固定流程</button>
        <SaveFlowButton
          workspace={workspace}
          name={title.trim() || fallbackTitle}
          goal={goal.trim()}
          steps={steps}
          confirmedInputs={confirmedInputs}
        />
        <button type="button" className="ent-btn primary lg" onClick={start} disabled={!ready || workspace.busy}>
          <Rocket size={14} aria-hidden />
          {workspace.busy ? '正在安排…' : '开始工作'}
        </button>
      </div>
      {!ready ? <p className="ent-hint">写清工作目标，并且每一步都选好员工、填好「完成什么」，就可以开始了。</p> : null}
    </div>
  );
}
/**
 * 「保存为常用工作」。保存的是这次调好的步骤和资料，不是运行结果，
 * 所以两个安排界面都能用，且不需要先开始工作。
 * 存好之后首页「常做的工作」里就会出现，带「我保存的」标记。
 */
function SaveFlowButton({ workspace, name, goal, steps, confirmedInputs }: {
  workspace: EnterpriseWorkspace;
  name: string;
  goal: string;
  steps: ArrangeWorkDraft['steps'];
  confirmedInputs: string[];
}) {
  const [saved, setSaved] = useState(false);
  const usable = steps.some(step => step.employeeId && step.title.trim());

  return (
    <button
      type="button"
      className="ent-btn"
      disabled={!usable || saved}
      onClick={() => {
        const ok = workspace.saveFlow({
          name,
          goal,
          steps: steps.map(step => ({ ...step })),
          confirmedInputs,
        });
        if (ok) setSaved(true);
      }}
    >
      <BookmarkPlus size={14} aria-hidden />
      {saved ? '已保存为常用工作' : '保存为常用工作'}
    </button>
  );
}

function Stages({ current, onJump }: { current: number; onJump: (index: number) => void }) {
  return (
    <ol className="ent-stages">
      {STAGES.map((label, index) => (
        <li key={label} className={index === current ? 'active' : index < current ? 'done' : undefined}>
          <button type="button" onClick={() => onJump(index)} disabled={index > current}>
            <span className="ent-stage-no">{index + 1}</span>
            {label}
          </button>
        </li>
      ))}
    </ol>
  );
}

function InputField({ input, value, onChange, onPickFolder }: { input: WorkTemplateInput; value: string; onChange: (value: string) => void; onPickFolder: () => void }) {
  return (
    <label className="ent-field">
      <span>
        {input.label}
        {input.required ? <em className="ent-required">必填</em> : <em className="ent-optional">可留空</em>}
      </span>
      {input.type === 'enum' ? (
        <select className="ent-select" value={value} onChange={event => onChange(event.target.value)}>
          {(input.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : input.type === 'long-text' ? (
        <textarea className="ent-textarea" value={value} placeholder={input.placeholder} onChange={event => onChange(event.target.value)} />
      ) : input.type === 'path' ? (
        <span className="ent-field-path">
          <input className="ent-input" value={value} placeholder="还没有选择文件夹" onChange={event => onChange(event.target.value)} />
          <button type="button" className="ent-btn sm" onClick={onPickFolder}>
            <FolderOpen size={13} aria-hidden />
            选择文件夹
          </button>
        </span>
      ) : (
        <input className="ent-input" value={value} placeholder={input.placeholder} onChange={event => onChange(event.target.value)} />
      )}
    </label>
  );
}

interface ReviewProps {
  title: string;
  goal: string;
  steps: ArrangeWorkDraft['steps'];
  employees: EnterpriseWorkspace['myEmployees'];
  confirmedInputs: string[];
  outputForm: string;
  workDir: string;
  onWorkDir: (value: string) => void;
  onPickFolder: () => Promise<string | null>;
}

/** 开始之前把安排完整念一遍，避免用户对「员工要做什么」有意外。 */
function Review({ title, goal, steps, employees, confirmedInputs, outputForm, workDir, onWorkDir, onPickFolder }: ReviewProps) {
  const owners = [...new Set(steps.map(step => step.employeeId))].map(id => employees.find(item => item.id === id)).filter(Boolean);
  const confirmPoints = steps.filter(step => step.needsConfirm).length;

  return (
    <section className="ent-card pad">
      <h2>检查安排</h2>
      <dl className="ent-review">
        <div><dt>工作名称</dt><dd>{title}</dd></div>
        <div><dt>工作目标</dt><dd>{goal || '还没有填写'}</dd></div>
        <div>
          <dt>参与员工</dt>
          <dd className="ent-review-owners">
            {owners.map(item => (
              <span key={item!.id}><EmployeeAvatar mark={item!.mark} size="sm" />{item!.name}</span>
            ))}
          </dd>
        </div>
        <div><dt>最终给你</dt><dd>{outputForm}</dd></div>
        <div><dt>需要你确认</dt><dd>{confirmPoints ? `${confirmPoints} 个步骤完成后会先等你确认` : '不需要中途确认，全部做完再给你结果'}</dd></div>
      </dl>

      <h3>步骤清单</h3>
      <ol className="ent-review-steps">
        {steps.map(step => {
          const owner = employees.find(item => item.id === step.employeeId);
          return (
            <li key={step.id}>
              <strong>{step.title || '（还没有填写要完成什么）'}</strong>
              <small>{owner?.name ?? '未指定员工'} · 产出：{step.output || '未说明'}{step.needsConfirm ? ' · 完成后等你确认' : ''}</small>
            </li>
          );
        })}
      </ol>

      <h3>已确认可以使用的资料</h3>
      {confirmedInputs.length ? (
        <ul className="ent-list good">{confirmedInputs.map(item => <li key={item}>{item}</li>)}</ul>
      ) : (
        <p className="ent-hint">你还没有提供资料，员工只能依据工作目标动手。</p>
      )}

      <details className="ent-advanced">
        <summary>高级设置</summary>
        <label className="ent-field">
          <span>工作文件夹</span>
          <span className="ent-field-path">
            <input className="ent-input" value={workDir} placeholder="留空则由客户端自动准备" onChange={event => onWorkDir(event.target.value)} />
            <button type="button" className="ent-btn sm" onClick={() => void onPickFolder().then(path => { if (path) onWorkDir(path); })}>
              <FolderOpen size={13} aria-hidden />
              选择文件夹
            </button>
          </span>
          <small>员工产生的文件会放在这里。不确定就留空。</small>
        </label>
      </details>
    </section>
  );
}
