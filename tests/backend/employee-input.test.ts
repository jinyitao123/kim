import { expect, it } from 'vitest'
import { captureEmployeeInput } from '../../electron/main/enterprise/employee-input'
import { appendWorkspaceMaterialContext } from '../../src/lib/workspace-material-attachments'
import type { CapabilityClaim } from '../../electron/main/lib/capability-bridge'
import type { WorkspaceMaterialReference } from '../../src/types/api'

const claim: CapabilityClaim = { token: 'fixture', cwd: '/employee-workspace', harness: 'pi', expiresAt: 1, windowStartedAt: 1, requests: 0 }
const material: WorkspaceMaterialReference = { projectId: 'project', harness: 'pi', workspacePath: claim.cwd, name: 'R2.docx', path: '材料/附件/R2.docx', bytes: 12, sha256: 'a'.repeat(64), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }

it('captures the exact employee text independently of the reproducible attachment prompt', () => {
  const text = '  请递交这两份修订材料。  '
  const prompt = appendWorkspaceMaterialContext(text, [material])
  expect(captureEmployeeInput(prompt, { text, materials: [material] }, claim)).toMatchObject({ text, materials: [{ path: material.path, sha256: material.sha256 }] })
})

it.each(['text', 'hash', 'workspace', 'harness'] as const)('rejects a captured %s that does not belong to the runtime input', (field) => {
  const text = '请递交这份修订材料。', prompt = appendWorkspaceMaterialContext(text, [material])
  const input = { text, materials: [{ ...material }] }
  if (field === 'text') input.text = '改成另外一条要求'
  if (field === 'hash') input.materials[0]!.sha256 = 'b'.repeat(64)
  if (field === 'workspace') input.materials[0]!.workspacePath = '/other-workspace'
  if (field === 'harness') input.materials[0]!.harness = 'prime'
  expect(() => captureEmployeeInput(prompt, input, claim)).toThrow()
})

it('never strips an attachment-shaped block without a trusted captured input', () => {
  const prompt = appendWorkspaceMaterialContext('员工粘贴的文字和标记', [material])
  expect(captureEmployeeInput(prompt, undefined, claim).text).toBe(prompt.trim())
})

it('rejects arbitrary fields in captured input instead of accepting runtime-supplied scope claims', () => {
  expect(() => captureEmployeeInput('请递交', { text: '请递交', materials: [], requestId: 'another-approval' }, claim)).toThrow()
})
