import type { MediaProfile } from '../../shared/media'
import type { VideoRuntimeProfile } from '../../shared/video-media'

export interface MediaParameterDescription { key: string; label: string; details: string[] }

const FIELD_LABELS: Record<string, string> = {
  size: '尺寸', width: '宽度', height: '高度', aspectRatio: '宽高比', count: '图片数量', quality: '质量',
  resolution: '分辨率', durationSeconds: '时长', audio: '音频', outputFormat: '输出格式', frameRate: '帧率',
}
const OPERATIONS: Record<string, string> = { generate: '文生图', edit: '图生图', 'text-to-video': '文生视频', 'image-to-video': '图生视频', 'video-to-video': '视频生视频' }
const SOURCES = { 'profile-config': '模型配置', adapter: '适配器', 'platform-policy': '平台策略', provider: '模型服务商' }
const CONFIDENCE = { verified: '已验证', declared: '已声明', unknown: '未确认' }
const UNITS = { seconds: '秒', pixels: '像素', images: '张' }

export function mediaOperationLabel(operation: string): string { return OPERATIONS[operation] ?? operation }
function valueLabel(value: string | number | boolean): string { return typeof value === 'boolean' ? value ? '是' : '否' : String(value) }

export function describeMediaParameters(profile: MediaProfile | VideoRuntimeProfile): MediaParameterDescription[] {
  if (profile.parameters !== undefined) {
    return Object.entries(profile.parameters).map(([key, parameter]) => {
      const details: string[] = [parameter.support === 'supported' ? '支持' : parameter.support === 'unsupported' ? '不支持' : '支持情况未声明']
      if (parameter.required) details.push('必填')
      if (parameter.values?.length) details.push(`${parameter.valuesMode === 'allowed' ? '允许值' : parameter.valuesMode === 'suggested' ? '建议值' : '参考值（范围未声明）'}：${parameter.values.map(valueLabel).join('、')}`)
      else if (parameter.minimum === undefined && parameter.maximum === undefined) details.push('取值未声明')
      const unit = parameter.unit ? ` ${UNITS[parameter.unit]}` : ''
      if (parameter.minimum !== undefined) details.push(`最小值：${parameter.minimum}${unit}`)
      if (parameter.maximum !== undefined) details.push(`最大值：${parameter.maximum}${unit}`)
      if (parameter.step !== undefined) details.push(`步长：${parameter.step}${unit}`)
      if (parameter.default !== undefined) details.push(`默认值：${valueLabel(parameter.default)}${unit}`)
      details.push(`适用：${parameter.operations.map(mediaOperationLabel).join('、')}`)
      details.push(`来源：${SOURCES[parameter.source]} · ${CONFIDENCE[parameter.confidence]}`)
      if (parameter.observedAt) details.push(`更新时间：${new Date(parameter.observedAt).toLocaleString('zh-CN')}`)
      return { key, label: FIELD_LABELS[key] ?? parameter.label, details }
    })
  }
  const rows: MediaParameterDescription[] = []
  const allowed = (key: string, values: (string | number | boolean)[] | undefined, defaultValue?: string | number | boolean) => {
    const details = values?.length ? [`允许值：${values.map(valueLabel).join('、')}`] : ['取值未声明']
    if (defaultValue !== undefined) details.push(`默认值：${valueLabel(defaultValue)}`)
    rows.push({ key, label: FIELD_LABELS[key] ?? key, details })
  }
  if (profile.kind === 'image') {
    allowed('size', profile.allowedSizes, profile.defaultSize)
    allowed('aspectRatio', profile.allowedAspectRatios)
    allowed('quality', profile.allowedQualities, profile.defaultQuality)
    if (profile.maxCount !== undefined) rows.push({ key: 'count', label: '图片数量', details: [`${profile.maxCountSource === 'local-output-safety' ? '客户端输出安全上限' : '最大值'}：${profile.maxCount}`] })
  } else {
    const caps = profile.capabilities
    allowed('durationSeconds', caps.durationsSeconds, caps.defaults?.durationSeconds)
    allowed('resolution', caps.resolutions, caps.defaults?.resolution)
    allowed('aspectRatio', caps.aspectRatios, caps.defaults?.aspectRatio)
    allowed('frameRate', caps.frameRates, caps.defaults?.frameRate)
    allowed('audio', caps.audioModes, caps.defaults?.audio)
    allowed('outputFormat', caps.outputFormats, caps.defaults?.outputFormat)
  }
  return rows
}
