/** Stable transcript marker used to restore a review session's read-only Host scope after restart. */
import type { EnterpriseApprovalContextView, EnterpriseHumanTask } from '../types/api'
import { quotationApprovalText } from './quotation-approval-presentation'

export const APPROVAL_REVIEW_SESSION_MARKER = '此会话只用于当前审批事项的只读辅助。'

interface ApprovalReviewEnterprise {
  pinApprovalReviewContext(requestId: string): Promise<{ handle: string; context: EnterpriseApprovalContextView }>
}

export interface ApprovalReviewWorkspace {
  workspaceRef: { current: { project?: object; session?: object; sessionFile?: string } }
  queuePrompt: unknown
}
type StartNewSession = (requestedProject: undefined, options: { preserveComposerDraft: true }) => boolean

export async function openApprovalReviewInPi(
  task: EnterpriseHumanTask,
  options: {
    enterprise: ApprovalReviewEnterprise | null
    newSession: StartNewSession
    workspace: ApprovalReviewWorkspace
    setToast(message: string): void
  },
): Promise<void> {
  if (task.source !== 'forge' || !options.enterprise) throw new Error('当前事项没有可读取的 Forge 审批上下文')
  const binding = await options.enterprise.pinApprovalReviewContext(task.interactionId)
  const context = binding.context
  const originalFiles = context.originalFiles ?? []
  if (context.files.some((file) => !file.verified || !file.content)
    || originalFiles.some((file) => !file.verified || !file.extraction.content)) {
    throw new Error('审批材料尚未完整核验，不能交给 Pi 分析')
  }
  const fields = context.fields.map((field) => `- ${field.label}：${field.value}`).join('\n')
  const files = context.files.map((file) => `## ${file.name}\n${file.content}`).join('\n\n')
  const originals = originalFiles.map((file) => `## ${file.name}（原件已校验，${file.bytes} 字节，提取状态：${file.extraction.status}）\n${file.extraction.content}`).join('\n\n')
  const prompt = [
    `请只读复核当前 Forge 审批事项「${context.title}」，当前环节为「${context.step}」。`,
    '本次核对只依据下面的审批字段和材料；历史聊天不作为当前事实。请区分有依据的事实、疑点和缺失信息。',
    context.returnReason ? `当前审批意见：${context.returnReason}` : '',
    fields ? `Forge 业务字段：\n${fields}` : '',
    quotationApprovalText(context.quotationLines),
    files,
    originals ? `已核验审批原件（部分提取须保留未读内容限制）：\n${originals}` : '',
    '当前打开只授权只读核对。请整理复核意见和疑点；不要把本次打开当作办理授权。之后只有我在新消息明确要求办理当前事项时，才读取当前Forge动作目录并按该条目办理。原生动作回执只说明该项动作结果，不等于审批流程完成；结果未知时先读取当前事项和原生动作历史，不重试。',
    `初次打开的只读范围标记：${APPROVAL_REVIEW_SESSION_MARKER}`,
    '上述只读限制针对本次打开，不是禁止之后办理。之后我在新消息对当前准确事项明确说“同意这份报价”“批准”“驳回”或“退回”等，就是要求相应原生办理，无需再要求我说固定词“办理”或“提交”。请先读取本轮当前事项目录，再按真实可用动作办理；“我倾向同意”“如果条件满足就同意”“你觉得该同意吗”、建议和转述都不构成办理授权。',
  ].filter(Boolean).join('\n\n')
  if (!options.newSession(undefined, { preserveComposerDraft: true })) throw new Error('无法创建独立审批辅助会话，请保留当前草稿后重试')
  const activeWorkspace = options.workspace.workspaceRef.current
  if (!activeWorkspace.project || activeWorkspace.session || activeWorkspace.sessionFile) throw new Error('审批辅助没有切换到新的桌面会话，请从本人待办重新打开')
  const queuePrompt = options.workspace.queuePrompt as (
    text: string, intent: 'queue', parts: undefined, timestamp: undefined,
    returnedApprovalContextHandle: undefined, workContinuationContextHandle: undefined, approvalReviewContextHandle: string,
  ) => unknown
  queuePrompt(prompt, 'queue', undefined, undefined, undefined, undefined, binding.handle)
  options.setToast('已打开本次审批材料，可继续和 Pi 核对。')
}
