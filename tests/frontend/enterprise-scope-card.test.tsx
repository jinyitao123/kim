// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Transcript } from '../../src/components/Transcript'
import { SummaryPanel } from '../../src/components/inspector/SummaryPanel'
import { enterpriseRunDisplay } from '../../src/components/transcript/enterprise-run-display'
import { EnterpriseScopeCards, enterpriseScopeProjection } from '../../src/components/transcript/EnterpriseScopeCards'
import type { EnterpriseTaskScopeDisplay, EnterpriseWorkCancellationResult, EnterpriseWorkRunDetails, TranscriptMessage } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

const runId = 'run-550e8400-e29b-41d4-a716-446655441099'
const display: EnterpriseTaskScopeDisplay = { version: '1', source: 'workbench-host', runReference: runId, team: '合同团队', workflow: '合同提交', reads: ['本次员工工作内容', '客户合同', '合同.pdf'], writes: ['提交销售合同'] }
const result = { status: 'accepted', scope_display: display, receipt: { runId, inputRevisionId: '550e8400-e29b-41d4-a716-446655441098' }, recovery_key: 'internal-recovery-key' }
function message(parts: TranscriptMessage['parts']): TranscriptMessage { return { id: 'scope-receipt-message', role: 'assistant', timestamp: 1, parts } }

it('displays the exact Host scope independently of folded or hidden tools and hides raw internal receipt fields', async () => {
  const messages = [message([{ type: 'toolCall', id: 'call', name: 'gooeypi_enterprise_work_submit', args: { goal: '模型生成的工作描述' } }, { type: 'toolResult', name: 'gooeypi_enterprise_work_submit', text: JSON.stringify(result) }, { type: 'text', text: '团队已接单。' }])]
  const onCancel = vi.fn(async (): Promise<EnterpriseWorkCancellationResult> => ({ runId, status: 'cancel_requested', authorizationRevoked: true, message: '已请求取消，等待团队停止。' }))
  const showSummary = vi.fn()
  await act(async () => root.render(<Transcript messages={messages} git={{ isRepo: false, files: [] }} harness="pi" showTools={false} onOpenChanges={vi.fn()} onSuggestion={vi.fn()} onShowTeamSummary={showSummary} />))
  expect(container.querySelector('[aria-label="本次团队授权"]')).toBeNull()
  expect(container.textContent).not.toContain(runId)
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('查看团队状态'))!.click())
  expect(showSummary).toHaveBeenCalledOnce()
  const read = vi.fn(async () => ({ runs: [{ runId, status: 'running' as const, isCurrent: true }], missing: [] }))
  await act(async () => root.render(<SummaryPanel messages={messages} git={{ isRepo: false, files: [] }} automations={[]} heartbeats={[]} onOpenAutomation={vi.fn()} teamWork={{ accountScope: 'employee', sessionKey: 'session', read, cancel: onCancel }} />))
  for (const label of ['Workspace', 'Progress', 'Context', 'Session context', 'Cost', 'Tokens', 'Working directory']) expect(container.textContent).not.toContain(label)
  expect(container.querySelector('[aria-label="本次团队授权"]')?.textContent).toContain('提交销售合同')
  expect(container.textContent).toContain('本次员工工作内容、客户合同')
  expect(container.querySelector('.enterprise-materials')?.textContent).toContain('合同.pdf')
  expect(container.textContent).not.toContain(runId)
  expect(container.textContent).not.toContain('internal-recovery-key')
  expect(container.textContent).not.toContain('inputRevisionId')
  const cancel = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '取消工作')!
  await act(async () => cancel.click())
  expect(onCancel).toHaveBeenCalledWith(runId)
  expect(container.textContent).toContain('等待团队停止')
  expect(container.querySelector('[aria-label="本次团队授权"]')?.textContent).not.toContain('已取消')
})

