export class ForgeBusinessReadError extends Error {
  constructor(readonly kind: 'forbidden' | 'not_found' | 'failed', message: string) {
    super(message)
    this.name = 'ForgeBusinessReadError'
  }
}

export function businessReadErrorResult(error: unknown): { status: 'forbidden' | 'not_found' | 'failed'; message: string } {
  if (error instanceof ForgeBusinessReadError) return { status: error.kind, message: error.message }
  return { status: 'failed', message: 'Forge 业务记录读取失败，请刷新后重试' }
}
