import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { extractInitializationWorkbook } from '../../electron/main/enterprise/initialization-workbook'

async function workbook(cells: string, options: { merge?: boolean; date1904?: boolean } = {}) {
  const zip = new JSZip()
  zip.file('xl/workbook.xml', `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="${options.date1904 ? '1' : '0'}"/><sheets><sheet name="基础资料" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
  zip.file('xl/styles.xml', '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="000000"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>')
  zip.file('xl/sharedStrings.xml', '<sst><si><t>0012345678901234567890</t></si></sst>')
  zip.file('xl/worksheets/sheet1.xml', `<worksheet><dimension ref="A1:D1"/><sheetData><row r="1">${cells}</row></sheetData>${options.merge ? '<mergeCells><mergeCell ref="A1:B1"/></mergeCells>' : ''}</worksheet>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
describe('initialization workbook provenance', () => {
  it('rejects duplicate source coordinates instead of silently selecting a value', async () => {
    await expect(extractInitializationWorkbook(await workbook('<c r="A1"><v>1</v></c><c r="A1"><v>2</v></c>'))).rejects.toThrow('重复单元格')
    const zip = await JSZip.loadAsync(await workbook('<c r="A1"><v>1</v></c>'))
    zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="1"><c r="B1"><v>2</v></c></row></sheetData></worksheet>')
    await expect(extractInitializationWorkbook(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('重复行')
  })
  it('keeps long identifiers, leading zeros, decimal text and cell coordinates', async () => {
    const result = await extractInitializationWorkbook(await workbook('<c r="A1" t="s"><v>0</v></c><c r="B1" s="2"><v>42</v></c><c r="C1"><v>1234567890.1234</v></c>'))
    const sheets = result.sheets as Array<{ name: string; rows: Array<{ cells: Array<{ cell: string; value: unknown }> }> }>
    expect(result.status).toBe('complete')
    expect(sheets[0].name).toBe('基础资料')
    expect(sheets[0].rows[0].cells.map(cell => [cell.cell, cell.value])).toEqual([['A1', '0012345678901234567890'], ['B1', '000042'], ['C1', '1234567890.1234']])
  })
  it('reads the workbook date system without guessing the host timezone', async () => {
    const result = await extractInitializationWorkbook(await workbook('<c r="A1" s="1"><v>0</v></c>', { date1904: true }))
    expect(JSON.stringify(result.sheets)).toContain('1904-01-01')
  })
  it('never treats a missing formula cache or merged cells as complete', async () => {
    const result = await extractInitializationWorkbook(await workbook('<c r="A1"><f>SUM(C1:D1)</f></c>', { merge: true }))
    expect(result.status).toBe('partial')
    expect(JSON.stringify(result.warnings)).toContain('公式没有可靠缓存结果')
    expect(JSON.stringify(result.sheets)).toContain('"unread":true')
  })
  it('rejects links and oversized archives before parsing cell values', async () => {
    const bytes = await workbook('<c r="A1" t="inlineStr"><is><t>value</t></is></c>')
    const zip = await JSZip.loadAsync(bytes)
    zip.file('xl/externalLinks/externalLink1.xml', '<externalLink/>')
    await expect(extractInitializationWorkbook(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('外部链接')
    await expect(extractInitializationWorkbook(Buffer.alloc(2 * 1024 * 1024 + 1))).rejects.toThrow('超过2MiB')
  })
  it('rejects XML entities and keeps raw numeric identifiers out of Number conversion', async () => {
    const bytes = await workbook('<c r="A1"><v>12345678901234567890</v></c>')
    const read = await extractInitializationWorkbook(bytes)
    expect(JSON.stringify(read.sheets)).toContain('12345678901234567890')
    const zip = await JSZip.loadAsync(bytes)
    zip.file('xl/sharedStrings.xml', '<!DOCTYPE a [<!ENTITY data "hidden">]><sst><si><t>&data;</t></si></sst>')
    await expect(extractInitializationWorkbook(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('外部实体')
  })
})
