import { expect, it, vi } from 'vitest'
import { readApprovalPages, readApprovalWorkPages, readInboxPages } from '../../electron/main/enterprise/inbox-pages'

function requests(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `approval-${start + index}`, status: 'pending' }))
}

it('deduplicates identical approval rows without hiding missing rows from the native total', async () => {
  const read = vi.fn().mockResolvedValueOnce({ data: requests(0, 50), total: 101 })
    .mockResolvedValueOnce({ data: requests(49, 50), total: 101 })
    .mockResolvedValueOnce({ data: requests(99, 2), total: 101 })
  const result = await readApprovalPages(read)
  expect(result.data).toHaveLength(101)
  expect(new Set(result.data.map((value) => (value as { id: string }).id)).size).toBe(101)
  expect(read.mock.calls.map(([path]) => path)).toEqual([
    '/api/v1/approvals/requests?limit=50', '/api/v1/approvals/requests?limit=50&offset=50', '/api/v1/approvals/requests?limit=50&offset=100',
  ])
})

it('continues legacy native approval pages without a total until an explicit short page', async () => {
  const read = vi.fn().mockResolvedValueOnce({ data: requests(0, 50) }).mockResolvedValueOnce({ data: requests(50, 3) })
  expect((await readApprovalPages(read)).data).toHaveLength(53)
  expect(read).toHaveBeenCalledTimes(2)
})

it.each([
  { next: { data: requests(0, 50), total: 51 }, error: '分页没有继续前进' },
  { next: { data: [], total: 51 }, error: '分页未能完整读取' },
  { next: { data: [{ id: 'approval-0', status: 'returned' }], total: 51 }, error: '事项在读取期间已变化' },
  { next: { data: requests(50, 1), total: 52 }, error: '列表在读取期间已变化' },
  { next: { data: requests(50, 1), total: -1 }, error: '总量格式无效' },
  { next: { unexpected: [] }, error: '分页格式无效' },
])('refuses incomplete or changed native approval pages: $error', async ({ next, error }) => {
  const read = vi.fn().mockResolvedValueOnce({ data: requests(0, 50), total: 51 }).mockResolvedValueOnce(next)
  await expect(readApprovalPages(read)).resolves.toMatchObject({ error: expect.stringContaining(error), data: expect.any(Array) })
  expect(read).toHaveBeenCalledTimes(2)
})

function notices(start: number, count: number) { return Array.from({ length: count }, (_, index) => ({ id: `notice-${start + index}`, title: `本人消息${start + index}` })) }

it('reads more than 200 native inbox notices through the frozen keyset protocol and deduplicates exact repeated rows', async () => {
  const read = vi.fn().mockResolvedValueOnce({ version: '1', notifications: notices(0, 100), next_cursor: 'bound/first', has_more: true })
    .mockResolvedValueOnce({ version: '1', notifications: notices(99, 100), next_cursor: 'bound/second', has_more: true })
    .mockResolvedValueOnce({ version: '1', notifications: notices(199, 52), next_cursor: null, has_more: false })
  const result = await readInboxPages(read)
  expect(result.notifications).toHaveLength(251)
  expect(result.error).toBeUndefined()
  expect(read.mock.calls.map(([path]) => path)).toEqual(['/api/v1/apps/forge/workbench/inbox?limit=100', '/api/v1/apps/forge/workbench/inbox?limit=100&cursor=bound%2Ffirst', '/api/v1/apps/forge/workbench/inbox?limit=100&cursor=bound%2Fsecond'])
})

it.each([
  { page: { version: '1', notifications: notices(100, 1), next_cursor: 'first', has_more: true }, error: '没有继续前进' },
  { page: { version: '1', notifications: notices(100, 1), next_cursor: 'unexpected', has_more: false }, error: '格式无效' },
  { page: { version: '1', notifications: [], next_cursor: 'second', has_more: true }, error: '没有继续前进' },
])('keeps already visible inbox notices when the next page is incomplete: $error', async ({ page, error }) => {
  const read = vi.fn().mockResolvedValueOnce({ version: '1', notifications: notices(0, 100), next_cursor: 'first', has_more: true }).mockResolvedValueOnce(page)
  const result = await readInboxPages(read)
  expect(result.notifications.length).toBeGreaterThanOrEqual(100)
  expect(result.error).toContain(error)
})

it('keeps visible inbox notices and the read error when a subsequent request fails', async () => {
  const read = vi.fn().mockResolvedValueOnce({ version: '1', notifications: notices(0, 100), next_cursor: 'first', has_more: true }).mockRejectedValueOnce(new Error('当前账号没有读取通知的权限'))
  expect(await readInboxPages(read)).toMatchObject({ notifications: expect.any(Array), error: '当前账号没有读取通知的权限' })
})

it('keeps current approval return reasons from all cursor pages and reports an unchanged cursor as incomplete', async () => {
  const item = { requestId: 'returned-approval', mode: 'revision', title: '合同需要修改', updatedAt: '2026-10-01T00:00:00Z', returnReason: '第二轮仍需补附件' }
  const read = vi.fn().mockResolvedValueOnce({ version: '1', items: [item], nextCursor: 'next' })
    .mockResolvedValueOnce({ version: '1', items: [{ ...item, requestId: 'another' }], nextCursor: 'next' })
  const result = await readApprovalWorkPages(read)
  expect(result.items[0]?.returnReason).toBe('第二轮仍需补附件')
  expect(result.error).toContain('分页没有继续前进')
  expect(read.mock.calls.map(([path]) => path)).toEqual([
    '/api/v1/workbench/approvals?limit=100&includeSubmitted=1',
    '/api/v1/workbench/approvals?limit=100&includeSubmitted=1&cursor=next',
  ])
})

it('opts in to the submitted native-order scope and accepts its strict mode', async () => {
  const submitted = { requestId: 'submitted-order', mode: 'submitted', title: '合成订单', updatedAt: '2026-10-03T00:00:00Z' }
  const read = vi.fn().mockResolvedValue({ version: '1', items: [submitted] })
  const result = await readApprovalWorkPages(read)
  expect(result).toEqual({ items: [submitted] })
  expect(read).toHaveBeenCalledWith('/api/v1/workbench/approvals?limit=100&includeSubmitted=1')
})
