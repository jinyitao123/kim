import { parseApprovalWorkPage, type ApprovalWorkItem } from './work-sources'

/** Employee approval projection. Follow its account-scoped cursor until exhaustion. */
export async function readApprovalWorkPages(read: (path: string) => Promise<unknown>): Promise<{ items: ApprovalWorkItem[]; error?: string }> {
  const found = new Map<string, ApprovalWorkItem>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  try {
    for (;;) {
      const query = new URLSearchParams({ limit: '100', includeSubmitted: '1', ...(cursor ? { cursor } : {}) })
      const page = parseApprovalWorkPage(await read(`/api/v1/workbench/approvals?${query}`))
      const previousCount = found.size
      for (const item of page.items) {
        const previous = found.get(item.requestId)
        if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('审批事项在读取期间已变化，请刷新后重试')
        found.set(item.requestId, item)
      }
      if (!page.nextCursor) return { items: [...found.values()] }
      if (page.nextCursor.length > 8192 || cursors.has(page.nextCursor) || found.size === previousCount) {
        throw new Error('审批事项分页没有继续前进，当前列表不完整，请刷新后重试')
      }
      cursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
  } catch (error) {
    return { items: [...found.values()], error: message(error) }
  }
}

/** ObjectStack 17.3 approval listing uses limit/offset and optional total. */
export async function readApprovalPages(read: (path: string) => Promise<unknown>): Promise<{ data: unknown[]; error?: string }> {
  const limit = 50
  const found = new Map<string, unknown>()
  let offset = 0
  let total: number | undefined
  try {
  for (;;) {
    const response = await read(`/api/v1/approvals/requests?limit=${limit}${offset ? `&offset=${offset}` : ''}`)
    const envelope = object(response)
    const values = Array.isArray(response) ? response : Array.isArray(envelope?.data) ? envelope.data : envelope?.requests
    if (!Array.isArray(values) || values.length > limit) throw new Error('审批事项分页格式无效，请刷新后重试')
    if (envelope?.total !== undefined) {
      if (!Number.isSafeInteger(envelope.total) || (envelope.total as number) < 0) throw new Error('审批事项总量格式无效，请刷新后重试')
      if (total !== undefined && total !== envelope.total) throw new Error('审批事项列表在读取期间已变化，请刷新后重试')
      total = envelope.total as number
    }
    const previousCount = found.size
    for (const value of values) {
      const id = object(value)?.id
      if (typeof id !== 'string' || !id.trim()) throw new Error('审批事项分页缺少有效事项，请刷新后重试')
      const previous = found.get(id)
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('审批事项在读取期间已变化，请刷新后重试')
      found.set(id, value)
    }
    if (total !== undefined && found.size >= total) {
      if (found.size !== total) throw new Error('审批事项总量与列表不一致，请刷新后重试')
      return { data: [...found.values()] }
    }
    if (values.length < limit) {
      if (total !== undefined) throw new Error('审批事项分页未能完整读取，请刷新后重试')
      return { data: [...found.values()] }
    }
    if (found.size === previousCount) throw new Error('审批事项分页没有继续前进，请刷新后重试')
    offset += values.length
  }
  } catch (error) { return { data: [...found.values()], error: message(error) } }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Forge's native-inbox connection supplies an account-bound keyset cursor. */
export async function readInboxPages(read: (path: string) => Promise<unknown>): Promise<{ notifications: unknown[]; error?: string }> {
  const found = new Map<string, unknown>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  try {
    for (;;) {
      const response = object(await read(`/api/v1/apps/forge/workbench/inbox?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`))
      if (response?.version !== '1' || !Array.isArray(response.notifications) || response.notifications.length > 100
        || typeof response.has_more !== 'boolean' || response.has_more && (typeof response.next_cursor !== 'string' || !response.next_cursor || response.next_cursor.length > 8192)
        || !response.has_more && response.next_cursor !== null) throw new Error('通知分页格式无效，当前列表不完整，请刷新后重试')
      const previousCount = found.size
      for (const value of response.notifications) {
        const id = object(value)?.id
        if (typeof id !== 'string' || !id.trim()) throw new Error('通知分页缺少有效消息，当前列表不完整，请刷新后重试')
        const previous = found.get(id)
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('通知在读取期间已变化，当前列表不完整，请刷新后重试')
        found.set(id, value)
      }
      if (!response.has_more) return { notifications: [...found.values()] }
      const next = response.next_cursor as string
      if (cursors.has(next) || found.size === previousCount) throw new Error('通知分页没有继续前进，当前列表不完整，请刷新后重试')
      cursors.add(next); cursor = next
    }
  } catch (error) { return { notifications: [...found.values()], error: message(error) } }
}

function message(error: unknown): string { return error instanceof Error ? error.message : '列表读取失败，当前列表不完整，请刷新后重试' }
