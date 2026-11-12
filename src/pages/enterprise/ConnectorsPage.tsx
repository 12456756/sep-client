import { ArrowLeft, ArrowUpRight, CheckCircle2, FileText, Info, LoaderCircle, Plug, RefreshCw, Search, Unplug } from 'lucide-react';
import { useState } from 'react';
import { CONNECTOR_CATALOG } from '../../features/enterprise/connector-catalog';
import type { ConnectorDefinition } from '../../features/enterprise/connector-catalog';
import type { ConnectorId } from '../../shared/connectors';
import { useConnectors } from '../../features/enterprise/use-connectors';
import '../../styles/connectors.css';

function ConnectorLogo({ connector }: { connector: ConnectorDefinition }): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  return <span className="connector-logo">
    {failed ? <Plug size={25} aria-hidden /> : <img src={connector.logoUrl} alt="" onError={() => setFailed(true)} />}
  </span>;
}

function ConnectorEntry({ connector: selected, selectedId, query, onSelect }: { connector: ConnectorDefinition; selectedId: ConnectorId | null; query: string; onSelect(id: ConnectorId | null): void }): React.JSX.Element | null {
  const connection = useConnectors(selected.id);
  const { state, loading, busy, available } = connection;
  const connected = state.status === 'connected';
  const documentsOnly = connected && state.coverage !== 'workspace';
  const authorizing = state.status === 'authorizing';
  const statusText = !available ? '仅限桌面客户端' : loading ? '加载中' : connection.error ? '状态不可用' : connected ? '已连接' : authorizing ? '授权中' : state.status === 'error' ? '需要重新连接' : '未连接';
  const status = <span className={`connector-status${connected ? ' connected' : ''}`}>{connected ? <CheckCircle2 size={13} aria-hidden /> : authorizing || loading ? <LoaderCircle size={13} className="spin" aria-hidden /> : <Unplug size={13} aria-hidden />}{statusText}</span>;
  if (selectedId !== null && selectedId !== selected.id || selectedId === null && !`${selected.name} ${selected.category} ${selected.description}`.toLowerCase().includes(query.trim().toLowerCase())) return null;
  const failure = connection.error ? <div className="connector-error" role="alert">{connection.error}<button type="button" className="ent-btn ghost" onClick={() => { void connection.refresh(); }}><RefreshCw size={14} aria-hidden />重试</button></div> : null;
  if (selectedId) return <>
    {failure}
      <section className="connector-detail" aria-label={`${selected.name}连接器详情`}>
        <div className="connector-detail-heading">
          <ConnectorLogo connector={selected} />
          <div><h2>{selected.name}</h2><p>{selected.category} · {selected.description}</p></div>
          {status}
        </div>
        <div className="connector-account"><span>连接账号</span><strong>{connected ? `已授权${selected.name}账号` : statusText}</strong>{state.connectedAt && connected ? <span>连接于 {new Date(state.connectedAt).toLocaleString('zh-CN')}</span> : null}</div>
        <h3>支持的业务</h3>
        <ul className="connector-permissions">{selected.capabilities.map(capability => <li key={capability.name}><FileText size={17} aria-hidden /><div><strong>{capability.name}</strong><p>{capability.description}</p></div></li>)}</ul>
        <div className="connector-authorization">
          <p role="status"><Info size={16} aria-hidden />{!available ? '请在桌面客户端中连接账号' : state.error || state.notice || (authorizing ? (state.phase === 'setup' ? `请在浏览器中完成${selected.name}应用配置，随后继续账号授权` : `请在浏览器中完成${selected.name}授权`) : documentsOnly ? '当前仅有文档授权，请升级授权以连接更多业务' : connected ? `已连接，实际可用范围以${selected.name}账号权限和业务授权为准` : `使用自己的${selected.name}账号授权，实际可用范围以账号权限为准`)}</p>
          <div className="connector-actions">
            {connected || authorizing ? <button type="button" className="ent-btn" disabled={busy} onClick={() => { void connection.disconnect(); }}><Unplug size={15} aria-hidden />{authorizing ? '取消授权' : '断开连接'}</button> : null}
            {!authorizing ? <button type="button" className="ent-btn primary" disabled={!available || loading || busy || !selected.authorizationAvailable} onClick={() => { void connection.connect(); }}>{busy ? <LoaderCircle size={15} className="spin" aria-hidden /> : <Plug size={15} aria-hidden />}{documentsOnly ? '升级授权' : connected ? '重新授权' : `连接${selected.name}`}</button> : null}
          </div>
        </div>
      </section>
  </>;
  return <article className="connector-card" key={selected.id}>
        <div className="connector-card-heading"><ConnectorLogo connector={selected} /><div><h3>{selected.name}</h3><span>{selected.category}</span></div>{status}</div>
        {failure}<p className="connector-card-description">{selected.description}</p>
        <div className="connector-capabilities">{selected.capabilities.slice(0, 4).map(capability => <span key={capability.name}>{capability.name}</span>)}</div>
        <footer><span>{documentsOnly ? '文档已连接，可升级授权' : connected ? `${selected.name}账号已连接` : authorizing ? '等待浏览器授权' : '个人账号授权'}</span><button type="button" className="ent-btn ghost" onClick={() => onSelect(selected.id)}>{connected ? '管理连接' : '查看详情'}<ArrowUpRight size={15} aria-hidden /></button></footer>
      </article>;
}

export function ConnectorsPage(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<ConnectorId | null>(null);
  const filtered = CONNECTOR_CATALOG.filter(connector => `${connector.name} ${connector.category} ${connector.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <main className="ent-page connectors-page">
    <header className="connectors-heading"><h1>连接器</h1></header>
    {selectedId ? <button type="button" className="ent-btn ghost connector-back" onClick={() => setSelectedId(null)}><ArrowLeft size={15} aria-hidden />全部连接器</button> : <div className="connectors-toolbar">
      <h2>全部连接器 <span>{CONNECTOR_CATALOG.length}</span></h2>
      <label className="connectors-search"><Search size={16} aria-hidden /><input type="search" aria-label="搜索连接器" placeholder="搜索连接器" value={query} onChange={event => setQuery(event.target.value)} /></label>
    </div>}
    <div className={selectedId ? undefined : 'connectors-grid'}>{CONNECTOR_CATALOG.map(connector => <ConnectorEntry key={connector.id} connector={connector} selectedId={selectedId} query={query} onSelect={setSelectedId} />)}</div>
    {!selectedId && !filtered.length ? <div className="connectors-empty" role="status"><Search size={26} aria-hidden /><h3>没有找到匹配的连接器</h3><button type="button" className="ent-btn ghost" onClick={() => setQuery('')}>清除搜索</button></div> : null}
  </main>;
}
