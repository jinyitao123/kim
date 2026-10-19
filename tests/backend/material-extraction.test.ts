import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { digest } from '../../electron/main/enterprise/handoff-store'
import { executionText, freezeMaterials, type FrozenMaterial } from '../../electron/main/enterprise/materials'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/materials')
const contractDocx = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/materials/合同样例.docx')
const scratch: string[] = []
afterEach(async () => { await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

async function freezeFixture(name: string, destinationName: string): Promise<{ source: Buffer; material: FrozenMaterial }> {
  const root = await mkdtemp(join(tmpdir(), 'workbench-material-'))
  scratch.push(root)
  const directory = join(root, '材料', '附件')
  await mkdir(directory, { recursive: true })
  const source = await readFile(join(fixtures, name))
  const destination = join(directory, destinationName)
  await writeFile(destination, source)
  const frozen = await freezeMaterials(root, [{ path: `材料/附件/${destinationName}`, sha256: digest(source) }])
  expect(frozen).toHaveLength(1)
  return { source, material: frozen[0]! }
}

function expectSourceBytes(material: FrozenMaterial, source: Buffer): void {
  const recovered = Buffer.from(material.bytesBase64, 'base64')
  expect(recovered.toString('base64')).toBe(material.bytesBase64)
  expect(recovered).toEqual(source)
  expect(material.bytes).toBe(source.length)
  expect(material.sha256).toBe(digest(source))
  expect(material.extraction.sourceSha256).toBe(material.sha256)
  const extractionBytes = Buffer.from(material.extraction.content, 'utf8')
  expect(material.extraction.bytes).toBe(extractionBytes.length)
  expect(material.extraction.sha256).toBe(digest(extractionBytes))
}

describe('frozen original document materials', () => {
  it('keeps the original PDF bytes and reports the page with no text instead of claiming full extraction', async () => {
    const { source, material } = await freezeFixture('sample-two-page.pdf', '合同样例.pdf')
    expectSourceBytes(material, source)
    expect(material).toMatchObject({ mediaType: 'application/pdf', sourceKind: 'owner', extraction: {
      status: 'partial', extractor: 'pdfjs-dist',
      coverage: { pdfPageCount: 2, pdfTextPageCount: 1, pdfPagesWithoutText: [2] },
      limitations: expect.arrayContaining(['page-without-text', 'embedded-image']),
    } })
    expect(material.extraction.content).toContain('PDF PAGE 1: byte exact original.')
    expect(material.extraction.content).toContain('Second line survives extraction.')
    expect(material.extraction.content).toContain('第 2 页')
    expect(material.extraction.content).toContain('OCR 不支持')

    const task = executionText('按原件核对交付条件', [material])
    const taskMaterial = (JSON.parse(task) as { materials: Array<Record<string, unknown>> }).materials[0]!
    expect(taskMaterial).toMatchObject({ materialId: material.materialId, sha256: material.sha256, extraction: { sourceSha256: material.sha256, status: 'partial' } })
    expect(taskMaterial).not.toHaveProperty('bytesBase64')
    expect(task).not.toContain(material.bytesBase64)
  })

  it('extracts DOCX paragraphs and tabular cells while binding text to the exact compressed source', async () => {
    const { source, material } = await freezeFixture('sample-paragraphs-table.docx', '交付清单.docx')
    expectSourceBytes(material, source)
    expect(material).toMatchObject({ mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sourceKind: 'owner', extraction: {
      status: 'complete', extractor: 'mammoth',
      coverage: { docxParagraphCount: 6, docxTableCount: 1, docxTableCellCount: 4, docxOmittedContentCount: 0 },
    } })
    expect(material.extraction.content).toContain('DOCX 第一段：原件字节保持不变。')
    expect(material.extraction.content).toContain('第二段包含可核对的交付说明。')
    expect(material.extraction.content).toContain('项目\t数量')
    expect(material.extraction.content).toContain('齿轮箱\t3')
    const task = executionText('检查交付清单', [material])
    const taskMaterial = (JSON.parse(task) as { materials: Array<Record<string, unknown>> }).materials[0]!
    expect(taskMaterial).toMatchObject({ sha256: material.sha256, extraction: { sha256: material.extraction.sha256, sourceSha256: material.sha256, content: material.extraction.content } })
    expect(task).not.toContain(material.bytesBase64)
  })

  it('treats unknown paragraph styles as readable when Mammoth retains their text', async () => {
    const { source, material } = await freezeFixture('sample-custom-paragraph-styles.docx', '自定义样式合同.docx')
    expectSourceBytes(material, source)
    expect(material.extraction).toMatchObject({
      status: 'complete', extractor: 'mammoth',
      coverage: { docxParagraphCount: 2, docxOmittedContentCount: 0 },
      limitations: [],
    })
    expect(material.extraction.content).toContain('员工指定的合同正文可读取。')
    expect(material.extraction.content).toContain('交付期限为二十个日历日。')
  })

  it('preserves the standard Word Title paragraph in the current contract DOCX', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-contract-material-'))
    scratch.push(root)
    const directory = join(root, '材料', '附件')
    await mkdir(directory, { recursive: true })
    const source = await readFile(contractDocx)
    const rawText = await (await import('mammoth')).extractRawText({ buffer: source })
    const title = rawText.value.split('\n').map((line) => line.trim()).find(Boolean)
    expect(title).toBeTruthy()

    const relativePath = '材料/附件/合同样例.docx'
    await writeFile(join(root, relativePath), source)
    const [material] = await freezeMaterials(root, [{ path: relativePath, sha256: digest(source) }])
    expect(material).toBeDefined()
    expectSourceBytes(material!, source)
    expect(material!.extraction.content).toContain(title!)
  })
})
