import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, Check, CheckCircle2, CircleHelp, FolderPlus, KeyRound, LoaderCircle, LockKeyhole, MonitorDown, RefreshCw, ShieldCheck, X } from 'lucide-react'
import type { z } from 'zod'
import { type SkillImportConsentInputSchema, type SkillImportStateView } from '../shared/skill-import-contracts'
type SkillImportConsentInput = z.infer<typeof SkillImportConsentInputSchema>

type ConsentInput = SkillImportConsentInput
export interface SkillImportPageProps {
  state: SkillImportStateView
  onClose: () => void
  onConfirm: (input: ConsentInput) => void
  onSelectRoot: () => void
  onRemoveRoot: (rootId: string) => void
  onCancel: () => void
  onRevoke: (deviceId: string, instanceId: string) => void
  onCheckForUpdate: () => void
  busy?: boolean
  error?: string | null
}

const phaseLabels: Record<string, string> = {
  idle: '等待网页发起', 'awaiting-local-consent': '等待本机授权', busy: '已有导入正在进行', error: '需要处理的问题',
  'waiting-web-confirmation': '等待网页确认', connecting: '连接 SEP', 'waiting-client': '等待客户端', pairing: '确认设备',
  ready: '准备扫描', scanning: '扫描中', results: '等待网页选择', previewing: '读取预览', packaging: '整理文件',
  uploading: '上传中', uploaded: '文件已传送', cancelled: '已取消', expired: '会话已过期', failed: '导入失败',
}
const consentPhases = new Set(['awaiting-local-consent', 'pairing'])
const activePhases = new Set(['waiting-web-confirmation', 'connecting', 'waiting-client', 'ready', 'scanning', 'results', 'previewing', 'packaging', 'uploading'])

export function SkillImportPage(props: SkillImportPageProps) {
  const { state } = props
  const sessionKey = JSON.stringify([state.instanceId, state.sessionId, state.pairing?.pairingId, state.scope])
  return <SkillImportSessionPage key={sessionKey} {...props} />
}

