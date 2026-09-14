/**
 * electron/common/platform/authentication-required-error.ts
 *
 * 从 auth-session-manager.ts 里单独拆出来的纯错误类。原因很具体：
 * auth-session-manager 依赖 credentials.ts，后者 import electron，于是任何想识别这个
 * 错误的模块都被迫拖进 Electron 运行时——errors/error-mapper.ts 因此无法在 Electron
 * 之外加载，连单测都跑不起来。错误类本身不需要任何运行时依赖，放这里即可。
 */

export class AuthenticationRequiredError extends Error {
  readonly statusCode = 401

  constructor(message = 'Authentication required. Please sign in again.') {
    super(message)
    this.name = 'AuthenticationRequiredError'
  }
}


