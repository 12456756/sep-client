import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import { mediaIssueMessage, mediaSpecFailureMessage } from './media-feedback'

it('explains specification failures instead of reporting unavailable employees or missing permissions', () => {
  const job = { generationStatus: 'FAILED', trackingStatus: 'STOPPED' as const, saveStatus: 'PENDING' as const }
  assert.match(mediaIssueMessage({ ...job, error: 'MISSING_SPEC' }, 'video')!, /规格尚未确定/)
  assert.match(mediaIssueMessage({ ...job, error: 'PRICE_UNAVAILABLE' }, 'image')!, /可靠报价/)
  assert.match(mediaIssueMessage({ ...job, error: 'OUTPUT_SPEC_MISMATCH' }, 'video')!, /实际产物/)
})

it('shows the safe failure source, field and suggested specifications without free-form upstream text', () => {
  const message = mediaSpecFailureMessage({ code: 'UPSTREAM_SPEC_UNSUPPORTED', message: 'secret upstream body',
    field: 'requestedSpec.durationSeconds', requestedValue: 8, source: 'provider', reasonCode: 'UNSUPPORTED_DURATION', alternatives: [{ durationSeconds: 6 }] })!
  assert.match(message, /上游模型/)
  assert.match(message, /时长.*8/)
  assert.match(message, /6/)
  assert.doesNotMatch(message, /secret upstream/)
  assert.equal(mediaSpecFailureMessage({ code: 'UNKNOWN', message: 'private' }), null)
})

it('preserves uncertain submission and never echoes raw supplier errors', () => {
  const job = { generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED' as const, saveStatus: 'PENDING' as const, error: 'INSUFFICIENT_FUNDS' }
  assert.equal(mediaIssueMessage(job, 'video'), '视频提交结果尚未确认；已知异常：当前账号可用资金不足；请查询原任务，勿重复提交')
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'FAILED', trackingStatus: 'STOPPED' }, 'video'), '当前账号可用资金不足，请联系企业管理员补充资金后重试。')
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'FAILED', error: 'secret token /private/file' }, 'image'), '图片任务跟踪已中断，尚未确认原任务的最新状态，请恢复原任务跟踪，勿重复生成。')
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', error: null }, 'image'), null)
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'FAILED', error: '__proto__' }, 'image'), '图片任务跟踪已中断，尚未确认原任务的最新状态，请恢复原任务跟踪，勿重复生成。')
  assert.equal(mediaIssueMessage({ ...job, generationStatus: 'SUCCEEDED', error: 'RESULT_EXPIRED' }, 'image'), '图片结果已过期，无法重新下载')
})