it('does not construct a scope card from model narrative JSON, unrelated tool results, or mismatched native receipts', () => {
  const text = JSON.stringify(result)
  expect(enterpriseScopeProjection(message([{ type: 'text', text }])).scopes).toEqual([])
  expect(enterpriseScopeProjection(message([{ type: 'toolResult', name: 'read_file', text }])).scopes).toEqual([])
  expect(enterpriseScopeProjection(message([{ type: 'toolResult', name: 'gooeypi_enterprise_work_submit', text: JSON.stringify({ ...result, receipt: { runId: 'unrelated-run' } }) }])).scopes).toEqual([])
  expect(enterpriseScopeProjection(message([{ type: 'toolResult', name: 'gooeypi_enterprise_work_submit', text, streaming: true }])).scopes).toEqual([])
})

it('keeps unknown cancellation open for the same run and only claims cancellation after a confirmed receipt', async () => {
  const onCancel = vi.fn<(_: string) => Promise<EnterpriseWorkCancellationResult>>()
    .mockResolvedValueOnce({ runId, status: 'unknown', authorizationRevoked: false, message: '取消结果待核对。' })
    .mockResolvedValueOnce({ runId, status: 'cancelled', authorizationRevoked: true, message: '团队工作已取消。' })
  await act(async () => root.render(<EnterpriseScopeCards scopes={[display]} onCancelWork={onCancel} />))
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(container.textContent).toContain('取消结果待核对')
  expect(container.querySelector('.enterprise-scope-status')?.textContent).toBe('取消待核对')
  expect(container.querySelector('button')?.textContent).toBe('核对取消')
  expect(container.querySelector('button')?.disabled).toBe(false)
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(onCancel.mock.calls).toEqual([[runId], [runId]])
  expect(container.querySelector('.enterprise-scope-status')?.textContent).toBe('已取消')
  expect(container.querySelector('.enterprise-scope-cancel')).toBeNull()
})

it('deduplicates repeated native receipts for one original run without rendering their hidden input identifiers', async () => {
  const part = { type: 'toolResult' as const, name: 'gooeypi_enterprise_work_recover', text: JSON.stringify(result) }
  const projection = enterpriseScopeProjection(message([part, part]))
  expect(projection.scopes).toHaveLength(1)
  expect(projection.message.parts).toEqual([])
  await act(async () => root.render(<EnterpriseScopeCards scopes={[{ ...display, writes: [] }]} />))
  expect(container.textContent).toContain('只读分析')
  expect(container.textContent).not.toContain(runId)
})


it.each([
  ['queued', undefined, '等待执行', false],
  ['running', undefined, '团队执行中', true],
  ['parked', undefined, '等待中', false],
  ['cancel_requested', undefined, '正在停止', false],
  ['succeeded', 'needs_input', '需要补充', false],
  ['succeeded', 'completed', '团队执行完成', false],
  ['failed', 'action_failed', '团队执行失败', false],
  ['cancelled', undefined, '已取消', false],
  ['abandoned', undefined, '已结束', false],
] as const)('renders authoritative %s / %s without inventing progress', async (status, businessResult, expected, animate) => {
  await act(async () => root.render(<EnterpriseScopeCards scopes={[display]} states={{ [runId]: { run: { runId, status, isCurrent: true, businessResult } } }} />))
  expect(container.querySelector('[role="status"]')?.textContent).toBe(expected)
  expect(container.querySelector('.is-animating') !== null).toBe(animate)
  expect(container.textContent).not.toContain('审批通过')
  expect(container.textContent).not.toContain('%')
  if (status === 'parked') {
    expect(container.textContent).toContain('等待原因尚未核对')
    expect(container.textContent).not.toContain('待处理事项')
    expect(container.textContent).not.toContain('人工处理')
  }
})

it('stops busy animation on a failed status refresh and keeps the last known state explicit', () => {
  const running = { runId, status: 'running' as const, isCurrent: true }
  expect(enterpriseRunDisplay({ run: running, stale: true })).toMatchObject({ label: '状态未更新', detail: '上次状态：团队执行中', animate: false })
  expect(enterpriseRunDisplay({ run: { ...running, isCurrent: false } })).toMatchObject({ detail: '已有后续工作', animate: false })
  expect(enterpriseRunDisplay({ run: { ...running, businessResult: 'action_unknown' } })).toMatchObject({ label: '团队执行中', detail: '业务回执待核对', animate: true })
})

