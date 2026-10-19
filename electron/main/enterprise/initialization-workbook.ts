import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, posix } from 'node:path'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import { digest } from './handoff-store'

const MAX_SOURCE = 2 * 1024 * 1024, MAX_EXPANDED = 32 * 1024 * 1024, MAX_TEXT = 700_000
type XmlDocument = ReturnType<DOMParser['parseFromString']>
type XmlElement = ReturnType<XmlDocument['getElementsByTagName']> extends { item(index: number): infer E } ? NonNullable<E> : never
const elements = (parent: XmlDocument | XmlElement, name: string): XmlElement[] => Array.from(parent.getElementsByTagNameNS('*', name))
function document(xml: string): XmlDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('工作簿包含不支持的外部实体声明')
  const errors: string[] = []
  const parsed = new DOMParser({ errorHandler: (_level, message) => { errors.push(String(message)) } }).parseFromString(xml, 'application/xml')
  if (errors.length || !parsed.documentElement) throw new Error('工作簿XML结构无法可靠读取')
  return parsed
}
function validateArchive(bytes: Buffer): void {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('工作簿文件签名无效')
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break }
  if (end < 0) throw new Error('工作簿压缩目录无法读取')
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || count !== bytes.readUInt16LE(end + 8) || count > 2048 || start + size > end) throw new Error('工作簿压缩结构不受支持')
  const names = new Set<string>()
  let total = 0, at = start
  for (let index = 0; index < count; index++) {
    if (at + 46 > start + size || bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('工作簿压缩目录无效')
    const flags = bytes.readUInt16LE(at + 8), compressed = bytes.readUInt32LE(at + 20), expanded = bytes.readUInt32LE(at + 24), length = bytes.readUInt16LE(at + 28)
    const name = bytes.subarray(at + 46, at + 46 + length).toString('utf8')
    total += expanded
    if (flags & 1 || compressed === 0xffffffff || expanded === 0xffffffff || total > MAX_EXPANDED || /(^\/|\\|(^|\/)\.\.\/)/.test(name) || names.has(name)) throw new Error('工作簿压缩内容不受支持或超过32MiB限额')
    names.add(name)
    at += 46 + length + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32)
    if (at > start + size) throw new Error('工作簿压缩目录越界')
  }
  if (at !== start + size || !names.has('xl/workbook.xml') || !names.has('xl/_rels/workbook.xml.rels')) throw new Error('工作簿缺少有效工作表目录')
  if ([...names].some(name => /vbaProject|externalLinks\//i.test(name))) throw new Error('工作簿包含宏或外部链接，请提供独立的无宏数据表')
}
function dateValue(raw: string, format: string, date1904: boolean): string | undefined {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 2958465 || !date1904 && Math.floor(value) === 60) return undefined
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Math.floor(value) < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)
  const date = new Date(epoch + Math.round(value * 86_400_000))
  return /[hs]/i.test(format) ? date.toISOString().slice(0, 19) : date.toISOString().slice(0, 10)
}

/** Read values and provenance without evaluating formulas, following links,
 * loading macros, or converting business identifiers through JS numbers. */
