import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { readEmployeeBusinessMaterial, type EmployeeBusinessMaterialAccess } from '../../electron/main/enterprise/employee-business-materials'
import type { EmployeeBusinessSelection } from '../../src/types/employee-business'
import type { MaterialExtraction } from '../../electron/main/enterprise/materials'

const selection: EmployeeBusinessSelection = { record: { objectName: 'forge_customer_prepayment', recordId: 'prepay-current', label: '云岚测试预收' }, source: { kind: 'record' } }
function fixture() {
  const bytes = Buffer.from('%PDF-1.7\nTEST current receipt'), sha256 = createHash('sha256').update(bytes).digest('hex')
  const record = { id: 'prepay-current', receipt_evidence_attachment: 'file-current', receipt_evidence_sha256: sha256 }
  const context = { contextVersion: 'a'.repeat(64), recordVersion: 'review-1' }
  const extraction: MaterialExtraction = { status: 'complete', mediaType: 'text/plain; charset=utf-8', content: 'TEST预收630元',
    bytes: 18, sha256: 'b'.repeat(64), sourceSha256: sha256, extractor: 'pdfjs-dist', coverage: { pdfPageCount: 1, pdfTextPageCount: 1 }, limitations: [] }
  const access = {
    origin: 'https://forge.test', context: vi.fn(async () => structuredClone(context)), record: vi.fn(async () => structuredClone(record)),
    url: vi.fn(async (_id: string) => ({ success: true, data: { url: 'https://forge.test/api/v1/storage/signed?test=opaque' } })),
    fetch: vi.fn(async (_url: URL) => new Response(bytes, { headers: { 'Content-Type': 'application_pdf', 'Content-Length': String(bytes.length) } })),
    assertCurrent: vi.fn(async () => undefined), extract: vi.fn(async () => structuredClone(extraction)),
  } satisfies EmployeeBusinessMaterialAccess
  return { access, bytes, record, context, sha256 }
}

describe('current employee bound business original', () => {
  it('reads only the native record binding and authorized signed URL, verifies bytes and keeps internal references private', async () => {
    const f = fixture(), result = await readEmployeeBusinessMaterial(selection, f.access)
    expect(result).toMatchObject({ status: 'read', record: '云岚测试预收', materials: [{ name: '到账凭证', verified: true, bytes: f.bytes.length,
      extraction: { status: 'complete', content: 'TEST预收630元', coverage: { pdfPageCount: 1, pdfTextPageCount: 1 } } }] })
    expect(f.access.url).toHaveBeenCalledExactlyOnceWith('file-current')
    expect(f.access.extract).toHaveBeenCalledWith('application/pdf', f.bytes, f.sha256, expect.any(Number))
    for (const secret of ['file-current', 'prepay-current', f.sha256, 'https://forge.test', 'test=opaque']) expect(JSON.stringify(result)).not.toContain(secret)
  })
  it('rejects absent FLS fields or a different record before requesting any file address', async () => {
    const f = fixture()
    f.access.record.mockResolvedValueOnce({ ...f.record, id: 'another-record' })
    await expect(readEmployeeBusinessMaterial(selection, f.access)).rejects.toThrow('无法核验')
    f.access.record.mockResolvedValueOnce({ ...f.record, receipt_evidence_attachment: '' })
    await expect(readEmployeeBusinessMaterial(selection, f.access)).rejects.toThrow('无法核验')
    expect(f.access.url).not.toHaveBeenCalled(); expect(f.access.fetch).not.toHaveBeenCalled()
  })
  it.each(['https://elsewhere.test/file', 'file:///private/file', 'https://user:secret@forge.test/file'])('rejects an address outside the current connection: %s', async (url) => {
    const f = fixture(); f.access.url.mockResolvedValueOnce({ success: true, data: { url } })
    await expect(readEmployeeBusinessMaterial(selection, f.access)).rejects.toThrow('不属于')
    expect(f.access.fetch).not.toHaveBeenCalled()
  })
  it('fails closed on source version changes and account/turn changes during retrieval', async () => {
    const f = fixture(); f.access.context.mockResolvedValueOnce(f.context).mockResolvedValueOnce({ ...f.context, recordVersion: 'review-2' })
    await expect(readEmployeeBusinessMaterial(selection, f.access)).rejects.toThrow('已变化')
    const g = fixture(); g.access.assertCurrent.mockRejectedValueOnce(new Error('账号已变'))
    await expect(readEmployeeBusinessMaterial(selection, g.access)).rejects.toThrow('账号已变')
    expect(g.access.fetch).not.toHaveBeenCalled()
  })
  it('rejects changed file bindings, digest mismatch and responses above the byte limit', async () => {
    const f = fixture(); f.access.record.mockResolvedValueOnce(f.record).mockResolvedValueOnce({ ...f.record, receipt_evidence_attachment: 'file-other' })
    await expect(readEmployeeBusinessMaterial(selection, f.access)).rejects.toThrow('已变化')
    const g = fixture(); g.access.fetch.mockResolvedValueOnce(new Response(Buffer.from('%PDF-changed'), { headers: { 'Content-Type': 'application/pdf', 'Content-Length': '12' } }))
    await expect(readEmployeeBusinessMaterial(selection, g.access)).rejects.toThrow('摘要或媒体')
    const h = fixture(); h.access.fetch.mockResolvedValueOnce(new Response('x', { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(2 * 1024 * 1024 + 1) } }))
    await expect(readEmployeeBusinessMaterial(selection, h.access)).rejects.toThrow('超限')
  })
  it('preserves incomplete extraction without claiming all pages or creating a new upload authority', async () => {
    const f = fixture(); f.access.extract.mockResolvedValueOnce({ status: 'partial', mediaType: 'text/plain; charset=utf-8', bytes: 0, sha256: 'a'.repeat(64), sourceSha256: f.sha256,
      content: '', extractor: 'pdfjs-dist', coverage: { pdfPageCount: 2, pdfTextPageCount: 1, pdfPagesWithoutText: [2] }, limitations: ['page-without-text'] })
    const result = await readEmployeeBusinessMaterial(selection, f.access)
    expect(result.materials[0].extraction).toMatchObject({ status: 'partial', limitations: ['page-without-text'], coverage: { pdfPagesWithoutText: [2] } })
    expect(result.message).toContain('不构成确认到账、上传或签署授权')
  })
})
