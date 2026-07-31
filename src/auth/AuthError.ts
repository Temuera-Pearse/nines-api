import { AppError } from '../shared/http/AppError.js'

export type AuthErrorCode =
  | 'AUTH_HEADER_MISSING'
  | 'AUTH_HEADER_MALFORMED'
  | 'AUTH_TOKEN_INVALID'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_TOKEN_NOT_ACTIVE'
  | 'AUTH_PLAYER_TOKEN_REQUIRED'
  | 'AUTH_KEYS_UNAVAILABLE'

export class AuthError extends AppError {
  constructor(code: AuthErrorCode, options: { status?: number; cause?: unknown } = {}) {
    super({
      status: options.status ?? 401,
      code,
      message: code,
      publicMessage:
        code === 'AUTH_PLAYER_TOKEN_REQUIRED'
          ? 'A human player token is required'
          : code === 'AUTH_KEYS_UNAVAILABLE'
            ? 'Authentication is temporarily unavailable'
            : 'Authentication failed',
      cause: options.cause,
    })
    this.name = 'AuthError'
  }
}
