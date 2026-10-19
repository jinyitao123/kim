// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EnterpriseWorkPage } from '../../src/pages/EnterpriseWorkPage'
import { APPROVAL_REVIEW_SESSION_MARKER, openApprovalReviewInPi } from '../../src/lib/approval-review'
import type { EnterpriseApprovalContextView, EnterpriseHumanTask, EnterpriseWorkOverview, ProjectRecord, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const refresh = vi.fn()
const continueWork = vi.fn()
const assistPi = vi.fn(async () => undefined)

const overview: EnterpriseWorkOverview = {
  loadedAt: '2026-09-23T01:00:00Z',
  choices: [],
  tasks: [{ interactionId: 'approval-1', runId: 'forge:approval:approval-1', teamId: 'forge', workflowId: 'business-approval', workflowVersion: 1, title: '合同交付复核', instructions: '请核对合同', updatedAt: '2026-09-23T01:00:00Z', source: 'forge', mode: 'approval' }],
  items: [{ id: 'notice-1', kind: 'result', title: '合同团队已完成', status: 'unread', actionable: false, read: false, source: 'forge', createdAt: '2026-09-23T01:00:00Z' }],
  runs: [{ id: 'run-1', status: 'running', startedAt: '2026-09-23T01:00:00Z', durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }],
  reads: {
    runs: { status: 'loaded' }, teamChoices: { status: 'loaded' }, weaveTasks: { status: 'failed', error: '团队信息读取失败（503）' },
    forgeApprovals: { status: 'loaded' }, notifications: { status: 'failed', error: '通知读取失败（503）' },
  },
}

beforeEach(() => {
  refresh.mockClear()
  continueWork.mockClear()
  assistPi.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const workTab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.querySelector('.work-tab__label')?.textContent === label)
const openTab = async (label: string) => { await act(async () => workTab(label)?.click()) }

it.each([['reject', '拒绝订单'], ['revise', '退回修改']])('renders and submits the server-declared %s action with the viewed version', async (semantic, label) => {
  const actionRef = 'c'.repeat(64), actionVersion = 'd'.repeat(64)
  const context: EnterpriseApprovalContextView = { title: '当前审批', step: '复核', fields: [], files: [], actionVersion,
    actions: [{ actionRef, semantic, label }] }
  const complete = vi.fn(async () => undefined)
  await act(async () => root.render(<EnterpriseWorkPage overview={{ ...overview, items: [] }} loading={false} error="" onRefresh={refresh}
    onComplete={complete} onInspect={vi.fn(async () => context)} onAssist={assistPi} onContinue={continueWork} />))
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)
  expect(button(label)).toBeUndefined()
  await act(async () => button('查看材料')?.click())
  expect(button(label)?.disabled).toBe(true)
  if (semantic === 'reject') expect(button('退回修改')).toBeUndefined()
  const textarea = container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '本人明确意见')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(button(label)?.disabled).toBe(false)
  await act(async () => button(label)?.click())
  expect(complete).toHaveBeenCalledExactlyOnceWith(overview.tasks[0], actionRef, '本人明确意见', actionVersion)
  expect(container.textContent).not.toContain(actionRef)
})

