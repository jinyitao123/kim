import { describe, expect, it } from 'vitest'
import type { TranscriptMessage, WorkspaceMaterialReference } from '../../src/types/api'
import { appendWorkspaceMaterialContext } from '../../src/lib/workspace-material-attachments'
import { projectMaterialDisplayMessages } from '../../src/lib/workspace-material-display'
import { summarizeTranscript } from '../../src/components/inspector/SummaryPanel'

describe('selected material display', () => {
  it('uses the exact selected filename in narrative and summary while preserving the protocol and original messages', () => {
    const source: WorkspaceMaterialReference = { projectId: 'project', harness: 'pi', workspacePath: '/workspace', name: '企业资料.xlsx', path: '材料/附件/8cbe7c3c-6f01-4841-ad53-a4170c3b4d72/企业资料.xlsx', sha256: 'a'.repeat(64), bytes: 100, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    const messages: TranscriptMessage[] = [
      { id: 'user', role: 'user', parts: [{ type: 'text', text: appendWorkspaceMaterialContext('读取附件', [source]) }] },
      { id: 'assistant', role: 'assistant', parts: [{ type: 'toolCall', name: 'gooeypi_enterprise_initialization_workbook', args: { path: source.path, sha256: source.sha256 } }, { type: 'text', text: `已读取 ${source.path}。编号 000123，金额 1.2345。` }] },
    ]
    const projected = projectMaterialDisplayMessages(messages)
    expect(projected[1].parts[1]).toMatchObject({ text: '已读取 企业资料.xlsx。编号 000123，金额 1.2345。' })
    expect(projected[1].parts[0]).toBe(messages[1].parts[0])
    expect(messages[1].parts[1]).toMatchObject({ text: expect.stringContaining(source.path) })
    expect(summarizeTranscript(messages).lastText).toBe('已读取 企业资料.xlsx。编号 000123，金额 1.2345。')
  })
  it.each([
    { role: 'user', parts: undefined },
    { role: 'assistant', parts: { type: 'text', text: 'invalid non-array parts' } },
    { role: 'agent', parts: null },
  ])('preserves a malformed $role message while applying a real material display mapping', ({ role, parts }) => {
    const source: WorkspaceMaterialReference = { projectId: 'project', harness: 'pi', workspacePath: '/workspace', name: '企业资料.xlsx', path: '材料/附件/selected/企业资料.xlsx', sha256: 'a'.repeat(64), bytes: 100, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    const broken = { id: 'broken', role, parts } as unknown as TranscriptMessage
    const healthy: TranscriptMessage = { id: 'healthy', role: 'assistant', parts: [{ type: 'text', text: `已读取 ${source.path}。` }] }
    const messages: TranscriptMessage[] = [
      broken,
      { id: 'material-source', role: 'user', parts: [{ type: 'text', text: appendWorkspaceMaterialContext('读取附件', [source]) }] },
      healthy,
    ]

    const projected = projectMaterialDisplayMessages(messages)

    expect(projected[0]).toBe(broken)
    expect(projected[0].parts).toBe(parts)
    expect(projected[1]).toBe(messages[1])
    expect(projected[2]).not.toBe(healthy)
    expect(projected[2].parts[0]).toMatchObject({ text: '已读取 企业资料.xlsx。' })
    expect(healthy.parts[0]).toMatchObject({ text: `已读取 ${source.path}。` })
  })

  it('keeps unrelated paths and business values intact', () => {
    const messages: TranscriptMessage[] = [{ id: 'assistant', role: 'assistant', parts: [{ type: 'text', text: '客户提供路径 /资料/公司.xlsx，编号 000123' }] }]
    expect(projectMaterialDisplayMessages(messages)).toBe(messages)
  })
})
