import type { EnterpriseService, EnterpriseWeaveWorkNotificationSource, EnterpriseWorkNotificationSource } from '../enterprise'
import type { EnterpriseHumanTask, EnterpriseWorkChoice, EnterpriseWorkItem, EnterpriseWorkOverview, EnterpriseWorkReadStatus, EnterpriseRunObservation } from '../../../src/types/api'
import { inboxWorkItems, type WorkbenchRunLookupResponse } from './work-sources'

interface WorkOverviewAccess {
  getTeamCatalog: EnterpriseService['getTeamCatalog']
  getTeamChoices: EnterpriseService['getTeamChoices']
  weaveJSON(path: string): Promise<unknown>
  forgeJSON(path: string, label: string): Promise<unknown>
  lookupWorkbenchRuns(runIds: string[]): Promise<WorkbenchRunLookupResponse>
  readHumanTask(references: { runId: string; interactionId: string; workReference: string; sessionReference: string }): Promise<EnterpriseHumanTask | undefined>
  readWorkNotificationSource(id: string): Promise<EnterpriseWorkNotificationSource>
  assertCurrent(): void
}
/** Read and project the current employee's original sources; this creates no work-item store. */
export async function readEmployeeWorkOverview(projectID: string, access: WorkOverviewAccess): Promise<EnterpriseWorkOverview> {
  const read = async <T>(operation: () => Promise<T>): Promise<{ value?: T; error?: string }> => {
    try { return { value: await operation() } }
    catch (error) { return { error: error instanceof Error ? error.message : '读取失败' } }
  }
  const [teamsRead, runsRead, notificationsRead, approvalsRead, businessRead] = await Promise.all([
    read(() => access.getTeamCatalog()),
    read(() => access.weaveJSON(`/v1/runs?project_id=${encodeURIComponent(projectID)}&limit=50`)),
    read(async () => {
      const { readInboxPages } = await import('./inbox-pages')
      return readInboxPages((path) => access.forgeJSON(path, '通知'))
    }),
    read(async () => {
      const { readApprovalWorkPages } = await import('./inbox-pages')
      return readApprovalWorkPages((path) => access.forgeJSON(path, '审批事项'))
    }),
    read(async () => {
      const { readBusinessWork } = await import('./business-work')
      return readBusinessWork((path) => access.forgeJSON(path, '本人业务事项'))
    }),
  ])
  const choices: EnterpriseWorkChoice[] = []
  let teamChoicesError = teamsRead.error
  if (teamsRead.value) {
    const workflowReads = await Promise.all(teamsRead.value.map((team) => read(() => access.getTeamChoices(team))))
    for (const result of workflowReads) {
      if (result.value) choices.push(...result.value)
      else if (result.error) teamChoicesError ??= result.error
    }
  }
  const approvals = approvalsRead.value?.items ?? []
  const toApprovalTask = (approval: (typeof approvals)[number]): EnterpriseHumanTask => ({
    interactionId: approval.requestId, runId: `forge:${approval.mode}:${approval.requestId}`,
    teamId: 'forge', workflowId: 'business-approval', workflowVersion: 1,
    title: approval.title,
    instructions: approval.mode === 'submitted'
      ? '你发起的销售订单仍在审批中。查看当前冻结版本后，可填写原因撤回申请。'
      : approval.mode === 'revision'
      ? approval.returnReason ? `退回原因：${approval.returnReason}` : '请根据审批意见协助员工修改业务材料。'
      : `请核对${approval.stepLabel ?? approval.processLabel ?? '业务材料'}并给出审批意见。`,
    updatedAt: approval.updatedAt, source: 'forge', mode: approval.mode,
    ...(approval.materialLabel ? { materialLabel: approval.materialLabel } : {}),
  })
  const tasks = approvals.filter((approval) => approval.mode !== 'submitted').map(toApprovalTask)
  const submittedApprovals = approvals.filter((approval) => approval.mode === 'submitted').map(toApprovalTask)
  const notificationPage = notificationsRead.value
  const items = inboxWorkItems(notificationPage?.notifications ?? [])
  const weaveActionItems = items.filter((item) => item.source === 'weave' && item.actionable)
  const sources = new Map<string, EnterpriseWeaveWorkNotificationSource>()
  const sourceErrors: string[] = []
  await mapConcurrent(weaveActionItems, 8, async (item) => {
    try {
      const source = await access.readWorkNotificationSource(item.id)
      if (source.kind === 'business' || item.notificationType !== `weave.team_run.${source.kind}`
        || item.kind === 'human_review' && source.kind !== 'human_review'
        || item.kind === 'revision_required' && source.kind !== 'revision_required') {
        throw new Error('工作消息来源与当前通知主题不匹配')
      }
      sources.set(item.id, source)
    } catch (error) {
      sourceErrors.push(error instanceof Error ? error.message : '工作消息来源读取失败')
    }
  })
  const runReferences = [...new Set([...sources.values()].map((source) => source.source.runReference))]
  let lookups: WorkbenchRunLookupResponse | undefined
  let lookupError: string | undefined
  if (runReferences.length) {
    try {
      lookups = await access.lookupWorkbenchRuns(runReferences)
      const resolved = new Set([...lookups.runs.map((run) => run.runId), ...lookups.missing])
      if (resolved.size !== runReferences.length || runReferences.some((runId) => !resolved.has(runId))) {
        throw new Error('Weave 返回的运行来源与本次查询不一致')
      }
    } catch (error) {
      lookupError = error instanceof Error ? error.message : '团队运行来源读取失败'
    }
  }
  const runById = new Map((lookups?.runs ?? []).map((run) => [run.runId, run]))
  const missingRuns = new Set(lookups?.missing ?? [])
  const humanTasksError: string[] = []
  const consumedHumanReview = new Set<string>()
  const humanInteractions = new Set<string>()
  const projectedById = new Map<string, EnterpriseWorkItem>()
  for (const item of items) {
    if (item.source !== 'weave' || !item.actionable) {
      projectedById.set(item.id, item)
      continue
    }
    const source = sources.get(item.id)
    if (!source) {
      projectedById.set(item.id, { ...item, actionable: false, status: 'unknown' })
      continue
    }
    const run = runById.get(source.source.runReference)
    const sourceMatches = run?.inputRevisionID === source.source.workReference
      && run.workbenchSessionID === source.source.sessionReference
    const withSource: EnterpriseWorkItem = {
      ...item,
      workReference: source.source.workReference,
      runReference: source.source.runReference,
      sessionReference: source.source.sessionReference,
    }
    if (!run || missingRuns.has(source.source.runReference) || !sourceMatches) {
      projectedById.set(item.id, { ...item, actionable: false, status: 'unknown' })
      continue
    }
    if (item.kind === 'human_review') {
      if (!run.isCurrent || run.status !== 'parked' || !source.source.interactionReference) {
        projectedById.set(item.id, { ...withSource, actionable: false, status: 'completed', summary: '团队人工步骤已不再等待处理。' })
        continue
      }
      try {
        const task = await access.readHumanTask({
          runId: source.source.runReference, interactionId: source.source.interactionReference,
          workReference: source.source.workReference, sessionReference: source.source.sessionReference,
        })
        if (task) {
          const key = `${task.runId}:${task.interactionId}`
          if (!humanInteractions.has(key)) { tasks.push(task); humanInteractions.add(key) }
          consumedHumanReview.add(item.id)
          continue
        }
        projectedById.set(item.id, { ...withSource, actionable: false, status: 'completed', summary: '团队人工步骤已不再等待处理。' })
      } catch (error) {
        humanTasksError.push(error instanceof Error ? error.message : '团队人工步骤读取失败')
        projectedById.set(item.id, { ...item, actionable: false, status: 'unknown' })
      }
      continue
    }
    const result = run.businessResult
    if (!run.isCurrent || result === 'completed' || result === 'action_failed' || result === 'action_unknown') {
      projectedById.set(item.id, {
        ...withSource, actionable: false, status: 'completed',
        ...(result === 'completed' ? { title: '团队结果与业务回执', summary: '本轮团队工作已完成。后续办理事项和审批状态以 Forge 当前正式事项为准。' }
          : result === 'action_failed' ? { title: '业务动作失败', summary: '本轮业务动作失败，请核对 Forge 回执和当前业务状态；不要重放原请求。' }
            : result === 'action_unknown' ? { title: '业务动作结果待核对', summary: '本轮业务动作结果未知，请先核对 Forge 回执；不要重放原请求。' }
              : { summary: '后续输入已替代这条工作消息。' }),
      })
      continue
    }
    if (result === 'needs_input' || run.status === 'parked') projectedById.set(item.id, withSource)
    else projectedById.set(item.id, { ...item, actionable: false, status: 'unknown' })
  }
  const runList = record(runsRead.value)
  access.assertCurrent()
  const readStatus = (error?: string): EnterpriseWorkReadStatus => error ? { status: 'failed', error } : { status: 'loaded' }
  return {
    loadedAt: new Date().toISOString(), choices, tasks, submittedApprovals, businessWork: businessRead.value?.items ?? [],
    items: items.filter((item) => !consumedHumanReview.has(item.id)).map((item) => projectedById.get(item.id) ?? item),
    runs: (Array.isArray(runList?.runs) ? runList.runs : []).flatMap((run) => runObservation(run) ?? []),
    reads: {
      runs: readStatus(runsRead.error), teamChoices: readStatus(teamChoicesError),
      weaveTasks: readStatus(notificationsRead.error ?? notificationsRead.value?.error ?? lookupError ?? (humanTasksError.length ? [...new Set(humanTasksError)].join('；') : undefined)),
      forgeApprovals: readStatus(approvalsRead.error ?? approvalsRead.value?.error),
      businessWork: readStatus(businessRead.error ?? businessRead.value?.error),
      notifications: readStatus(notificationsRead.error ?? notificationsRead.value?.error ?? (sourceErrors.length ? [...new Set(sourceErrors)].join('；') : undefined)),
    },
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}


function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}


function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}


async function mapConcurrent<T>(values: T[], limit: number, operation: (value: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= values.length) return
      await operation(values[index]!)
    }
  }))
}


function runObservation(value: unknown): EnterpriseRunObservation | undefined {
  const source = record(value)
  const id = textValue(source?.run_id)
  const status = textValue(source?.status)
  if (!id || !status) return undefined
  return {
    id, status, durationMs: Math.max(0, numberValue(source?.duration_ms) ?? 0), tokensIn: Math.max(0, numberValue(source?.tokens_in) ?? 0),
    tokensOut: Math.max(0, numberValue(source?.tokens_out) ?? 0), costUsd: Math.max(0, numberValue(source?.cost_usd) ?? 0),
    ...(textValue(source?.agent) ? { agent: textValue(source?.agent) } : {}), ...(textValue(source?.step) ? { step: textValue(source?.step) } : {}),
    ...(textValue(source?.started_at) ? { startedAt: textValue(source?.started_at) } : {}),
  }
}