it('shows submitted orders separately and sends only the viewed recall action with its reason', async () => {
  const task: EnterpriseHumanTask = {
    interactionId: 'submitted-order-1', runId: 'forge:submitted:submitted-order-1', teamId: 'forge', workflowId: 'business-approval', workflowVersion: 1,
    title: '合成销售订单', instructions: '你发起的销售订单仍在审批中。查看当前冻结版本后，可填写原因撤回申请。',
    updatedAt: overview.loadedAt, source: 'forge', mode: 'submitted',
  }
  const context: EnterpriseApprovalContextView = {
    title: '合成销售订单', step: '订单复核', fields: [{ label: '订单金额', value: '¥20,000' }], files: [],
    actionVersion: 'd'.repeat(64),
    actions: [{ actionRef: 'c'.repeat(64), semantic: 'recall', label: '撤回订单审批' }],
  }
  const complete = vi.fn(async () => undefined)
  await act(async () => root.render(<EnterpriseWorkPage overview={{ ...overview, tasks: [], submittedApprovals: [task], items: [], reads: {
    runs: { status: 'loaded' }, teamChoices: { status: 'loaded' }, weaveTasks: { status: 'loaded' }, forgeApprovals: { status: 'loaded' }, notifications: { status: 'loaded' },
  } }} loading={false} error="" onRefresh={refresh}
    onComplete={complete} onInspect={vi.fn(async () => context)} onAssist={assistPi} onContinue={continueWork} />))
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)
  expect(workTab('待我处理')?.querySelector('.work-tab__count')?.textContent).toBe('0')
  expect(container.textContent).toContain('当前没有待处理事项。')
  await openTab('我发起的工作')
  expect(container.textContent).toContain('我发起的审批')
  expect(container.textContent).toContain('审批中')
  expect(container.textContent).not.toContain('待处理')
  await act(async () => button('查看冻结版本')?.click())
  expect(container.textContent).toContain('¥20,000')
  const reason = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="撤回原因"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(reason, '合成撤回验证')
    reason.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(button('撤回订单审批')?.disabled).toBe(false)
  await act(async () => button('撤回订单审批')?.click())
  expect(complete).toHaveBeenCalledExactlyOnceWith(task, 'c'.repeat(64), '合成撤回验证', 'd'.repeat(64))
  expect(assistPi).not.toHaveBeenCalled()
})

it('shows complete frozen quotation rows and passes them to readonly Pi review without identity fields', async () => {
  const context: EnterpriseApprovalContextView = { title: '测试报价', step: '报价复核', fields: [], files: [], quotationLines: {
    version: '1', pricingVersion: 1, itemCount: 2, totalAmount: 2100, rows: [
      { position: 1, name: '视觉设备', lineType: 'material', quantity: 2, taxedUnitPrice: 900, taxRate: 0, discountRate: 0, taxedSubtotal: 1800, unitName: '台' },
      { position: 2, name: '安装培训', lineType: 'service', quantity: 1, taxedUnitPrice: 300, taxRate: 0, discountRate: 0, taxedSubtotal: 300 },
    ],
  } }
  await act(async () => root.render(<EnterpriseWorkPage overview={{ ...overview, items: [] }} loading={false} error="" onRefresh={refresh}
    onComplete={vi.fn(async () => undefined)} onInspect={vi.fn(async () => context)} onAssist={assistPi} onContinue={continueWork} />))
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '查看材料')?.click())
  const table = container.querySelector('.work-quotation-lines table')!
  expect(table.textContent).toContain('视觉设备')
  expect(table.textContent).toContain('安装培训')
  expect(table.textContent).toContain('1800')
  expect(container.textContent).toContain('提交核价版本 1 · 2 项 · 合计 2100')
  const queuePrompt = vi.fn(), workspaceRef = { current: { project: undefined } }
  await openApprovalReviewInPi(overview.tasks[0], {
    enterprise: { pinApprovalReviewContext: vi.fn(async () => ({ handle: 'host-owned-context', context })) },
    newSession: () => { workspaceRef.current.project = {} as never; return true },
    workspace: { workspaceRef, queuePrompt }, setToast: vi.fn(),
  })
  expect(queuePrompt.mock.calls[0][0]).toContain('数量 2 台，含税单价 900')
  expect(queuePrompt.mock.calls[0][0]).toContain('当前打开仍只授权查看')
  expect(queuePrompt.mock.calls[0][0]).not.toContain('host-owned-context')
})

it('shows available work beside source-specific errors and offers retry without claiming the inbox is empty', async () => {
  await act(async () => root.render(<EnterpriseWorkPage
    overview={overview} loading={false} error="" onRefresh={refresh}
    onComplete={vi.fn(async () => undefined)} onInspect={vi.fn(async () => ({ title: '', step: '', fields: [], files: [] }))}
    onAssist={assistPi}
    onContinue={continueWork}
  />))

  expect(container.textContent).toContain('合同交付复核')
  expect(container.textContent).toContain('团队人工步骤暂时不可用：团队信息读取失败（503）')
  expect(container.textContent).toContain('工作通知暂时不可用：通知读取失败（503）')
  expect(container.textContent).not.toContain('当前没有待处理事项。')

  const retries = [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === '重试读取')
  expect(retries).toHaveLength(1)
  await act(async () => retries[0]!.click())
  expect(refresh).toHaveBeenCalledOnce()

  await openTab('我发起的工作')
  expect(container.textContent).toContain('团队执行 · 处理中')
  await openTab('工作消息')
  expect(container.textContent).toContain('合同团队已完成')
  expect(container.textContent).toContain('Forge 业务通知')
  expect(container.textContent).toContain('工作通知暂时不可用：通知读取失败（503）')

  const unsafeContinuation = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '原工作暂不可续接')
  expect(unsafeContinuation?.disabled).toBe(true)
  await act(async () => unsafeContinuation?.click())
  expect(continueWork).not.toHaveBeenCalled()
})

