import { useState } from 'react'
import { Download, LoaderCircle } from 'lucide-react'
import type { ElectronAPI } from '../../shared/ipc'

export function DiagnosticExport({ input, onExport }: {
  input: Parameters<ElectronAPI['exportWorkDiagnostic']>[0]; onExport: ElectronAPI['exportWorkDiagnostic']
}) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed' | 'missing'>('idle')
  async function save() {
    setState('saving')
    try {
      const result = await onExport(input)
      setState(result.success ? result.cancelled ? 'idle' : 'saved' : result.error?.code === 'NOT_FOUND' ? 'missing' : 'failed')
    } catch { setState('failed') }
  }
  return <div className="ent-transcript-diagnostic">
    <button type="button" className="ent-btn sm ghost" disabled={state === 'saving'} aria-busy={state === 'saving'} onClick={() => void save()}>
      {state === 'saving' ? <LoaderCircle size={14} className="ent-spin" aria-hidden /> : <Download size={14} aria-hidden />}
      导出本次诊断
    </button>
    {state === 'saved' ? <small role="status">诊断文件已保存</small> : null}
    {state === 'failed' || state === 'missing' ? <small role="alert">{state === 'missing' ? '本次诊断记录不再可用。' : '诊断导出失败，请检查保存位置或重新登录。'}</small> : null}
  </div>
}