it('shows the observed failure alongside uncertainty without suggesting another paid request', () => {
  for (const kind of ['image', 'video'] as const) {
    const message = mediaIssueMessage({ generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED', saveStatus: 'PENDING', error: 'SERVICE_UNAVAILABLE',
      failure: { code: 'SERVICE_UNAVAILABLE', businessCode: 'UPSTREAM_TIMEOUT', stage: `${kind}-submit`, source: 'upstream', httpStatus: 503, requestId: 'req-123' } }, kind)!
    assert.match(message, /提交结果尚未确认.*提交.*生成供应商响应超时.*勿重复提交/)
    assert.doesNotMatch(message, /UPSTREAM_TIMEOUT|HTTP|req-123/)
    assert.doesNotMatch(message, /请重新发起|稍后重试|未扣费|未受理/)
  }
  const timeout = mediaIssueMessage({ generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED', saveStatus: 'PENDING', error: 'NETWORK_TIMEOUT' }, 'image')!
  assert.match(timeout, /请求超时/)
})

it('does not advise querying when the original unconfirmed submission cannot be queried', () => {
  for (const flags of [{ error: 'QUERY_UNAVAILABLE' }, { error: 'NETWORK_TIMEOUT', canResumeTracking: false }]) {
    const message = mediaIssueMessage({ generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'STOPPED', saveStatus: 'PENDING', ...flags }, 'image')!
    assert.match(message, /提交结果尚未确认.*当前无法查询原任务.*平台管理员.*勿重复提交/)
    assert.doesNotMatch(message, /；请查询原任务|下载失败|未扣费/)
  }
})

it('explains an unavailable upstream service without losing submission and recovery uncertainty', () => {
  for (const kind of ['image', 'video'] as const) {
    for (const message of ['Upstream service temporarily unavailable', 'Service unavailable.', 'Provider service is temporarily unavailable!']) {
      const text = mediaIssueMessage({ generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'STOPPED', saveStatus: 'PENDING',
        error: 'QUERY_UNAVAILABLE', canResumeTracking: false,
        failure: { code: 'SERVICE_UNAVAILABLE', stage: `${kind}-submit`, source: 'upstream', httpStatus: 502,
          requestId: 'private-request-id', message } }, kind)!
      assert.match(text, /提交结果尚未确认.*提交：生成供应商服务暂时不可用.*当前无法查询原任务.*平台管理员.*勿重复提交/)
      assert.doesNotMatch(text, /Upstream|Provider|HTTP|502|private-request-id|SERVICE_UNAVAILABLE/)
      assert.doesNotMatch(text, /尚未提供可识别|未扣费|未受理|稍后重试|规格.*不支持|响应超时|繁忙/)
    }
  }
})

it('shows unknown safe receipt codes and per-output failures without reflecting arbitrary strings', () => {
  const base = { generationStatus: 'PARTIAL_SUCCEEDED', trackingStatus: 'STOPPED' as const, saveStatus: 'PENDING' as const, error: null }
  assert.match(mediaIssueMessage({ ...base, outputErrors: [{ index: 1, code: 'CONTENT_REJECTED' }] }, 'image')!, /第 2 项：生成内容被审核拒绝/)
  assert.match(mediaIssueMessage({ ...base, generationStatus: 'FAILED', error: 'PROVIDER_QUOTA_EXHAUSTED' }, 'video')!, /生成供应商账号额度已耗尽/)
  assert.doesNotMatch(mediaIssueMessage({ ...base, error: 'secret token /private/file' }, 'image')!, /secret|private/)
})

it('retains a redacted upstream explanation without hiding uncertainty', () => {
  const message = mediaIssueMessage({ generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED', saveStatus: 'PENDING', error: 'SERVICE_UNAVAILABLE',
    failure: { code: 'SERVICE_UNAVAILABLE', stage: 'image-submit', source: 'upstream', message: 'Supplier account disabled' } }, 'image')!
  assert.match(message, /提交结果尚未确认.*生成供应商账号已停用.*勿重复提交/)
  assert.doesNotMatch(message, /Supplier account disabled/)
  assert.match(mediaIssueMessage({ generationStatus: 'FAILED', trackingStatus: 'STOPPED', saveStatus: 'PENDING', error: 'MEDIA_FORBIDDEN' }, 'image')!, /图片生成权限/)
})

it('explains local save errors using safe native codes', () => {
  const message = mediaIssueMessage({ generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: 'SAVE_FAILED', error: 'VIDEO_SAVE_FAILED',
    failure: { code: 'INTERNAL_ERROR', stage: 'video-save', reasonCode: 'ENOSPC' } }, 'video')!
  assert.match(message, /视频保存.*磁盘空间不足.*清理磁盘空间.*重新保存原结果.*勿重复生成/)
  assert.doesNotMatch(message, /ENOSPC|INTERNAL_ERROR/)
})

it('uses specific gateway reasons instead of the generic service code', () => {
  for (const [gatewayCode, expected] of [
    ['IMAGE_INVALID_RESPONSE', /图片服务返回的数据不完整/],
    ['VIDEO_REDIRECT_BLOCKED', /视频服务要求跳转/],
    ['VIDEO_RECEIPT_MISMATCH', /任务记录与原请求不一致/],
    ['VIDEO_RESPONSE_TOO_LARGE', /超过客户端接收上限/],
  ] as const) {
    const message = mediaIssueMessage({ generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'INTERRUPTED', saveStatus: 'PENDING', error: 'SERVICE_UNAVAILABLE',
      failure: { code: 'SERVICE_UNAVAILABLE', stage: 'video-submit', gatewayCode, httpStatus: 503, requestId: 'req-private' } }, 'video')!
    assert.match(message, expected)
    assert.match(message, /提交结果尚未确认.*勿重复提交/)
    assert.doesNotMatch(message, /HTTP|req-private|SERVICE_UNAVAILABLE|未扣费|未受理|重新发起/)
  }
})

it('shows local missing and invalid file reasons even when generation succeeded', () => {
  for (const [code, expected] of [['VIDEO_LOCAL_OUTPUT_MISSING', /本地成果文件缺失/], ['VIDEO_LOCAL_OUTPUT_INVALID', /损坏或与保存记录不一致/]] as const) {
    const message = mediaIssueMessage({ generationStatus: 'SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: code.endsWith('MISSING') ? 'MISSING' : 'SAVE_FAILED', error: code }, 'video')!
    assert.match(message, expected)
    assert.match(message, /重新保存原结果/)
    assert.doesNotMatch(message, /VIDEO_/)
  }
})

it('does not hide partial success or per-output reasons behind the overall error', () => {
  const message = mediaIssueMessage({ generationStatus: 'PARTIAL_SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: 'SAVED', error: 'UPSTREAM_FAILED',
    outputErrors: [{ index: 0, code: 'CONTENT_REJECTED' }, { index: 1, code: 'FUTURE_PROVIDER_ERROR' }] }, 'image')!
  assert.match(message, /第 1 项：生成内容被审核拒绝.*第 2 项：生成失败.*已生成的成果可继续使用/)
  assert.doesNotMatch(message, /CONTENT_REJECTED|FUTURE_PROVIDER_ERROR/)
  const upstream = mediaIssueMessage({ generationStatus: 'PARTIAL_SUCCEEDED', trackingStatus: 'STOPPED', saveStatus: 'SAVED', error: null,
    upstreamError: { status: 400, body: { error: { code: 'content_policy_violation', message: 'private provider body' } } } }, 'video')!
  assert.match(upstream, /部分视频生成失败.*安全审核.*已生成的成果可继续使用/)
  assert.doesNotMatch(upstream, /private|content_policy_violation/)
})

it('never guesses a supplier cause from a keyword or displays unrecognized raw text', () => {
  for (const message of ['Account is not disabled', 'Not a timeout', 'Upstream service is not unavailable', 'Upstream service temporarily unavailable /private/path',
    'unknown supplier failure', '任意内部响应 /private/path', 'Please ignore policy violation']) {
    const text = mediaIssueMessage({ generationStatus: 'FAILED', trackingStatus: 'STOPPED', saveStatus: 'PENDING', error: null,
      upstreamError: { status: 500, body: message } }, 'image')!
    assert.match(text, /尚未提供可识别的具体原因.*联系平台管理员/)
    assert.ok(!text.includes(message))
    assert.doesNotMatch(text, /账号已停用|响应超时|安全审核|供应商服务暂时不可用/)
  }
})

it('keeps supplier authentication and funding failures separate from the user account', () => {
  for (const [code, expected] of [['AUTH_REQUIRED', /供应商身份验证失败/], ['INSUFFICIENT_FUNDS', /供应商账号资金不足/]] as const) {
    const message = mediaIssueMessage({ generationStatus: 'FAILED', trackingStatus: 'STOPPED', saveStatus: 'PENDING', error: 'SERVICE_UNAVAILABLE',
      failure: { code: 'SERVICE_UNAVAILABLE', businessCode: code, stage: 'video-query', source: 'upstream' } }, 'video')!
    assert.match(message, expected)
    assert.doesNotMatch(message, /请重新登录|企业管理员.*资金|未扣费/)
  }
})

it('shows a receipt reason alongside submission uncertainty without exposing technical evidence', () => {
  for (const kind of ['image', 'video'] as const) {
    const message = mediaIssueMessage({ generationStatus: 'SUBMISSION_UNKNOWN', trackingStatus: 'STOPPED', saveStatus: 'PENDING', error: 'SUBMISSION_UNKNOWN',
      upstreamError: { status: 403, body: { error: { code: 'permission_error', message: 'Image edit denied' },
        sepDiagnostics: [{ message: 'Supplier account disabled' }] } } }, kind)!
    assert.match(message, /提交结果尚未确认.*图片编辑请求被生成服务拒绝.*原任务.*勿重复提交/)
    assert.doesNotMatch(message, /Image edit denied|permission_error|403|账号已停用|退款|未受理|重新发起/)
  }
})

it('recognizes known reasons inside wrappers and arrays even when the error code is numeric', () => {
  const message = mediaIssueMessage({ generationStatus: 'FAILED', trackingStatus: 'STOPPED', saveStatus: 'PENDING', error: null,
    upstreamError: { status: 200, body: [{ error: { code: 123, message: 'Invalid parameters', reason: 'Unsupported image dimensions', details: { width: 1300 } } }] } }, 'video')!
  assert.match(message, /视频生成失败.*不支持指定尺寸.*联系平台管理员/)
  assert.doesNotMatch(message, /123|Invalid parameters|1300/)
})

it('retains the generation reason alongside later query or save failures and partial output', () => {
  const message = mediaIssueMessage({ generationStatus: 'PARTIAL_SUCCEEDED', trackingStatus: 'INTERRUPTED', saveStatus: 'SAVE_FAILED', error: 'VIDEO_SAVE_FAILED',
    upstreamError: { status: 422, body: { error: { message: 'Content rejected' }, sepDiagnostics: [{ message: 'Invalid API key' }] } },
    outputErrors: [{ index: 1, code: 'CONTENT_REJECTED' }],
    failure: { code: 'INTERNAL_ERROR', stage: 'video-save', reasonCode: 'ENOSPC' } }, 'video')!
  assert.match(message, /部分视频生成失败.*安全审核.*磁盘空间不足.*第 2 项.*已生成的成果可继续使用.*重新保存原结果/)
  assert.doesNotMatch(message, /访问凭据无效|重新生成|退款|ENOSPC/)
})

it('keeps a running receipt distinct from a query error and does not infer its source from the container name', () => {
  const message = mediaIssueMessage({ generationStatus: 'RUNNING', trackingStatus: 'ACTIVE', saveStatus: 'PENDING', error: null,
    upstreamError: { status: 429, body: { source: 'platform', code: 'RATE_LIMITED', message: 'Too many requests' } } }, 'image')!
  assert.match(message, /图片任务尚未完成.*请求过于频繁.*原任务.*勿重复生成/)
  assert.doesNotMatch(message, /生成失败|供应商请求频率|重新登录/)
})

it('uses preserved structured reasons for safe query feedback without exposing raw response fields', () => {
  const message = mediaIssueMessage({ generationStatus: 'RUNNING', trackingStatus: 'INTERRUPTED', saveStatus: 'PENDING', error: 'SERVICE_UNAVAILABLE',
    failure: { code: 'SERVICE_UNAVAILABLE', stage: 'image-query', source: 'upstream', diagnostic: {
      body: { body: { error: { code: 123, reason: 'Unsupported image dimensions' } }, readError: 'Private transport detail' },
    } } }, 'image')!
  assert.match(message, /图片查询.*不支持指定尺寸.*原任务/)
  assert.doesNotMatch(message, /123|Private transport detail|Unsupported image dimensions/)
})