it('keeps a native Weave team-run notification openable when its source is resolved on click', async () => {
  const item = { ...overview.items[0]!, source: 'weave' as const, notificationType: 'weave.team_run.result' }
  await act(async () => root.render(<EnterpriseWorkPage
    overview={{ ...overview, items: [item], reads: { ...overview.reads, notifications: { status: 'loaded' } } }}
    loading={false} error="" onRefresh={refresh}
    onComplete={vi.fn(async () => undefined)} onInspect={vi.fn(async () => ({ title: '', step: '', fields: [], files: [] }))}
    onAssist={assistPi}
    onContinue={continueWork}
  />))

  await openTab('工作消息')
  const continueButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '交给助手查看')
  expect(continueButton?.disabled).toBe(false)
  await act(async () => continueButton?.click())
  expect(continueWork).toHaveBeenCalledWith(item)
})

it('keeps a resolved needs-input notice in work messages and lets the employee open it in Pi', async () => {
  const item = {
    ...overview.items[0]!, id: 'notice-needs-input', kind: 'revision_required' as const, title: '团队结果与业务回执', status: 'completed' as const,
    actionable: false, source: 'weave' as const, notificationType: 'weave.team_run.revision_required',
    workReference: '550e8400-e29b-41d4-a716-446655440101', runReference: 'run-succeeded', sessionReference: 'work-session-1',
    summary: 'Forge 业务动作已确认成功。团队列出的缺项是检查意见，后续办理事项以 Forge 当前正式事项为准。',
  }
  await act(async () => root.render(<EnterpriseWorkPage
    overview={{ ...overview, tasks: [], items: [item], reads: { ...overview.reads, weaveTasks: { status: 'loaded' }, notifications: { status: 'loaded' } } }}
    loading={false} error="" onRefresh={refresh}
    onComplete={vi.fn(async () => undefined)} onInspect={vi.fn(async () => ({ title: '', step: '', fields: [], files: [] }))}
    onAssist={assistPi} onContinue={continueWork}
  />))

  await openTab('工作消息')
  expect(container.textContent).toContain('工作消息')
  expect(container.textContent).toContain('团队结果与业务回执')
  expect(container.textContent).toContain('缺项是检查意见')
  expect(container.textContent).not.toContain('团队需要补充')
  const continueButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '交给助手查看')
  expect(continueButton?.disabled).toBe(false)
  await act(async () => continueButton?.click())
  expect(continueWork).toHaveBeenCalledWith(item)
})

it('labels a Weave notification body as a run message summary', async () => {
  const item = { ...overview.items[0]!, source: 'weave' as const, notificationType: 'weave.team_run.result', summary: '已提交至业务系统' }
  await act(async () => root.render(<EnterpriseWorkPage
    overview={{ ...overview, items: [item], reads: { ...overview.reads, notifications: { status: 'loaded' } } }}
    loading={false} error="" onRefresh={refresh}
    onComplete={vi.fn(async () => undefined)} onInspect={vi.fn(async () => ({ title: '', step: '', fields: [], files: [] }))}
    onAssist={assistPi} onContinue={continueWork}
  />))

  await openTab('工作消息')
  expect(container.textContent).toContain('运行消息摘要：已提交至业务系统')
  expect(container.textContent).not.toContain('团队文本摘要（非业务回执）')
})

it('opens a typed Forge result message through the source resolver without inferring a record from its text', async () => {
  const item = { ...overview.items[0]!, source: 'forge' as const, kind: 'result' as const, notificationType: 'sales.contract.approved' }
  await act(async () => root.render(<EnterpriseWorkPage
    overview={{ ...overview, items: [item], reads: { ...overview.reads, notifications: { status: 'loaded' } } }}
    loading={false} error="" onRefresh={refresh}
    onComplete={vi.fn(async () => undefined)} onInspect={vi.fn(async () => ({ title: '', step: '', fields: [], files: [] }))}
    onAssist={assistPi} onContinue={continueWork}
  />))

  await openTab('工作消息')
  const continueButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '交给助手查看')
  expect(continueButton?.disabled).toBe(false)
  await act(async () => continueButton?.click())
  expect(continueWork).toHaveBeenCalledWith(item)
})