it('labels a parked member stage neutrally when its wait reason is unavailable', async () => {
  const details: EnterpriseWorkRunDetails = { runId, status: 'parked', members: [{ name: '材料检查员', status: 'running', stages: [{ name: '并行检查', status: 'parked' }] }],
    activityComplete: false, materials: [], explanation: '团队工作当前处于等待状态，等待原因尚未核对。', authorizationRequired: false }
  await act(async () => root.render(<EnterpriseScopeCards scopes={[display]} states={{ [runId]: { run: { runId, status: 'parked', isCurrent: true }, details } }} />))
  expect(container.querySelector('[role="status"]')?.textContent).toBe('等待中')
  expect(container.querySelector('.enterprise-member li')?.textContent).toContain('并行检查')
  expect(container.querySelector('.enterprise-member li')?.textContent).toContain('等待中')
  expect(container.textContent).not.toContain('等待处理')
  expect(container.textContent).not.toContain('人工处理')
})

it('shows verified execution facts and an available next action after failure instead of a disabled dead end', async () => {
  const openWork = vi.fn()
  const details: EnterpriseWorkRunDetails = { runId, status: 'failed', acceptedAt: '2026-10-02T10:00:00Z', finishedAt: '2026-10-02T10:01:00Z',
    members: [{ name: '材料检查员', status: 'completed', stages: [{ name: '检查合同材料', status: 'completed', durationMs: 12000 }] }], activityComplete: false,
    materials: [{ name: '合同.pdf', format: 'PDF', bytes: 2048 }], explanation: '团队未能完成本次执行，尚未形成有效结论。', authorizationRequired: false,
    actionCounts: { succeeded: 0, failed: 0, unknown: 0 } }
  await act(async () => root.render(<EnterpriseScopeCards scopes={[{ ...display, writes: [] }]} states={{ [runId]: { run: { runId, status: 'failed', isCurrent: true }, details } }} onOpenWork={openWork} onCancelWork={vi.fn()} />))
  for (const value of ['总耗时 1 分 0 秒', '材料检查员', '执行完成', '合同.pdf', '2 KB', '业务动作记录0 条', '只读分析', '仅显示已读取的执行记录']) expect(container.textContent).toContain(value)
  expect(container.textContent).not.toContain('审批通过')
  expect(container.querySelector('.enterprise-scope-cancel')).toBeNull()
  const next = container.querySelector<HTMLButtonElement>('.enterprise-work-action')!
  expect(next.disabled).toBe(false)
  await act(async () => next.click())
  expect(openWork).toHaveBeenCalledOnce()
})

it('shows authoritative failed and unknown action reasons without claiming no business effect', async () => {
  const details: EnterpriseWorkRunDetails = { runId, status: 'failed', members: [], activityComplete: true, materials: [], explanation: '', authorizationRequired: false,
    actionOutcomes: [
      { actionName: '转为商机', status: 'failed', summary: '销售业务设置缺少项目客户分类，请管理员维护。' },
      { actionName: '合同提交', status: 'unknown', summary: '业务回执暂未取得，请核对原工作。' },
    ] }
  await act(async () => root.render(<EnterpriseScopeCards scopes={[display]} states={{ [runId]: { run: { runId, status: 'failed', isCurrent: true }, details } }} />))
  expect(container.textContent).toContain('团队执行失败')
  expect(container.textContent).toContain('转为商机未完成')
  expect(container.textContent).toContain('销售业务设置缺少项目客户分类，请管理员维护')
  expect(container.textContent).toContain('本次未取得成功回执')
  expect(container.textContent).toContain('合同提交结果待核对')
  expect(container.textContent).not.toMatch(/未写入|没有发生|尚未执行/)
  expect(container.textContent!.indexOf('销售业务设置')).toBeLessThan(container.textContent!.indexOf('执行过程'))
})
