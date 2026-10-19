// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Sidebar, type SidebarProps } from '../../src/components/Sidebar'
import { EnterpriseWorkPage } from '../../src/pages/EnterpriseWorkPage'
import { enterprisePendingWorkCount } from '../../src/lib/enterprise-work-count'
import type { EnterpriseWorkOverview } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const noop = () => undefined

it('counts assigned business work only when its authoritative projection is complete', () => {
  const item = { workKey: 'a'.repeat(64), kind: 'contract_signature' as const, title: '登记签署', record: { objectName: 'forge_sales_contract', recordId: 'contract', label: '合同' }, recordVersion: '1', updatedAt: '2026-10-03T00:00:00Z', assignment: 'assigned' as const }
  const current = { ...resultOnly, businessWork: [item, { ...item, workKey: 'b'.repeat(64), assignment: 'needs_assignment' as const, assignmentReason: 'multiple_eligible_employees' as const }], reads: { ...resultOnly.reads, businessWork: { status: 'loaded' as const } } }
  expect(enterprisePendingWorkCount(current)).toBe(1)
  expect(enterprisePendingWorkCount({ ...current, reads: { ...current.reads, businessWork: { status: 'failed' } } })).toBeUndefined()
})
const sidebarProps: SidebarProps = {
  projects: [{ id: 'project', harness: 'pi', name: 'My work', path: '/project', folders: ['/project'], primaryFolder: '/project', pinned: false, createdAt: '2026-10-02T00:00:00Z', lastOpenedAt: '2026-10-02T00:00:00Z', sessionCount: 1 }],
  sessions: [{ id: 'chat', harness: 'pi', filePath: '/session.jsonl', projectPath: '/project', title: 'Local completed chat', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', status: 'complete', unread: true, depth: 0 }],
  activeView: 'session', onSelectProject: noop, onSelectSession: noop, onNavigate: noop, onNewSession: noop, onAddProject: noop, onRemoveProject: noop, onClose: noop, onOpenPalette: noop,
  onRenameSession: async () => undefined, onArchiveSession: async () => undefined,
}
const resultOnly: EnterpriseWorkOverview = {
  loadedAt: '2026-10-02T00:00:00Z', choices: [], runs: [], tasks: [],
  items: [{ id: 'result', source: 'weave', kind: 'result', notificationType: 'weave.team_run.result', title: 'Team result', status: 'unread', actionable: false, read: false, createdAt: '2026-10-02T00:00:00Z' }],
  reads: { runs: { status: 'loaded' }, teamChoices: { status: 'loaded' }, weaveTasks: { status: 'loaded' }, forgeApprovals: { status: 'loaded' }, notifications: { status: 'loaded' } },
}
const needsInput: EnterpriseWorkOverview = {
  ...resultOnly,
  items: [...resultOnly.items, { id: 'needs-input', source: 'weave', kind: 'revision_required', notificationType: 'weave.team_run.revision_required', title: 'Supplement required', status: 'pending', actionable: true, read: false, createdAt: '2026-10-02T00:00:00Z' }],
}
let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

async function renderWork(overview?: EnterpriseWorkOverview, loading = false, error = '', enterpriseMode = true) {
  await act(async () => root.render(<>
    <Sidebar {...sidebarProps} enterpriseMode={enterpriseMode} pendingWorkCount={enterprisePendingWorkCount(overview, loading || Boolean(error))} />
    <EnterpriseWorkPage overview={overview} loading={loading} error={error} onRefresh={noop} onComplete={async () => undefined} onInspect={async () => ({ title: '', step: '', fields: [], files: [] })} onAssist={async () => undefined} onContinue={noop} />
  </>))
}
function countFor(title: string) {
  const tab = [...container.querySelectorAll('[role="tab"]')].find((element) => element.querySelector('.work-tab__label')?.textContent === title)
  return tab?.querySelector('.work-tab__count')?.textContent
}
const badge = () => container.querySelector('.sidebar__primary .nav-count')?.textContent

it('keeps result notifications and local completed chats out of enterprise pending totals', async () => {
  await renderWork(resultOnly)
  expect(badge()).toBeUndefined()
  expect(countFor('待我处理')).toBe('0')
  expect(countFor('工作消息')).toBe('1')
  expect(container.querySelector('.session-row-wrap.has-attention')).not.toBeNull()

  await renderWork(needsInput)
  expect(badge()).toBe('1')
  expect(countFor('待我处理')).toBe('1')
  expect(countFor('工作消息')).toBe('1')

  await renderWork(resultOnly)
  expect(badge()).toBeUndefined()
  expect(countFor('待我处理')).toBe('0')
})

it('counts native pending tasks but excludes completed and cancelled actionable entries', async () => {
  const overview: EnterpriseWorkOverview = {
    ...needsInput,
    tasks: [{ interactionId: 'approval', runId: 'approval-run', teamId: 'forge', workflowId: 'approval', workflowVersion: 1, title: 'Approval', instructions: '核对后办理审批', updatedAt: resultOnly.loadedAt, source: 'forge', mode: 'approval' }],
    items: [...needsInput.items, ...(['completed', 'cancelled'] as const).map((status) => ({ ...needsInput.items[1]!, id: status, status }))],
  }
  await renderWork(overview)
  expect(badge()).toBe('2')
  expect(countFor('待我处理')).toBe('2')
})

it('keeps submitted approvals separate from the pending badge and work count', async () => {
  const submitted = { interactionId: 'submitted-order', runId: 'forge:submitted:submitted-order', teamId: 'forge', workflowId: 'business-approval', workflowVersion: 1,
    title: '合成销售订单', instructions: '审批中', updatedAt: resultOnly.loadedAt, source: 'forge' as const, mode: 'submitted' as const }
  const overview: EnterpriseWorkOverview = { ...resultOnly, submittedApprovals: [submitted] }
  expect(enterprisePendingWorkCount(overview)).toBe(0)
  await renderWork(overview)
  expect(badge()).toBeUndefined()
  expect(countFor('待我处理')).toBe('0')
  expect(countFor('我发起的工作')).toBe('1')
})

it('removes an old definite count while refreshing, after failure, or when account data is cleared', async () => {
  await renderWork(needsInput)
  expect(badge()).toBe('1')
  for (const [overview, loading, error] of [[needsInput, true, ''], [needsInput, false, '读取失败'], [undefined, false, '']] as const) {
    await renderWork(overview, loading, error)
    expect(badge()).toBeUndefined()
    expect(countFor('待我处理')).toBeUndefined()
    expect(container.textContent).not.toContain('当前没有待处理事项。')
  }
})

it.each(['weaveTasks', 'forgeApprovals', 'notifications'] as const)('does not claim a definite count from incomplete %s reads', async (source) => {
  for (const read of [{ status: 'failed' as const, error: '读取失败' }, { status: 'loaded' as const, truncated: true }]) {
    await renderWork({ ...needsInput, reads: { ...needsInput.reads, [source]: read } })
    expect(badge()).toBeUndefined()
    expect(countFor('待我处理')).toBeUndefined()
  }
})

it('preserves the local session attention badge outside enterprise mode', async () => {
  await renderWork(undefined, false, '', false)
  expect(badge()).toBe('1')
  await renderWork(undefined)
  expect(badge()).toBeUndefined()
  expect(container.querySelector('.session-row-wrap.has-attention')).not.toBeNull()
})