it('lets a reviewer send the verified approval snapshot and files to Pi for read-only analysis', async () => {
  const context: EnterpriseApprovalContextView = {
    title: '合同交付复核', step: '交付与商务会签',
    fields: [{ label: '合同编号', value: 'MVP1-C-001' }],
    files: [{ name: '合同正文.md', content: '合同正文原文', verified: true }],
  }
  const inspect = vi.fn(async () => context)
  await act(async () => root.render(<EnterpriseWorkPage
    overview={{ ...overview, items: [], reads: { ...overview.reads, weaveTasks: { status: 'loaded' }, notifications: { status: 'loaded' } } }}
    loading={false} error="" onRefresh={refresh}
    onComplete={vi.fn(async () => undefined)} onInspect={inspect} onAssist={assistPi} onContinue={continueWork}
  />))

  const viewMaterials = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '查看材料')
  await act(async () => viewMaterials?.click())
  const assistButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '让助手协助复核')
  expect(assistButton?.disabled).toBe(false)
  await act(async () => assistButton?.click())
  expect(assistPi).toHaveBeenCalledWith(overview.tasks[0])
})

it('opens the clicked Forge approval in a fresh renderer session and queues only its pinned snapshot', async () => {
  const context: EnterpriseApprovalContextView = {
    title: '本轮审批', step: '交付会签', returnReason: '补充验收范围',
    fields: [{ label: '版本', value: 'R2' }],
    files: [{ name: 'R2合同.docx', content: 'R2 原文', verified: true }],
  }
  const enterprise = { pinApprovalReviewContext: vi.fn(async () => ({ handle: 'review-context-handle', context })) }
  const workspaceRef = { current: { project: { id: 'project' } as ProjectRecord, session: undefined as SessionRecord | undefined, sessionFile: undefined as string | undefined } }
  const queuePrompt = vi.fn()
  const workspace = { workspaceRef, queuePrompt } as unknown as Parameters<typeof openApprovalReviewInPi>[1]['workspace']
  const newSession = vi.fn((_project?: ProjectRecord, _options?: { preserveComposerDraft?: boolean }) => true)
  const setToast = vi.fn()
  const onAssist = vi.fn((task) => openApprovalReviewInPi(task, { enterprise, newSession, workspace, setToast }))
  const inspect = vi.fn(async () => context)

  await act(async () => root.render(<EnterpriseWorkPage
    overview={{ ...overview, items: [], reads: { ...overview.reads, weaveTasks: { status: 'loaded' }, notifications: { status: 'loaded' } } }}
    loading={false} error="" onRefresh={refresh}
    onComplete={vi.fn(async () => undefined)} onInspect={inspect} onAssist={onAssist} onContinue={continueWork}
  />))
  const viewMaterials = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '查看材料')
  await act(async () => viewMaterials?.click())
  const assistButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '让助手协助复核')
  await act(async () => assistButton?.click())

  expect(enterprise.pinApprovalReviewContext).toHaveBeenCalledWith('approval-1')
  expect(newSession).toHaveBeenCalledWith(undefined, { preserveComposerDraft: true })
  expect(queuePrompt).toHaveBeenCalledOnce()
  const [prompt, intent, , , , , contextHandle] = queuePrompt.mock.calls[0] as unknown as [string, string, unknown, unknown, unknown, unknown, string]
  expect(intent).toBe('queue')
  expect(contextHandle).toBe('review-context-handle')
  expect(prompt).toContain('R2 原文')
  expect(prompt).toContain('历史聊天不作为当前事实')
  expect(prompt).toContain('当前打开只授权只读核对')
  expect(prompt).toContain('不等于审批流程完成')
  expect(prompt).toContain(APPROVAL_REVIEW_SESSION_MARKER)
  expect(prompt).toContain('无需再要求我说固定词“办理”或“提交”')
  expect(prompt).toContain('“我倾向同意”“如果条件满足就同意”“你觉得该同意吗”、建议和转述都不构成办理授权')
  expect(setToast).toHaveBeenCalledWith('已打开本次审批材料，可继续和 Pi 核对。')
})

