import { taskScopeSHA256, type ForgeTaskScope, type FixedWorkSource } from '../../electron/main/enterprise/task-handoff'
import { submissionUUID } from '../../electron/main/enterprise/handoff-store'

export function delegationResponse(scope: ForgeTaskScope, id: string, organizationID = 'forge-org') {
  return { version: '1', token_type: 'forge_task', access_token: 'task-token-for-this-input', grant_id: 'grant-fixture', generation: 1,
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 20 * 60_000).toISOString(), scope_sha256: taskScopeSHA256(scope), scope,
    subject: { id, organization_id: organizationID }, issuer: 'http://forge', identity_issuer: 'forge:test-deployment' }
}
export function fixedSource(accountKey: string): FixedWorkSource {
  return { accountKey, idempotencySeed: 'fixed-employee-intent', sessionKey: 'session', resources: [], authorizedBusinessCapabilityIds: [], sourceMessages: [{ messageId: 'employee-message', eventSeq: 1, sha256: 'a'.repeat(64) }], assertCurrent: async () => {},
    fixDelegationIntent: async (inputRevisionID) => ({ inputRevisionID, requestID: submissionUUID(`${inputRevisionID}:issue`) }) }
}
