import { createHash } from 'node:crypto'
import type { EmployeeBusinessSelection, EmployeeBusinessTarget } from '../../../src/types/employee-business'
import { canonicalBusinessJSON } from './employee-business-contract'
import { extractOriginalMaterialText, MAX_WORKSPACE_EXTRACTION_BYTES, type MaterialExtraction } from './materials'
import { rejectUnknownKeys } from '../validation'

type Row = Record<string, unknown>
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('当前业务原件声明不可可靠读取')
  const r = value as Row
  return (r.data ?? r.result ?? r.item ?? r) as Row
}
export interface EmployeeBusinessMaterialAccess {
  origin: string
  context(): Promise<{ contextVersion: string; recordVersion: string }>
  record(): Promise<unknown>
  url(fileId: string): Promise<unknown>
  fetch(url: URL): Promise<Response>
  assertCurrent(): Promise<void>
  extract?: typeof extractOriginalMaterialText
}
export interface EmployeeBusinessMaterialView {
  status: 'read'; record: string
  materials: Array<{ name: string; verified: true; bytes: number; extraction: Pick<MaterialExtraction, 'status' | 'content' | 'coverage' | 'limitations' | 'extractor'> }>
  message: string
}
export async function readBoundEmployeeBusinessMaterial(params: Row, access: {
  selection(): Promise<EmployeeBusinessTarget | undefined>
  assertCurrent(): Promise<void>
  read(selection: EmployeeBusinessSelection, assertCurrent: () => Promise<void>): Promise<EmployeeBusinessMaterialView>
}) {
  rejectUnknownKeys(params, ['turn_key'], 'business material read')
  const selection = await access.selection()
  if (!selection || !('record' in selection)) throw new Error('请先从本人业务事项正常打开当前记录')
  return access.read(selection, async () => {
    await access.assertCurrent()
    if (canonicalBusinessJSON(await access.selection()) !== canonicalBusinessJSON(selection)) throw new Error('当前业务来源已变化，原件读取结果已丢弃')
  })
}
function binding(value: unknown, selection: EmployeeBusinessSelection) {
  const r = row(value)
  if ((r.id ?? r._id) !== selection.record.recordId || typeof r.receipt_evidence_attachment !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(r.receipt_evidence_attachment)
    || typeof r.receipt_evidence_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.receipt_evidence_sha256)) {
    throw new Error('当前账号无法核验本预收记录已绑定的到账原件与版本')
  }
  return { fileId: r.receipt_evidence_attachment, sha256: r.receipt_evidence_sha256 }
}
function version(context: { contextVersion: string; recordVersion: string }) {
  return { contextVersion: context.contextVersion, recordVersion: context.recordVersion }
}
/** Uses native field access and Storage authorization; it neither grants access nor stages files. */
export async function readEmployeeBusinessMaterial(selection: EmployeeBusinessSelection, access: EmployeeBusinessMaterialAccess): Promise<EmployeeBusinessMaterialView> {
  if (selection.record.objectName !== 'forge_customer_prepayment') throw new Error('当前事项尚未提供受控原件读取，请使用其原生材料入口')
  await access.assertCurrent()
  const before = version(await access.context()), expected = binding(await access.record(), selection)
  const raw = await access.url(expected.fileId)
  await access.assertCurrent()
  const envelope = raw as Row, data = envelope?.data as Row
  if (envelope?.success !== true || !data || Object.keys(data).length !== 1 || typeof data.url !== 'string') throw new Error('原生Storage没有返回可核验的授权原件地址')
  const url = new URL(data.url, access.origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(access.origin).origin || url.username || url.password || url.hash) {
    throw new Error('原件读取地址不属于当前Forge连接，已停止读取')
  }
  const response = await access.fetch(url)
  await access.assertCurrent()
  const media = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  const mediaType = media === 'application/pdf' || media === 'application_pdf' ? 'application/pdf'
    : media === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? media : undefined
  const length = Number(response.headers.get('content-length'))
  if (!response.ok || !mediaType || !Number.isInteger(length) || length < 1 || length > 2 * 1024 * 1024 || !response.body) {
    await response.body?.cancel(); throw new Error('到账原件无权读取、媒体不支持或字节声明超限')
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      await access.assertCurrent()
      if (next.done) break
      size += next.value.length
      if (size > length) throw new Error('到账原件超过声明字节，已停止读取')
      chunks.push(next.value)
    }
  } catch (error) { await reader.cancel(); throw error }
  finally { reader.releaseLock() }
  const bytes = Buffer.concat(chunks)
  if (size !== length || createHash('sha256').update(bytes).digest('hex') !== expected.sha256
    || mediaType === 'application/pdf' && bytes.subarray(0, 5).toString() !== '%PDF-'
    || mediaType !== 'application/pdf' && (bytes[0] !== 0x50 || bytes[1] !== 0x4b)) throw new Error('到账原件完整字节与已绑定摘要或媒体不一致')
  const extraction = await (access.extract ?? extractOriginalMaterialText)(mediaType, bytes, expected.sha256, MAX_WORKSPACE_EXTRACTION_BYTES)
  const after = version(await access.context()), current = binding(await access.record(), selection)
  await access.assertCurrent()
  if (canonicalBusinessJSON(before) !== canonicalBusinessJSON(after) || canonicalBusinessJSON(expected) !== canonicalBusinessJSON(current)) {
    throw new Error('当前预收记录、文件版本或可办理来源已变化，原件读取结果已丢弃')
  }
  const { status, content, coverage, limitations, extractor } = extraction
  return { status: 'read', record: selection.record.label, materials: [{ name: '到账凭证', verified: true, bytes: size, extraction: { status, content, coverage, limitations, extractor } }],
    message: '仅核验当前事项绑定原件；保留提取覆盖与未读限制。读取不构成确认到账、上传或签署授权。' }
}
