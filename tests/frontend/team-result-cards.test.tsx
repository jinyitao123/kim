// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TeamResultCards } from '../../src/components/transcript/TeamResultCards'
import type { EnterpriseTaskScopeDisplay, EnterpriseWorkRunDetails, EnterpriseWorkRunState, TranscriptMessage } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

const runId = 'run-550e8400-e29b-41d4-a716-446655441099'
const display: EnterpriseTaskScopeDisplay = { version: '1', source: 'workbench-host', runReference: runId, team: '短视频生成团队', workflow: '第1集短片', reads: ['剧本.md'], writes: [] }
const receipt = { status: 'accepted', scope_display: display, receipt: { runId, inputRevisionId: '550e8400-e29b-41d4-a716-446655441098' } }
const messages: TranscriptMessage[] = [{ id: 'm1', role: 'assistant', timestamp: 1, parts: [
  { type: 'toolCall', id: 'call', name: 'gooeypi_enterprise_work_submit', args: {} },
  { type: 'toolResult', name: 'gooeypi_enterprise_work_submit', text: JSON.stringify(receipt) },
] }]
const details = (status: EnterpriseWorkRunState['status']): EnterpriseWorkRunDetails => ({
  runId, status, finishedAt: '2026-10-19T06:32:00.000Z', members: [], activityComplete: true, materials: [],
  result: { title: '审片前检查', summary: '30 个镜头已生成。', missingItems: ['第 7 镜头需要重做配音'] },
  explanation: '团队执行已完成；正式业务结果以业务系统中的记录为准。', authorizationRequired: false,
})

function teamWork(status: EnterpriseWorkRunState['status']) {
  return {
    accountScope: 'employee', sessionKey: 'session',
    read: vi.fn(async () => ({ runs: [{ runId, status, isCurrent: true }], missing: [] })),
    readDetails: vi.fn(async () => details(status)),
    cancel: vi.fn(),
  }
}

it('shows a finished run as a returned result in the conversation, with summary and follow-up hint', async () => {
  const onOpenDetails = vi.fn()
  await act(async () => root.render(<TeamResultCards messages={messages} teamWork={teamWork('succeeded')} onOpenDetails={onOpenDetails} />))
  await vi.waitFor(() => expect(container.textContent).toContain('30 个镜头已生成。'))
  expect(container.textContent).toContain('团队结果已返回')
  expect(container.textContent).toContain('团队工作已完成')
  expect(container.textContent).toContain('短视频生成团队 · 第1集短片')
  expect(container.textContent).toContain('第 7 镜头需要重做配音')
  expect(container.textContent).toContain('回复这条对话，助手会在这里接着处理。')
  expect(container.textContent).not.toContain(runId)
  await act(async () => container.querySelector<HTMLButtonElement>('.team-result-card footer button')!.click())
  expect(onOpenDetails).toHaveBeenCalledOnce()
})

it('stays out of the conversation while the run is still working or when it was cancelled', async () => {
  for (const status of ['running', 'cancelled'] as const) {
    const work = teamWork(status)
    await act(async () => root.render(<TeamResultCards messages={messages} teamWork={work} />))
    await vi.waitFor(() => expect(work.read).toHaveBeenCalled())
    expect(container.querySelector('.team-result-card')).toBeNull()
  }
})

it('renders nothing without team work in the conversation', async () => {
  await act(async () => root.render(<TeamResultCards messages={[{ id: 'm', role: 'user', timestamp: 1, parts: [{ type: 'text', text: '你好' }] }]} teamWork={teamWork('succeeded')} />))
  expect(container.innerHTML).toBe('')
})
