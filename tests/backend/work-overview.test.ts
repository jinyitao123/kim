import { expect, it } from 'vitest'
import { readEmployeeWorkOverview } from '../../electron/main/enterprise/work-overview'

it('keeps submitted approvals outside the employee to-do task list', async () => {
  const submitted = { requestId: 'submitted-order', mode: 'submitted', title: '合成销售订单', updatedAt: '2026-10-03T00:00:00Z' }
  const approval = { requestId: 'pending-approval', mode: 'approval', title: '待复核销售订单', updatedAt: '2026-10-03T00:01:00Z' }
  const access = {
    getTeamCatalog: async () => [],
    getTeamChoices: async () => [],
    weaveJSON: async () => ({ runs: [] }),
    forgeJSON: async (path: string) => {
      if (path.startsWith('/api/v1/workbench/approvals')) return { version: '1', items: [submitted, approval] }
      if (path.startsWith('/api/v1/apps/forge/workbench/inbox')) return { version: '1', notifications: [], next_cursor: null, has_more: false }
      if (path.startsWith('/api/v1/workbench/business-work')) return { version: '1', readStatus: 'complete', items: [], observedAt: '2026-10-03T00:02:00Z' }
      throw new Error(`unexpected Forge path: ${path}`)
    },
    lookupWorkbenchRuns: async () => ({ runs: [], missing: [] }),
    readHumanTask: async () => undefined,
    readWorkNotificationSource: async () => { throw new Error('not used') },
    assertCurrent: () => undefined,
  }

  const overview = await readEmployeeWorkOverview('project', access)
  expect(overview.tasks.map((task) => task.interactionId)).toEqual(['pending-approval'])
  expect(overview.submittedApprovals).toMatchObject([{ interactionId: 'submitted-order', mode: 'submitted', runId: 'forge:submitted:submitted-order' }])
})
