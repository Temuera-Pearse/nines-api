export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly publicMessage: string
  readonly publicDetails?: Record<string, unknown>
  override readonly cause?: unknown

  constructor(input: {
    status: number
    code: string
    message: string
    publicMessage?: string
    publicDetails?: Record<string, unknown>
    cause?: unknown
  }) {
    super(input.message)
    this.name = 'AppError'
    this.status = input.status
    this.code = input.code
    this.publicMessage = input.publicMessage ?? input.message
    this.publicDetails = input.publicDetails
    this.cause = input.cause
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
