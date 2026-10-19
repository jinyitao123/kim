import { isAbsolute, resolve } from 'node:path'
import type { CapabilityClaim } from '../lib/capability-bridge'
import type { EmployeePromptInput, WorkspaceMaterialPromptReference } from '../../../src/types/api'
import { appendWorkspaceMaterialContext, splitWorkspaceMaterialContext } from '../../../src/lib/workspace-material-attachments'
import { rejectUnknownKeys, requireRecord, requireString } from '../validation'

/** Verify the renderer's captured input by reproducing its entire runtime prompt. */
export function captureEmployeeInput(fullPrompt: string, supplied: unknown, claim: CapabilityClaim): { text: string; materials?: WorkspaceMaterialPromptReference[] } {
  if (supplied === undefined) return { text: fullPrompt.trim(), materials: splitWorkspaceMaterialContext(fullPrompt).attachments }
  const input = requireRecord(supplied, 'employeeInput')
  rejectUnknownKeys(input, ['text', 'materials'], 'employeeInput')
  const text = requireString(input.text, 'employeeInput.text', { min: 0, max: 1_048_576, trim: false })
  if (text.includes('\0') || !Array.isArray(input.materials) || input.materials.length > 128) throw new Error('桌面员工输入或材料来源无效')
  for (const value of input.materials) {
    const material = requireRecord(value, 'employeeInput.material')
    rejectUnknownKeys(material, ['projectId', 'harness', 'workspacePath', 'name', 'path', 'sha256', 'bytes', 'mimeType'], 'employeeInput.material')
    if (typeof material.projectId !== 'string' || !material.projectId || material.harness !== claim.harness
      || typeof material.workspacePath !== 'string' || !isAbsolute(material.workspacePath) || resolve(material.workspacePath) !== resolve(claim.cwd)) {
      throw new Error('桌面材料不属于当前员工工作空间')
    }
  }
  const materials = input.materials as EmployeePromptInput['materials']
  if (appendWorkspaceMaterialContext(text, materials).trim() !== fullPrompt.trim()) throw new Error('桌面员工原文、选定材料与运行提示不一致')
  return { text, materials: materials.map(({ name, path, sha256, bytes, mimeType }) => ({ name, path, sha256, bytes, mimeType })) }
}
