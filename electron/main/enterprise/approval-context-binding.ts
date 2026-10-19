import type { EnterpriseApprovalContext, EnterpriseApprovalContextView } from '../../../src/types/api'
import { digest } from './handoff-store'

export function currentItemContextFingerprint(context: EnterpriseApprovalContext): string {
  return digest(JSON.stringify({
    requestId: context.requestId, status: context.status, viewer: context.viewer, title: context.title, step: context.step,
    businessObject: context.businessObject, sourceMaterialVersion: context.sourceMaterialVersion,
    availableActions: context.availableActions ?? null,
    returnVersion: context.returnVersion, returnReason: context.returnReason, fields: context.fields,
    quotationLines: context.quotationLines ?? null,
    files: context.files.map(({ fileId, name, mediaType, bytes, sha256 }) => ({ fileId, name, mediaType, bytes, sha256 })),
    originalFiles: context.originalFiles?.map(({ sourceKind, requestId, fileId, name, mediaType, bytes, sha256 }) => ({ sourceKind, requestId, fileId, name, mediaType, bytes, sha256 })),
  }))
}

export function approvalUiChoices(context: EnterpriseApprovalContext): Pick<EnterpriseApprovalContextView, 'actionVersion' | 'actions'> {
  if (context.status !== 'pending' || context.availableActions === undefined) return {}
  const actions = context.viewer === 'current_approver'
    ? context.availableActions.filter((action) => action.semantic === 'approve' || action.semantic === 'reject' || action.semantic === 'revise')
    : context.viewer === 'original_submitter'
      && context.businessObject.objectName === 'forge_sales_order'
      && context.availableActions.length === 1
      && context.availableActions[0]?.semantic === 'recall'
      && context.availableActions[0]?.execution.actionName === 'order_approval_mcp_recall'
        ? context.availableActions
        : []
  if (!actions.length) {
    return context.viewer === 'current_approver'
      ? { actionVersion: currentItemContextFingerprint(context), actions: [] }
      : {}
  }
  return {
    actionVersion: currentItemContextFingerprint(context),
    actions: actions.map((action) => ({
      actionRef: digest(JSON.stringify(action)), semantic: action.semantic!, label: action.label,
    })),
  }
}
