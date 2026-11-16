import { CheckCircle2, Info, LoaderCircle, Plug, RefreshCw, Search, Unplug } from 'lucide-react';
import { useState } from 'react';
import { CONNECTOR_CATALOG } from '../../features/enterprise/connector-catalog';
import type { ConnectorDefinition } from '../../features/enterprise/connector-catalog';
import { useConnectors } from '../../features/enterprise/use-connectors';
import '../../styles/connectors.css';

function ConnectorLogo({ connector }: { connector: ConnectorDefinition }): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  return <span className="connector-logo">
    {failed ? <Plug size={25} aria-hidden /> : <img src={connector.logoUrl} alt="" onError={() => setFailed(true)} />}
  </span>;
}

function ConnectorEntry({ connector: selected, query }: { connector: ConnectorDefinition; query: string }): React.JSX.Element | null {
  const connection = useConnectors(selected.id);
  const { state, loading, busy, available } = connection;
  const connected = state.status === 'connected';
  const documentsOnly = connected && (state.coverage === 'documents' || selected.id === 'dingtalk' && !state.coverage);
  const authorizing = state.status === 'authorizing';
  const statusText = !available ? '仅限桌面客户端' : loading ? '加载中' : connection.error ? '状态不可用' : connected ? '已连接' : authorizing ? '授权中' : state.status === 'error' ? '需要重新连接' : '未连接';
  const status = <span className={`connector-status${connected ? ' connected' : ''}`}>{connected ? <CheckCircle2 size={13} aria-hidden /> : authorizing || loading ? <LoaderCircle size={13} className="spin" aria-hidden /> : <Unplug size={13} aria-hidden />}{statusText}</span>;
  if (!`${selected.name} ${selected.category} ${selected.description}`.toLowerCase().includes(query.trim().toLowerCase())) return null;
  const failure = connection.error ? <div className="connector-error" role="alert">{connection.error}<button type="button" className="ent-btn ghost" onClick={() => { void connection.refresh(); }}><RefreshCw size={14} aria-hidden />重试</button></div> : null;
  const providerNotice = selected.id === 'wecom' && connected ? undefined : state.notice;
  const notice = !available ? '请在桌面客户端中连接账号' : state.error || providerNotice || (authorizing ? (state.phase === 'setup' ? `请在浏览器中完成${selected.name}应用配置，随后继续账号授权` : `请在浏览器中完成${selected.name}授权`) : documentsOnly ? '当前仅有文档授权，请升级授权以连接更多业务' : null);
  return <article className="connector-card" aria-label={`${selected.name}连接器`}>
        <div className="connector-card-heading"><ConnectorLogo connector={selected} /><div><h3>{selected.name}</h3><span>{selected.category}</span></div>{status}</div>
        {failure}<p className="connector-card-description">{selected.description}</p>
        <div className="connector-capabilities">{selected.capabilities.slice(0, 4).map(capability => <span key={capability.name}>{capability.name}</span>)}</div>
        {notice ? <p className="connector-notice" role={state.error ? 'alert' : 'status'}><Info size={14} aria-hidden /><span>{notice}</span></p> : null}
        <footer>
          <span>{documentsOnly ? '文档已连接，可升级授权' : connected ? `${selected.name}账号已连接` : authorizing ? '等待浏览器授权' : selected.id === 'wecom' ? '企业微信扫码授权' : '个人账号授权'}</span>
          <div className="connector-actions" role="group" aria-label={`${selected.name}连接操作`}>
            {connected || authorizing ? <button type="button" className="ent-btn ghost" disabled={!available || loading || busy} onClick={() => { void connection.disconnect(); }}><Unplug size={15} aria-hidden />{authorizing ? '取消授权' : '断开连接'}</button> : null}
            {!authorizing ? <button type="button" className="ent-btn" disabled={!available || loading || busy || !selected.authorizationAvailable} onClick={() => { void connection.connect(); }}>{busy ? <LoaderCircle size={15} className="spin" aria-hidden /> : <Plug size={15} aria-hidden />}{documentsOnly ? '升级授权' : connected ? '重新授权' : `连接${selected.name}`}</button> : null}
          </div>
        </footer>
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