it('opens assigned business work by its authoritative record and leaves ambiguous assignment non-actionable', async () => {
  const record = { objectName: 'forge_sales_contract', recordId: 'contract-current', label: '当前合同' }
  const onOpenBusiness = vi.fn(async () => undefined)
  await act(async () => root.render(<EnterpriseWorkPage
    overview={{ ...overview, tasks: [], items: [], businessWork: [
      { workKey: 'a'.repeat(64), kind: 'contract_signature', title: '登记签署：当前合同', record, recordVersion: '1', updatedAt: '2026-10-03T00:00:00Z', assignment: 'assigned' },
      { workKey: 'b'.repeat(64), kind: 'sales_order_submission', title: '提交订单', record, recordVersion: '1', updatedAt: '2026-10-03T00:00:00Z', assignment: 'needs_assignment', assignmentReason: 'multiple_eligible_employees' },
    ] }} loading={false} error="" onRefresh={refresh} onComplete={vi.fn(async () => undefined)}
    onInspect={vi.fn(async () => ({ title: '', step: '', fields: [], files: [] }))} onAssist={vi.fn(async () => undefined)} onContinue={continueWork} onOpenBusiness={onOpenBusiness}
  />))
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === '交给助手查看')
  expect(buttons).toHaveLength(1)
  await act(async () => buttons[0].click())
  expect(onOpenBusiness).toHaveBeenCalledExactlyOnceWith(record)
  expect(container.textContent).toContain('有多位符合条件的员工')
  expect(container.textContent).not.toContain('contract-current')
  const workRows = container.querySelectorAll('.work-card')
  expect(workRows).toHaveLength(2)
  expect(workRows[0].querySelector('.work-card__summary')).toBeNull()
  expect(workRows[1].querySelector('.work-card__summary')?.textContent).toBe('当前合同 · 待明确负责人：有多位符合条件的员工')
  await act(async () => (workRows[1] as HTMLButtonElement).click())
  expect([...container.querySelectorAll('button')].some((button) => button.textContent === '交给助手查看')).toBe(false)
})

it('keeps the approval on the work page when a fresh renderer session cannot be opened', async () => {
  const context: EnterpriseApprovalContextView = {
    title: '本轮审批', step: '交付会签', fields: [],
    files: [{ name: 'R2合同.docx', content: 'R2 原文', verified: true }],
  }
  const enterprise = { pinApprovalReviewContext: vi.fn(async () => ({ handle: 'review-context-handle', context })) }
  const workspace = {
    workspaceRef: { current: { project: { id: 'project' } as ProjectRecord, session: undefined as SessionRecord | undefined, sessionFile: undefined as string | undefined } },
    queuePrompt: vi.fn(),
  } as unknown as Parameters<typeof openApprovalReviewInPi>[1]['workspace']
  const newSession = vi.fn(() => false)
  const onAssist = (task: (typeof overview.tasks)[number]) => openApprovalReviewInPi(task, { enterprise, newSession, workspace, setToast: vi.fn() })

  await act(async () => root.render(<EnterpriseWorkPage
    overview={{ ...overview, items: [], reads: { ...overview.reads, weaveTasks: { status: 'loaded' }, notifications: { status: 'loaded' } } }}
    loading={false} error="" onRefresh={refresh}
    onComplete={vi.fn(async () => undefined)} onInspect={vi.fn(async () => context)} onAssist={onAssist} onContinue={continueWork}
  />))
  const viewMaterials = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '查看材料')
  await act(async () => viewMaterials?.click())
  const assistButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '让助手协助复核')
  await act(async () => assistButton?.click())

  expect(workspace.queuePrompt).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法创建独立审批辅助会话')
})

