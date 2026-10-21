import { AppError } from './app-error'
import { mediaToolFailure, type MediaToolFailure } from './media-tool-error'

/** Fixed diagnostics: never forward arbitrary exception messages, causes or provider responses. */
export function videoToolFailureFrom(error: unknown): MediaToolFailure | undefined {
  if (!(error instanceof AppError)) return undefined
  const messages: Partial<Record<AppError['code'], string>> = {
    INVALID_ARGUMENT: 'Video input or explicit specifications are unsupported. Call video_get_job with {} to inspect video profiles and referenceAssets. Omit profileId and unspecified parameters to use host defaults. This is not a permission denial.',
    PERMISSION_DENIED: 'Video authorization or approval was denied. Do not infer that no video model is configured.',
    AUTH_REQUIRED: 'Video authentication expired. Sign in again before continuing.',
    NETWORK_ERROR: 'The video service could not be reached. This does not mean a video profile is missing.',
    SERVICE_UNAVAILABLE: 'The video service is unavailable or returned an invalid response. Do not infer a missing profile.',
    NOT_FOUND: 'The requested task-local video job or asset was not found.',
    CONFLICT: 'A video operation is pending. Query the original job; do not automatically submit another paid request.',
    INVALID_STATE: 'The video state could not be confirmed. Query the original job; do not automatically submit another paid request.',
    RATE_LIMITED: 'The video service is rate limited. Do not automatically resubmit a paid request.',
  }
  return mediaToolFailure(error.code, messages[error.code] ?? 'Video operation failed. Do not infer a missing profile or automatically resubmit a paid request.')
}
