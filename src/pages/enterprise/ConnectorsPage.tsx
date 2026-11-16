import { CheckCircle2, Info, LoaderCircle, Plug, RefreshCw, Search, Unplug } from 'lucide-react';
import { useRef, useState } from 'react';
import { CONNECTOR_CATALOG } from '../../features/enterprise/connector-catalog';
import type { ConnectorDefinition } from '../../features/enterprise/connector-catalog';
import { useConnectors } from '../../features/enterprise/use-connectors';
import { connectorPreparationText } from '../../features/enterprise/connector-preparation';
import { QQMailConnectDialog } from '../../components/enterprise/QQMailConnectDialog';
import '../../styles/connectors.css';

function ConnectorLogo({ connector }: { connector: ConnectorDefinition }): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  return <span className="connector-logo">
    {failed ? <Plug size={25} aria-hidden /> : <img src={connector.logoUrl} alt="" onError={() => setFailed(true)} />}
  </span>;
}

function ConnectorEntry({ connector: selected, query }: { connector: ConnectorDefinition; query: string }): React.JSX.Element | null {
  const connection = useConnectors(selected.id);
  const [mailOpen, setMailOpen] = useState(false);
  const connectButton = useRef<HTMLButtonElement>(null);
  const { state, loading, busy, available } = connection;
  const connected = state.status === 'connected';
  const documentsOnly = connected && selected.id === 'dingtalk' && (!state.coverage || state.coverage === 'documents');
  const authorizing = state.status === 'authorizing';
  const preparing = state.status === 'preparing';
  const preparationText = connectorPreparationText(state);
  const statusText = !available ? '仅限桌面客户端' : loading ? '加载中' : connection.error ? '状态不可用' : connected ? '已连接' : preparing ? '准备中' : authorizing ? '授权中' : state.status === 'error' ? '连接失败' : '未连接';
  const status = <span className={`connector-status${connected ? ' connected' : ''}`}>{connected ? <CheckCircle2 size={13} aria-hidden /> : preparing || authorizing || loading ? <LoaderCircle size={13} className="spin" aria-hidden /> : <Unplug size={13} aria-hidden />}{statusText}</span>;
  if (!`${selected.name} ${selected.category} ${selected.description}`.toLowerCase().includes(query.trim().toLowerCase())) return null;
  const failure = connection.error && !mailOpen ? <div className="connector-error" role="alert">{connection.error}<button type="button" className="ent-btn ghost" onClick={() => { void connection.refresh(); }}><RefreshCw size={14} aria-hidden />重试</button></div> : null;
  const providerNotice = selected.id === 'kdocs' ? state.notice || '支持 WPS 个人账号；企业账号请使用 WPS 365' : selected.id === 'wecom' && connected ? undefined : state.notice;
  const notice = mailOpen ? null : !available ? '请在桌面客户端中连接账号' : preparationText || state.error || providerNotice || (authorizing ? (selected.id === 'qqmail' ? '正在验证邮箱收发服务' : state.phase === 'setup' ? `请在浏览器中完成${selected.name}应用配置，随后继续账号授权` : `请在浏览器中完成${selected.name}授权`) : documentsOnly ? '当前仅有文档授权，请升级授权以连接更多业务' : null);
  return <article className="connector-card" aria-label={`${selected.name}连接器`}>
        <div className="connector-card-heading"><ConnectorLogo connector={selected} /><div><h3>{selected.name}</h3><span>{selected.category}</span></div>{status}</div>
        {failure}<p className="connector-card-description">{selected.description}</p>
        <div className="connector-capabilities">{selected.capabilities.slice(0, 4).map(capability => <span key={capability.name}>{capability.name}</span>)}</div>
        {notice ? <p className="connector-notice" role={state.error ? 'alert' : 'status'}><Info size={14} aria-hidden /><span>{notice}</span></p> : null}
        {preparing && state.dependency ? <progress className="connector-progress" aria-label={`${selected.name}组件下载进度`} value={state.dependency.received} max={state.dependency.total} /> : null}
        <footer>
          <span>{preparing ? '准备连接器组件' : documentsOnly ? '文档已连接，可升级授权' : connected ? (selected.id === 'qqmail' && state.accountLabel) || `${selected.name}账号已连接` : selected.id === 'qqmail' ? authorizing ? '验证邮箱中' : '邮箱授权码连接' : authorizing ? '等待浏览器授权' : selected.id === 'wecom' ? '企业微信扫码授权' : '个人账号授权'}</span>
          <div className="connector-actions" role="group" aria-label={`${selected.name}连接操作`}>
            {connected || authorizing || preparing ? <button type="button" className="ent-btn ghost" disabled={!available || loading || busy} onClick={() => { void connection.disconnect(); }}><Unplug size={15} aria-hidden />{preparing ? '取消准备' : authorizing ? '取消授权' : '断开连接'}</button> : null}
            {!preparing && (!authorizing || mailOpen) ? <button ref={connectButton} type="button" className="ent-btn" disabled={!available || loading || busy || !selected.authorizationAvailable} onClick={() => { if (selected.id === 'qqmail') setMailOpen(true); else void connection.connect(); }}>{busy ? <LoaderCircle size={15} className="spin" aria-hidden /> : <Plug size={15} aria-hidden />}{documentsOnly ? '升级授权' : connected ? '重新授权' : state.status === 'error' ? '重试连接' : `连接${selected.name}`}</button> : null}
          </div>
        </footer>
        {mailOpen ? <QQMailConnectDialog busy={busy} error={connection.error} account={state.accountLabel} onConnect={connection.connect} onClose={() => setMailOpen(false)} restoreFocus={() => connectButton.current?.focus()} /> : null}
      </article>;
}

export function ConnectorsPage(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const filtered = CONNECTOR_CATALOG.filter(connector => `${connector.name} ${connector.category} ${connector.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <main className="ent-page connectors-page">
    <header className="connectors-heading"><h1>连接器</h1></header>
    <div className="connectors-toolbar">
      <h2>全部连接器 <span>{CONNECTOR_CATALOG.length}</span></h2>
      <label className="connectors-search"><Search size={16} aria-hidden /><input type="search" aria-label="搜索连接器" placeholder="搜索连接器" value={query} onChange={event => setQuery(event.target.value)} /></label>
    </div>
    <div className="connectors-grid">{CONNECTOR_CATALOG.map(connector => <ConnectorEntry key={connector.id} connector={connector} query={query} />)}</div>
    {!filtered.length ? <div className="connectors-empty" role="status"><Search size={26} aria-hidden /><h3>没有找到匹配的连接器</h3><button type="button" className="ent-btn ghost" onClick={() => setQuery('')}>清除搜索</button></div> : null}
  </main>;
}