it('opens a parked original run from the normal work row with neutral waiting copy and no continue claim', async () => {
  const runID = 'run-550e8400-e29b-41d4-a716-446655440999'
  await act(async () => root.render(<EnterpriseWorkPage
    overview={{ ...overview, items: [], tasks: [], runs: [{ ...overview.runs[0]!, id: runID, status: 'parked', step: '合同处理' }] }} loading={false} error="" onRefresh={refresh}
    onComplete={vi.fn(async () => undefined)} onInspect={vi.fn(async () => ({ title: '', step: '', fields: [], files: [] }))} onAssist={assistPi} onContinue={continueWork}
  />))
  await openTab('我发起的工作')
  expect(container.textContent).toContain('团队执行 · 等待中')
  expect(container.textContent).not.toContain('等待处理')
  expect(container.textContent).not.toContain('待处理事项')
  expect(container.textContent).not.toContain(runID)
  const open = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '查看原工作')!
  await act(async () => open.click())
  expect(continueWork).toHaveBeenCalledWith(expect.objectContaining({ id: runID, source: 'weave', notificationType: 'weave.workbench_run', actionable: false }))
  await openTab('待我处理')
  expect(container.querySelectorAll('.work-card')).toHaveLength(0)
})

it('cancels the clicked original work row and labels a pending stop without claiming it is already cancelled', async () => {
  const cancel = vi.fn(async () => undefined)
  const current = { ...overview.runs[0]!, status: 'cancel_requested' }
  await act(async () => root.render(<EnterpriseWorkPage overview={{ ...overview, items: [], tasks: [], runs: [current] }} loading={false} error="" onRefresh={refresh}
    onComplete={vi.fn(async () => undefined)} onInspect={vi.fn(async () => ({ title: '', step: '', fields: [], files: [] }))} onAssist={assistPi} onContinue={continueWork} onCancel={cancel} />))
  await openTab('我发起的工作')
  expect(container.textContent).toContain('取消中')
  expect(container.textContent).not.toContain('已取消')
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '核对取消')!
  await act(async () => button.click())
  expect(cancel).toHaveBeenCalledWith(current)
})

it('keeps unassigned business work out of the filter counts and lists it in its own group', async () => {
  const record = { objectName: 'forge_sales_contract', recordId: 'contract-current', label: '当前合同' }
  await act(async () => root.render(<EnterpriseWorkPage
    overview={{ ...overview, items: [], reads: { ...overview.reads, weaveTasks: { status: 'loaded' }, notifications: { status: 'loaded' } }, businessWork: [
      { workKey: 'b'.repeat(64), kind: 'sales_order_submission', title: '提交订单', record, recordVersion: '1', updatedAt: '2026-10-03T00:00:00Z', assignment: 'needs_assignment', assignmentReason: 'multiple_eligible_employees' },
      { workKey: 'a'.repeat(64), kind: 'contract_signature', title: '登记签署：当前合同', record, recordVersion: '1', updatedAt: '2026-10-03T00:00:00Z', assignment: 'assigned' },
    ] }} loading={false} error="" onRefresh={refresh} onComplete={vi.fn(async () => undefined)}
    onInspect={vi.fn(async () => ({ title: '', step: '', fields: [], files: [] }))} onAssist={assistPi} onContinue={continueWork} onOpenBusiness={vi.fn(async () => undefined)}
  />))
  const chip = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.work-filters button')].find((button) => button.textContent?.startsWith(label))
  expect(workTab('待我处理')?.querySelector('.work-tab__count')?.textContent).toBe('2')
  expect(chip('全部')?.textContent).toBe('全部2')
  expect(chip('业务事项')?.textContent).toBe('业务事项1')
  expect(container.querySelector('.work-list__group')?.textContent).toContain('待明确负责人')
  const titles = [...container.querySelectorAll('.work-card__top strong')].map((element) => element.textContent)
  expect(titles).toEqual(['合同交付复核', '登记签署：当前合同', '提交订单'])
})

it('does not repeat the task title as the approval material heading', async () => {
  const context: EnterpriseApprovalContextView = { title: '合同交付复核', step: '交付会签', fields: [{ label: '合同编号', value: 'C-1' }], files: [] }
  await act(async () => root.render(<EnterpriseWorkPage overview={{ ...overview, items: [] }} loading={false} error="" onRefresh={refresh}
    onComplete={vi.fn(async () => undefined)} onInspect={vi.fn(async () => context)} onAssist={assistPi} onContinue={continueWork} />))
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '查看材料')?.click())
  expect(container.querySelector('.work-approval-context h3')).toBeNull()
  expect(container.querySelector('.work-approval-context small')?.textContent).toBe('交付会签')
  expect(container.querySelectorAll('h2')).toHaveLength(1)
})
