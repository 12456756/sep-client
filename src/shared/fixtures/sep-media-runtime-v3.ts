/** Based on the successful employee runtime response supplied on 2026-11-17. */
export function sepRuntimeV3Fixture(kind: 'image' | 'video') {
  const image = kind === 'image'
  const operations = image ? ['generate', 'edit'] : ['text-to-video', 'image-to-video']
  const [plain, reference] = operations
  const primary = image ? 'size' : 'resolution'
  const maxCount = image ? 4 : 1
  const maxInputBytes = image ? 5242880 : 10485760
  const profileId = `${kind}_example`
  const modelId = image ? 'gpt-image-2' : 'video_model_example'
  const parameter = (label: string, type: string, extra: Record<string, unknown> = {}) => ({
    label, type, support: 'supported', required: false, operations, valuesMode: 'unknown', source: 'adapter',
    confidence: 'unknown', observedAt: null, ...extra,
  })
  const suggested = (values: (string | boolean)[]) => ({ values, valuesMode: 'suggested', source: 'profile-config', confidence: 'declared' })
  return {
    protocolVersion: 3, executionMode: 'real', status: 'ready', executionAvailable: true, defaultProfileId: profileId,
    tools: image ? ['image_generate', 'image_edit'] : ['video_from_image', 'video_generate', 'video_get_job'],
    profiles: [{
      profileId, configVersion: '1', kind, modelId, modelDisplayName: modelId, displayName: kind,
      operations, executionMode: image ? 'sync-response' : 'async-query', authorized: true,
      adapter: { id: `sub2api-${kind}`, version: '3', available: true, operations,
        referenceSupport: { maxCount, maxInputBytes, mimeTypes: ['image/png'] }, supportsTaskQuery: !image, supportsCancel: false },
      parameters: {
        [primary]: parameter(primary, 'string', suggested(image ? ['1024x1024', '1536x1024', '1024x1536'] : ['720p', '1080p'])),
        width: parameter('Width', 'integer', { minimum: 1, unit: 'pixels' }),
        height: parameter('Height', 'integer', { minimum: 1, unit: 'pixels' }),
        aspectRatio: parameter('Ratio', 'string', image ? {} : suggested(['16:9', '9:16'])),
        ...(image ? {
          count: parameter('Count', 'integer', { required: true, minimum: 1, maximum: 4, step: 1, unit: 'images',
            source: 'profile-config', confidence: 'declared' }),
          quality: parameter('Quality', 'string', { ...suggested(['low', 'medium', 'high']), required: true }),
        } : {
          durationSeconds: parameter('Duration', 'integer', { required: true, minimum: 4, maximum: 15, step: 1, unit: 'seconds',
            source: 'profile-config', confidence: 'declared' }),
          audio: parameter('Audio', 'boolean', suggested([false, true])),
          outputFormat: parameter('Format', 'string', { valuesMode: 'allowed', values: ['video/mp4'], confidence: 'verified' }),
          frameRate: parameter('Frame rate', 'number', { support: 'unsupported', confidence: 'verified' }),
        }),
      },
      constraints: [
        { type: 'requiredTogether', operations, fields: ['width', 'height'], code: 'DIMENSIONS_PAIR_REQUIRED', message: 'Set both dimensions.' },
        { type: 'requireAny', operations, alternatives: [[primary], ['width', 'height']], code: 'DIMENSIONS_REQUIRED', message: 'Set size or dimensions.' },
      ],
      referenceRules: [
        { operation: plain, minCount: 0, maxCount: 0, maxInputBytes: 0, mimeTypes: [] },
        { operation: reference, minCount: 1, maxCount, maxInputBytes, mimeTypes: ['image/png'] },
      ],
      unavailableReason: null, unavailableMessage: null,
    }],
  }
}
