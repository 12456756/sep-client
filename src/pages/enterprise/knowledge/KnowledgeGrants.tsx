import { Plus, Users } from 'lucide-react'
import { useState } from 'react'
import type { KnowledgeBase, KnowledgeGrant, KnowledgeMember } from '../../../shared/knowledge-contracts'
import { grantMemberId, type KnowledgeClient } from '../../../features/knowledge/knowledge-client'
import { useKnowledgeMutation, useKnowledgeQuery } from '../../../features/knowledge/use-knowledge'
import { KnowledgeDialog, KnowledgeErrorNotice, KnowledgePager, KnowledgeSearchForm } from './KnowledgeUI'

function memberName(member: KnowledgeMember): string { return member.name || member.displayName || member.user?.name || member.email || member.user?.email || member.memberId }
function grantName(grant: KnowledgeGrant): string { return grant.member ? memberName(grant.member) : grant.name || grant.displayName || grant.email || grantMemberId(grant) }
export function KnowledgeGrants({ client, base }: { client: KnowledgeClient; base: KnowledgeBase }) {
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [revision, refresh] = useState(0)
  const [adding, setAdding] = useState(false)
  const [revoking, setRevoking] = useState<KnowledgeGrant | null>(null)
  const mutation = useKnowledgeMutation()
  const grants = useKnowledgeQuery(client, { action: 'grants', kbId: base.id, page, pageSize: 20, keyword }, revision)
  return <section className="kb-section" aria-label="成员授权">
    <header className="kb-toolbar"><div><h2>成员授权</h2><p>授权给本企业成员，不绑定员工订阅或部门。</p></div><button className="ent-btn primary" onClick={() => setAdding(true)}><Plus size={15} />添加成员</button></header>
    <KnowledgeSearchForm placeholder="搜索已授权成员" onSearch={value => { setKeyword(value); setPage(1) }} />
    <KnowledgeErrorNotice error={grants.error || mutation.error} onRetry={() => refresh(value => value + 1)} />
    {grants.loading ? <p role="status">正在加载授权成员…</p> : grants.data && !grants.data.items.length ? <div className="kb-empty"><Users size={30} /><p>暂无匹配的授权成员。</p></div> : null}
    <div className="kb-doc-list">{grants.data?.items.map(grant => <article className="kb-doc-row" key={grant.id ?? grantMemberId(grant)}><Users size={19} /><div className="kb-doc-main"><strong>{grantName(grant)}</strong><p>{grant.email ?? grant.member?.email ?? grant.member?.user?.email}</p></div><button className="ent-btn sm kb-danger" disabled={mutation.busy} onClick={() => { mutation.clearError(); setRevoking(grant) }}>撤销授权</button></article>)}</div>
    {grants.data ? <KnowledgePager page={grants.data.page} pageSize={grants.data.pageSize} total={grants.data.total} onChange={setPage} /> : null}
    {adding ? <MemberPicker client={client} base={base} existing={grants.data?.items.map(grantMemberId) ?? []} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(value => value + 1) }} /> : null}
    {revoking ? <KnowledgeDialog title="撤销成员授权" description={`成员：${grantName(revoking)}`} onClose={() => setRevoking(null)} busy={mutation.busy}>
      <p>撤权后该成员无法继续读取此知识库。之前已展示的资料或历史对话不会自动收回。</p><KnowledgeErrorNotice error={mutation.error} />
      <footer><button className="ent-btn" disabled={mutation.busy} onClick={() => setRevoking(null)}>取消</button><button className="ent-btn kb-danger" disabled={mutation.busy} onClick={() => void mutation.perform(async () => { await client.run({ action: 'revoke', kbId: base.id, memberId: grantMemberId(revoking) }); setRevoking(null); refresh(value => value + 1) })}>确认撤权</button></footer>
    </KnowledgeDialog> : null}
  </section>
}
function MemberPicker({ client, base, existing, onClose, onSaved }: { client: KnowledgeClient; base: KnowledgeBase; existing: string[]; onClose(): void; onSaved(): void }) {
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [revision, refresh] = useState(0)
  const members = useKnowledgeQuery(client, { action: 'members', page, pageSize: 20, keyword }, revision)
  const mutation = useKnowledgeMutation()
  return <KnowledgeDialog title="添加授权成员" description="从当前企业有效成员中选择，一次最多授权 100 人。已授权成员由平台去重。" onClose={onClose} busy={mutation.busy}>
    <KnowledgeSearchForm placeholder="搜索企业成员" onSearch={value => { setKeyword(value); setPage(1) }} disabled={mutation.busy} />
    <KnowledgeErrorNotice error={members.error || mutation.error} onRetry={() => refresh(value => value + 1)} />
    {members.loading ? <p role="status">正在加载成员…</p> : null}
    <div className="kb-member-picker">{members.data?.items.map(member => {
      const granted = existing.includes(member.memberId)
      return <label key={member.memberId}><input type="checkbox" disabled={mutation.busy || granted || selected.length >= 100 && !selected.includes(member.memberId)} checked={granted || selected.includes(member.memberId)} onChange={event => setSelected(ids => event.target.checked ? [...ids, member.memberId] : ids.filter(id => id !== member.memberId))} /><span><strong>{memberName(member)}</strong><small>{member.email ?? member.user?.email}</small></span>{granted ? <small>已授权</small> : null}</label>
    })}</div>
    {members.data && !members.data.items.length ? <p>没有匹配的成员。</p> : null}
    {members.data ? <KnowledgePager page={members.data.page} pageSize={members.data.pageSize} total={members.data.total} disabled={mutation.busy} onChange={setPage} /> : null}
    <footer><span>已选择 {selected.length} 人</span><button className="ent-btn" disabled={mutation.busy} onClick={onClose}>取消</button><button className="ent-btn primary" disabled={mutation.busy || !selected.length} onClick={() => void mutation.perform(async () => { await client.run({ action: 'grant', kbId: base.id, memberIds: selected }); onSaved() })}>{mutation.busy ? '正在授权…' : '确认授权'}</button></footer>
  </KnowledgeDialog>
}