export async function extractInitializationWorkbook(bytes: Buffer): Promise<Record<string, unknown>> {
  if (bytes.length > MAX_SOURCE) throw new Error('工作簿超过2MiB，请按工作表拆分后重新提供')
  validateArchive(bytes)
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
  const xml = async (name: string) => { const file = zip.file(name); if (!file) throw new Error(`工作簿缺少${name}`); return document(await file.async('string')) }
  const workbook = await xml('xl/workbook.xml'), relations = await xml('xl/_rels/workbook.xml.rels')
  const date1904 = ['1', 'true'].includes(elements(workbook, 'workbookPr')[0]?.getAttribute('date1904') ?? '')
  const links = new Map(elements(relations, 'Relationship').map(element => [element.getAttribute('Id'), element]))
  const shared = zip.file('xl/sharedStrings.xml') ? elements(await xml('xl/sharedStrings.xml'), 'si').map(item => elements(item, 't').map(text => text.textContent ?? '').join('')) : []
  const styles = zip.file('xl/styles.xml') ? await xml('xl/styles.xml') : undefined
  const formats = new Map<string, string>([['14', 'yyyy-mm-dd'], ['15', 'yyyy-mm-dd'], ['16', 'yyyy-mm-dd'], ['17', 'yyyy-mm-dd'], ['18', 'hh:mm:ss'], ['19', 'hh:mm:ss'], ['20', 'hh:mm:ss'], ['21', 'hh:mm:ss'], ['22', 'yyyy-mm-dd hh:mm:ss']])
  for (const format of styles ? elements(styles, 'numFmt') : []) formats.set(format.getAttribute('numFmtId') ?? '', format.getAttribute('formatCode') ?? '')
  const styleFormats = styles ? elements(styles, 'cellXfs').flatMap(group => elements(group, 'xf').map(style => formats.get(style.getAttribute('numFmtId') ?? '') ?? '')) : []
  const warnings: Array<{ sheet: string; cell?: string; reason: string }> = [], sheets: unknown[] = []
  const sheetElements = elements(workbook, 'sheet')
  if (!sheetElements.length || sheetElements.length > 32) throw new Error('工作簿最多读取32个工作表，请拆分后提供')
  let totalCells = 0
  const sheetNames = new Set<string>()
  for (const sheet of sheetElements) {
    const name = sheet.getAttribute('name') ?? '', relationship = links.get(sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'))
    if (!name || sheetNames.has(name)) throw new Error('工作表名称缺失或重复，无法可靠定位来源')
    sheetNames.add(name)
    if (!relationship || relationship.getAttribute('TargetMode') === 'External') throw new Error('工作表引用无法可靠读取')
    const target = relationship.getAttribute('Target') ?? '', location = posix.normalize(target.startsWith('/') ? target.slice(1) : 'xl/' + target)
    if (!location.startsWith('xl/worksheets/')) throw new Error('工作表引用超出允许范围')
    const data = await xml(location), rows: unknown[] = []
    const merges = elements(data, 'mergeCell').map(merge => merge.getAttribute('ref'))
    if (merges.length) warnings.push({ sheet: name, reason: '存在合并单元格，只读取实际存储值，不把左上角内容自动填充到其他单元格' })
    const seenRows = new Set<number>(), seenCells = new Set<string>()
    for (const sourceRow of elements(data, 'row')) {
      const rowNumber = Number(sourceRow.getAttribute('r'))
      if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 10000) throw new Error('工作表行数超过10000行或行位置无效')
      if (seenRows.has(rowNumber)) throw new Error('工作表包含重复行位置，无法可靠定位来源')
      seenRows.add(rowNumber)
      const cells: unknown[] = []
      for (const cell of elements(sourceRow, 'c')) {
        totalCells++
        const address = cell.getAttribute('r') ?? '', coordinate = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address)
        const column = coordinate?.[1].split('').reduce((number, char) => number * 26 + char.charCodeAt(0) - 64, 0)
        if (!coordinate || Number(coordinate[2]) !== rowNumber || !column || column > 128 || totalCells > 50000) throw new Error('工作表超过128列、50000个单元格或单元格位置无效')
        if (seenCells.has(address)) throw new Error('工作表包含重复单元格位置，无法可靠定位来源')
        seenCells.add(address)
        const type = cell.getAttribute('t') || 'n', raw = elements(cell, 'v')[0]?.textContent ?? '', formula = elements(cell, 'f')[0]
        const format = styleFormats[Number(cell.getAttribute('s') ?? 0)] ?? ''
        let value: string | boolean | null = raw, unread = false
        if (type === 's') { const index = Number(raw); if (!/^\d+$/.test(raw) || !Number.isInteger(index) || shared[index] === undefined) throw new Error('共享文本索引无效'); value = shared[index] }
        else if (type === 'inlineStr') value = elements(cell, 't').map(text => text.textContent ?? '').join('')
        else if (type === 'b') { if (!['0', '1'].includes(raw)) throw new Error('布尔单元格值无效'); value = raw === '1' }
        else if (type === 'e') { unread = true; value = null; warnings.push({ sheet: name, cell: address, reason: '原单元格为错误值' }) }
        else if (!['n', 'str', 'd'].includes(type)) { unread = true; value = null; warnings.push({ sheet: name, cell: address, reason: '不支持的单元格类型' }) }
        else if (raw && type === 'n' && format && /[yd]/i.test(format.replace(/"[^"]*"|\[[^\]]*\]/g, ''))) {
          value = dateValue(raw, format, date1904) ?? null
          if (value === null) { unread = true; warnings.push({ sheet: name, cell: address, reason: '日期序号无法可靠转换' }) }
        } else if (type === 'n' && /^0+$/.test(format) && /^\d+$/.test(raw)) value = raw.padStart(format.length, '0')
        if (formula) { warnings.push({ sheet: name, cell: address, reason: raw ? '公式只读取文件内缓存结果，未重算或证明缓存仍有效' : '公式没有可靠缓存结果，请补充明确数值' }); if (!raw) { unread = true; value = null } }
        cells.push({ cell: address, value, ...(format ? { format } : {}), ...(formula ? { formula: formula.textContent ?? '' } : {}), ...(unread ? { unread: true } : {}) })
      }
      rows.push({ row: rowNumber, cells })
    }
    sheets.push({ name, visibility: sheet.getAttribute('state') || 'visible', range: elements(data, 'dimension')[0]?.getAttribute('ref') || null, merges, rows })
    if (Buffer.byteLength(JSON.stringify(sheets), 'utf8') > MAX_TEXT) throw new Error('工作簿提取文本超过700KB，请拆分后提供；内容未截断')
  }
  if (Object.keys(zip.files).some(name => name.startsWith('xl/media/'))) warnings.push({ sheet: '工作簿', reason: '图像未进行文字识别，不作为已读取的业务数据' })
  return { version: '1', readOnly: true, status: warnings.length ? 'partial' : 'complete', sourceSha256: digest(bytes), cellsRead: totalCells, sheets, warnings }
}

export async function readInitializationWorkbook(cwd: string, selection: { path: string; sha256: string }): Promise<Record<string, unknown>> {
  const root = await realpath(cwd), path = await realpath(resolve(root, selection.path)), child = relative(root, path)
  if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child) || !/\.xlsx$/i.test(path) || !/^[a-f0-9]{64}$/.test(selection.sha256)) throw new Error('请选择当前工作目录中本轮授权的xlsx原件')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_SOURCE) throw new Error('工作簿不是普通文件或超过2MiB')
    const buffer = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    if (bytesRead !== stat.size || digest(bytes) !== selection.sha256) throw new Error('工作簿字节与本轮固定原件不一致，请重新选择')
    return extractInitializationWorkbook(bytes)
  } finally { await file.close() }
}
