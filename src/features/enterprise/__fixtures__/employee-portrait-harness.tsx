import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EmployeePortrait } from '../../../components/enterprise/EmployeePortrait';
import { AvailabilityChip } from '../../../components/enterprise/atoms';
import { EMPLOYEE_AVAILABILITY } from '../vocabulary';
import type { EmployeeAvailability, SiliconEmployee } from '../types';
import '../../../index.css';
import '../../../styles/enterprise.css';
import '../../../styles/employees.css';

const states: EmployeeAvailability[] = ['ready', 'working', 'unavailable', 'needs-auth'];
const employee: SiliconEmployee = {
  id: 'employee-2', name: '运营顾问', avatar: '/__employee_portrait_fixture__/unused.png', avatarAsset: null,
  mark: '员', roleName: '', department: null, availability: 'ready', assignedToMe: true,
  intro: '', goodAt: [], cannotDo: [], lastWorkedAt: null, allowedModels: [], skillIds: [], permissions: [], templateVersion: '',
};
const descriptions = ['抬手打招呼，准备交流', '低头操作电脑，专注工作', '屏幕休眠，双臂自然放低', '展示确认文件，抬手示意'];

function Harness() {
  const [dark, setDark] = useState(false);
  const [pose, setPose] = useState<EmployeeAvailability>('ready');
  return <main className={`ent-shell${dark ? ' dark' : ''}`} style={{ display: 'block', height: 'auto', minHeight: '100vh', padding: '32px 24px', background: 'var(--ent-canvas)', color: 'var(--ent-ink)' }}>
    <style>{`
      .portrait-review-header { display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin-bottom:32px; }
      .portrait-review-grid { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px 12px; }
      .portrait-review-grid figure { display:flex;flex-direction:column;align-items:center;gap:12px;margin:0;text-align:center; }
      .portrait-review-grid .employee-portrait { height:240px;max-height:240px;max-width:200px; }
      .portrait-review-grid figcaption { color:var(--ent-ink-3);font-size:12px; }
      .portrait-review-live { display:flex;align-items:center;gap:24px;margin-top:32px; }
      .portrait-review-live .employee-portrait { width:150px;height:180px; }
      @media(max-width:680px){.portrait-review-grid{grid-template-columns:repeat(2,minmax(0,1fr));}.portrait-review-grid .employee-portrait{height:210px;}}
    `}</style>
    <header className="portrait-review-header"><div><h1 style={{ fontSize: 22, margin: '0 0 8px' }}>柔和立体数字伙伴 · 四种状态</h1><p style={{ margin: 0, color: 'var(--ent-ink-3)', fontSize: 13 }}>每位员工拥有固定配色与表情，真实状态决定工作动作。</p></div><button type="button" className="ent-btn" onClick={() => setDark(value => !value)}>切换主题</button></header>
    <section className="portrait-review-grid" aria-label="四种员工状态">
      {states.map((availability, index) => <figure key={availability}><AvailabilityChip value={availability} /><EmployeePortrait employee={{ ...employee, availability }} /><figcaption>{descriptions[index]}</figcaption></figure>)}
    </section>
    <h2 style={{ fontSize: 17, margin: '40px 0 20px' }}>新增员工自动获得不同形象</h2>
    <section className="portrait-review-grid" aria-label="不同员工形象">
      {Array.from({ length: 8 }, (_, index) => <figure key={index}><EmployeePortrait employee={{ ...employee, id: `employee-${index + 1}`, name: `员工 ${index + 1}` }} /><figcaption>员工 {index + 1}</figcaption></figure>)}
    </section>
    <section className="portrait-review-live" aria-label="动态状态预览"><label>员工姿势 <select className="ent-select" aria-label="员工姿势" value={pose} onChange={event => setPose(event.target.value as EmployeeAvailability)}>{states.map(state => <option key={state} value={state}>{EMPLOYEE_AVAILABILITY[state].label}</option>)}</select></label><div data-testid="live-portrait"><EmployeePortrait employee={{ ...employee, availability: pose }} /></div></section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Harness />);