function SkillImportSessionPage({ state, onClose, onConfirm, onSelectRoot, onRemoveRoot, onCancel, onRevoke, onCheckForUpdate, busy = false, error }: SkillImportPageProps) {
  void React
  const logoImage = new URL('../assets/logo.png', import.meta.url).href
  const [rememberDevice, setRememberDevice] = useState(false)
  const availableRoots = useMemo(() => state.roots.filter(root => state.scope === 'all' || root.scope === state.scope), [state.roots, state.scope])
  const scope = state.scope ?? 'user'
  const [selectedRoots, setSelectedRoots] = useState<string[]>(() => availableRoots.map(root => root.rootId))
  const [showDevices, setShowDevices] = useState(false)
  const activeJob = activePhases.has(state.phase)
  const confirming = consentPhases.has(state.phase)
  const selectedRootsValid = selectedRoots.every(id => availableRoots.some(root => root.rootId === id))
  const canConfirm = !busy && !activeJob && confirming && !!state.pairing && !!state.scope && selectedRootsValid
    && (scope === 'user' || state.scope === 'project' || state.scope === 'all')
    && (scope !== 'all' || state.scope === 'all')
    && availableRoots.some(root => selectedRoots.includes(root.rootId))

  useEffect(() => {
    setSelectedRoots(current => {
      const remaining = current.filter(id => availableRoots.some(root => root.rootId === id))
      return remaining.length === current.length ? current : remaining
    })
  }, [availableRoots])

  const toggleRoot = (rootId: string) => setSelectedRoots(current => current.includes(rootId) ? current.filter(id => id !== rootId) : [...current, rootId])
  const confirm = () => {
    if (!canConfirm || !state.pairing) return
    onConfirm({ pairingId: state.pairing.pairingId, rememberDevice: rememberDevice && state.persistenceAvailable, scope, rootIds: [...selectedRoots].sort() })
  }

  return <main className="skill-import-page">
    <header className="skill-import-topbar">
      <div className="skill-import-brand"><img src={logoImage} alt="" /><span>硅基员工平台</span><i /><span>本机 Skills 导入</span></div>
      <div className="skill-import-top-actions">
        <button type="button" className="skill-import-icon-button" onClick={onCheckForUpdate} title="检查更新" aria-label="检查更新"><RefreshCw size={16} /></button>
        <button type="button" className="skill-import-icon-button" onClick={() => setShowDevices(value => !value)} title="设备授权管理" aria-label="设备授权管理"><KeyRound size={16} /></button>
        <button type="button" className="skill-import-icon-button" onClick={onClose} title="返回工作区" aria-label="返回工作区"><X size={17} /></button>
      </div>
    </header>

    <div className="skill-import-content">
      <header className="skill-import-heading">
        <div><p className="skill-import-kicker">本机文件权限</p><h1>Skills 导入</h1></div>
        <span className={`skill-import-phase phase-${state.phase}`}><i />{phaseLabels[state.phase] ?? state.phase}</span>
      </header>

      {(error || state.error) && <div className="skill-import-alert" role="alert"><AlertTriangle size={17} /><span>{error || state.error?.message}</span></div>}
      {state.busySessionId && state.busySessionId !== state.sessionId && <div className="skill-import-alert" role="status"><CircleHelp size={17} /><span>另一导入会话正在运行。请回到网页重试。</span></div>}

      <section className="skill-import-context" aria-label="导入请求">
        <div className="skill-import-context-icon"><ShieldCheck size={20} /></div>
        <div className="skill-import-context-copy">
          <strong>{state.siteLabel || '等待 SEP 网页连接'}</strong>
          <span>{state.initiatorLabel ? `${state.initiatorLabel} 发起了本次扫描` : '网页连接后会显示发起人和扫描范围'}</span>
        </div>
        {state.sessionId && <code title="会话编号">{state.sessionId.slice(0, 12)}</code>}
      </section>

      {confirming && <section className="skill-import-section">
        <div className="skill-import-section-title"><div><h2>确认扫描范围</h2><p>选择本次会话允许访问的 Skills 目录</p></div><span className="skill-import-request-scope">网页请求：{state.scope ?? '待确认'}</span></div>
        {state.pairing && <div className="skill-import-pairing"><span>网页核对码</span><strong aria-label={`配对码 ${state.pairing.shortCode}`}>{state.pairing.shortCode}</strong><small>{state.pairing.webConfirmed ? '网页已确认此设备' : '请与发起网页核对设备和短码'}</small></div>}
        <div className="skill-import-root-list">
          {availableRoots.map(root => <label className="skill-import-root" key={root.rootId}>
            <input type="checkbox" checked={selectedRoots.includes(root.rootId)} onChange={() => toggleRoot(root.rootId)} disabled={busy || activeJob} />
            <span className="skill-import-checkbox"><Check size={12} /></span>
            <span className="skill-import-root-copy"><strong>{root.label}</strong><small>{root.scope === 'project' ? '项目 Skills' : '个人 Skills'}</small></span>
            <button type="button" aria-label={`移除${root.label}`} title="撤销此目录授权" onClick={event => { event.preventDefault(); onRemoveRoot(root.rootId) }}><X size={15} /></button>
          </label>)}
          {availableRoots.length === 0 && <p className="skill-import-empty-roots">尚未授权扫描目录</p>}
        </div>
        <button type="button" className="skill-import-secondary skill-import-add-root" onClick={onSelectRoot} disabled={busy || activeJob}><FolderPlus size={16} />添加项目或自定义目录</button>
        <div className="skill-import-scope-row"><span>本次请求范围</span><strong>{scope === 'user' ? '个人' : scope === 'project' ? '项目' : '全部已授权'}</strong></div>
        <label className="skill-import-remember"><input type="checkbox" checked={rememberDevice} onChange={event => setRememberDevice(event.target.checked)} disabled={busy || activeJob || !state.persistenceAvailable} /><span><strong>记住此设备授权</strong><small>{state.persistenceAvailable ? '仅对该站点、账号和已选范围有效' : '系统安全存储不可用，本次只能临时授权'}</small></span><LockKeyhole size={15} /></label>
        <button type="button" className="skill-import-primary" onClick={confirm} disabled={!canConfirm}><ShieldCheck size={17} />允许并开始扫描</button>
        <button type="button" className="skill-import-secondary skill-import-cancel-consent" onClick={onCancel} disabled={busy}><X size={16} />取消本次导入</button>
      </section>}

      {activeJob && <section className="skill-import-progress" role="status">
        <div className="skill-import-progress-icon"><LoaderCircle size={22} className="spin" /></div><div className="skill-import-progress-copy"><strong>{phaseLabels[state.phase]}</strong><span>{state.progress ? `${state.progress.completed}${state.progress.total ? ` / ${state.progress.total}` : ''}` : '正在等待本机处理'}</span></div>
        {state.progress?.total ? <progress max={state.progress.total} value={state.progress.completed} /> : <div className="skill-import-progress-indeterminate" />}
        <button type="button" className="skill-import-secondary" onClick={onCancel} disabled={busy}>取消本次导入</button>
      </section>}

      {state.phase === 'uploaded' && <section className="skill-import-complete" role="status"><CheckCircle2 size={30} /><div><h2>文件已传送</h2><p>请回到网页完成创建和提交审核。</p></div><button type="button" className="skill-import-secondary" onClick={onClose}><ArrowLeft size={16} />返回工作区</button></section>}
      {['failed', 'expired', 'cancelled', 'error'].includes(state.phase) && <section className="skill-import-recovery"><p>{state.phase === 'expired' ? '网页会话已过期，请返回网页重新发起扫描。' : state.error?.message || '本次导入未完成。'}</p><button type="button" className="skill-import-secondary" onClick={onClose}><ArrowLeft size={16} />返回</button></section>}
      {!confirming && !activeJob && !['uploaded', 'failed', 'expired', 'cancelled', 'error'].includes(state.phase) && <section className="skill-import-waiting"><MonitorDown size={27} /><strong>{phaseLabels[state.phase] ?? '等待网页发起扫描'}</strong><span>从 SEP 网页点击“扫描本机”后，此处会显示授权请求。</span></section>}

      {showDevices && <section className="skill-import-devices"><div className="skill-import-section-title"><div><h2>设备授权</h2><p>已记住的站点设备与本机授权</p></div></div>{state.devices.length ? state.devices.map(device => <div className="skill-import-device" key={`${device.instanceId}-${device.deviceId}`}><span><strong>{device.label}</strong><small>{device.instanceId} · {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleDateString() : '未连接'}{device.revocationPending ? ' · 等待云端撤销' : ''}</small></span><button type="button" className="skill-import-secondary" onClick={() => onRevoke(device.deviceId, device.instanceId)} disabled={busy}>{device.revocationPending ? '重试撤销' : '撤销'}</button></div>) : <p className="skill-import-empty-roots">暂无已记住的设备授权</p>}</section>}

      {state.phase === 'waiting-client' && <button type="button" className="skill-import-secondary skill-import-update" onClick={onCheckForUpdate}><MonitorDown size={16} />检查客户端更新</button>}
      <footer className="skill-import-footer"><ShieldCheck size={14} /><span>仅读取你本次明确授权的目录，源文件不会被修改。<br />客户端 {state.clientVersion || '-'} · 导入协议 v{state.protocolVersion}</span></footer>
    </div>
  </main>
}

export default SkillImportPage
