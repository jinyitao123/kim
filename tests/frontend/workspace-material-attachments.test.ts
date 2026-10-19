import { describe, expect, it } from 'vitest'
import { appendWorkspaceMaterialContext, splitWorkspaceMaterialContext } from '../../src/lib/workspace-material-attachments'
import type { WorkspaceMaterialReference } from '../../src/types/api'

const attachment: WorkspaceMaterialReference = {
  projectId: 'personal-project',
  harness: 'pi',
  workspacePath: '/workspace/personal',
  name: 'source.md',
  path: '材料/附件/opaque/source.md',
  sha256: 'a'.repeat(64),
  bytes: 14,
  mimeType: 'text/markdown',
}

describe('workspace material prompt references', () => {
  it('preserves an XLSX source reference and directs initialization through the bounded workbook reader', () => {
    const reference: WorkspaceMaterialReference = { ...attachment, name: '公司.xlsx', path: '材料/附件/opaque/公司.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    const text = appendWorkspaceMaterialContext('读取公司资料。', [reference])
    expect(splitWorkspaceMaterialContext(text)).toMatchObject({ text: '读取公司资料。', attachments: [{ name: reference.name, path: reference.path, sha256: reference.sha256, mimeType: reference.mimeType }] })
    expect(text).toContain('gooeypi_enterprise_initialization_workbook')
  })
  it('keeps file contents out of the prompt while persisting the exact path and digest reference', () => {
    const text = appendWorkspaceMaterialContext('Please review this file.', [attachment])
    const parsed = splitWorkspaceMaterialContext(text)

    expect(text).toContain(attachment.path)
    expect(text).toContain(attachment.sha256)
    expect(text).not.toContain('source.md contents')
    expect(parsed.text).toBe('Please review this file.')
    expect(parsed.attachments).toEqual([{
      name: attachment.name,
      path: attachment.path,
      sha256: attachment.sha256,
      bytes: attachment.bytes,
      mimeType: attachment.mimeType,
    }])
  })

  it('fails closed on an attachment reference outside the workspace Materials folder', () => {
    expect(() => appendWorkspaceMaterialContext('Read this file.', [{ ...attachment, path: '../outside.md' }]))
      .toThrow(/do not belong to the current workspace/)
  })

  it('preserves more than eight small file references without removing aggregate byte limits', () => {
    const attachments = Array.from({ length: 9 }, (_, index) => ({
      ...attachment,
      name: `source-${index + 1}.md`,
      path: `材料/附件/opaque/source-${index + 1}.md`,
    }))
    const text = appendWorkspaceMaterialContext('Review these files.', attachments)
    expect(splitWorkspaceMaterialContext(text).attachments).toHaveLength(9)

    const oversizedTotal = Array.from({ length: 5 }, (_, index) => ({
      ...attachments[index]!, bytes: 2 * 1024 * 1024,
    }))
    expect(() => appendWorkspaceMaterialContext('Review these files.', oversizedTotal))
      .toThrow('Workspace materials exceed the 8 MiB total size limit.')
  })
})
