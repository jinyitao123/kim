import { describe, expect, it } from 'vitest'
import { ForgeBusinessReadError, ForgeBusinessReader } from '../../electron/main/enterprise/business-records'

type Field = { name: string; type: string; label: string; reference?: string; required?: boolean; options?: Array<string | { value: string | number | boolean; label: string }> }
type ToolCall = { name: string; args: Record<string, unknown> }

const rootFields: Field[] = [
  { name: 'id', type: 'text', label: 'ID' },
  { name: 'name', type: 'text', label: '报价名称' },
  { name: 'code', type: 'text', label: '报价编号' },
  { name: 'status', type: 'select', label: '状态' },
  { name: 'owner_name', type: 'text', label: '负责人' },
  { name: 'item_count', type: 'number', label: '明细行数' },
  { name: 'version', type: 'number', label: '版本' },
  { name: 'customer_id', type: 'lookup', label: '客户', reference: 'customer' },
  { name: 'access_token', type: 'secret', label: '访问令牌' },
]

const lineFields: Field[] = [
  { name: 'id', type: 'text', label: 'ID' },
  { name: 'quote_id', type: 'lookup', label: '销售报价', reference: 'sales_quote' },
  { name: 'item_name', type: 'text', label: '明细名称' },
  { name: 'quantity', type: 'number', label: '数量' },
  { name: 'unit_price', type: 'currency', label: '单价' },
  { name: 'line_amount', type: 'currency', label: '金额' },
]

function metadata(objectName: string, label: string, fields: Field[]) {
  return { type: 'object', name: objectName, sortability: [], item: { name: objectName, label, fields } }
}

function readerFixture(options: { lineCount?: number; deniedLineQuery?: boolean; denyParentRead?: boolean; hideSearchFields?: boolean } = {}) {
  const calls: ToolCall[] = []
  const metadataCalls: string[] = []
  const directory = {
    objects: [
      { name: 'sales_quote', label: '销售报价', fieldCount: rootFields.length },
      { name: 'sales_quote_line', label: '销售报价明细', fieldCount: lineFields.length },
      { name: 'customer', label: '客户', fieldCount: 4 },
    ],
    totalCount: 3,
  }
  const reader = new ForgeBusinessReader(async (name, args) => {
    calls.push({ name, args })
    if (name === 'list_objects') return directory
    if (name === 'describe_object') {
      return { name: 'sales_quote', label: '销售报价', fields: rootFields, enableFeatures: [] }
    }
    if (name === 'get_record') {
      if (args.objectName === 'sales_quote') return {
        id: 'quote-internal-1', name: '设备交接报价', code: 'Q-240', status: '草稿', owner_name: '销售小李', item_count: 2, version: 7, customer_id: 'customer-internal-1', access_token: 'do-not-expose',
      }
      if (args.objectName === 'customer') {
        if (options.denyParentRead) throw new ForgeBusinessReadError('forbidden', 'permission denied')
        return { id: 'customer-internal-1', name: '北辰设备客户', email: 'private@example.test' }
      }
      throw new ForgeBusinessReadError('forbidden', 'permission denied')
    }
    if (name === 'query_records') {
      if (args.objectName === 'sales_quote') return {
        object: 'sales_quote', records: [options.hideSearchFields ? { id: 'quote-internal-1' } : {
          id: 'quote-internal-1', name: '设备交接报价', code: 'Q-240', status: '草稿', owner_name: '销售小李', item_count: 2, version: 7,
        }], total: 1, hasMore: false,
      }
      if (options.deniedLineQuery) throw new ForgeBusinessReadError('forbidden', 'permission denied')
      const count = options.lineCount ?? 2
      return {
        object: 'sales_quote_line',
        records: Array.from({ length: count }, (_, index) => ({
          id: `line-${index + 1}`, quote_id: 'quote-internal-1', item_name: `设备 ${index + 1}`, quantity: index + 1, unit_price: 100, line_amount: 100 * (index + 1),
        })),
        total: count,
        hasMore: false,
      }
    }
    throw new Error(`unexpected tool ${name}`)
  }, async (objectName) => {
    metadataCalls.push(objectName)
    if (objectName === 'sales_quote') return metadata(objectName, '销售报价', rootFields)
    if (objectName === 'sales_quote_line') return metadata(objectName, '销售报价明细', lineFields)
    if (objectName === 'customer') return metadata(objectName, '客户', [
      { name: 'id', type: 'text', label: 'ID' }, { name: 'name', type: 'text', label: '客户名称' }, { name: 'email', type: 'email', label: '邮箱' },
    ])
    throw new ForgeBusinessReadError('not_found', 'metadata missing')
  })
  return { reader, calls, metadataCalls }
}

describe('native Forge business record reads', () => {
  it('uses the native option label for a current select value without hardcoding business status meanings', async () => {
    const fields: Field[] = [
      { name: 'id', type: 'text', label: 'ID' },
      { name: 'name', type: 'text', label: '合同名称' },
      { name: 'status', type: 'select', label: '状态', options: [
        { value: 'active', label: '内部复核通过' }, { value: 'draft', label: '草稿' },
      ] },
    ]
    const reader = new ForgeBusinessReader(async (name) => {
      if (name === 'list_objects') return { objects: [{ name: 'forge_sales_contract', label: '销售合同' }], totalCount: 1 }
      if (name === 'get_record') return { id: 'contract-internal-id', name: '待复核合同', status: 'active' }
      throw new Error(`unexpected ${name}`)
    }, async (objectName) => metadata(objectName, '销售合同', fields))

    const read = await reader.readRecord('forge_sales_contract', 'contract-internal-id', 1)
    expect(read.candidate.status).toBe('内部复核通过')
    expect(read.snapshot.record).toContainEqual({ label: '状态', value: '内部复核通过' })
    expect(JSON.stringify(read.snapshot)).not.toContain('active')
  })

  it('keeps a line item material code distinct from its authorized SKU code', async () => {
    const contractFields: Field[] = [
      { name: 'id', type: 'text', label: 'ID' },
      { name: 'name', type: 'text', label: '合同名称' },
      { name: 'code', type: 'text', label: '合同编号' },
      { name: 'item_count', type: 'number', label: '明细行数' },
    ]
    const contractLineFields: Field[] = [
      { name: 'id', type: 'text', label: 'ID' },
      { name: 'contract_id', type: 'lookup', label: '合同', reference: 'forge_sales_contract' },
      { name: 'sku_id', type: 'lookup', label: '物料规格', reference: 'forge_material_sku' },
      { name: 'item_code', type: 'text', label: '物料编码' },
      { name: 'quantity_limit', type: 'number', label: '数量' },
      { name: 'taxed_unit_price', type: 'currency', label: '单价' },
    ]
    const skuFields: Field[] = [
      { name: 'id', type: 'text', label: 'ID' },
      { name: 'code', type: 'text', label: '规格编码' },
      { name: 'name', type: 'text', label: '规格名称' },
    ]
    const calls: ToolCall[] = []
    const definitions: Record<string, Field[]> = {
      forge_sales_contract: contractFields,
      forge_sales_contract_line: contractLineFields,
      forge_material_sku: skuFields,
    }
    const reader = new ForgeBusinessReader(async (name, args) => {
      calls.push({ name, args })
      if (name === 'list_objects') return { objects: Object.keys(definitions).map((objectName) => ({ name: objectName, label: objectName })), totalCount: 3 }
      if (name === 'get_record' && args.objectName === 'forge_sales_contract') return { id: 'contract-1', name: '测试合同', code: 'C-1', item_count: 1 }
      if (name === 'get_record' && args.objectName === 'forge_material_sku') return { id: 'sku-1', code: 'SKU-A', name: '设备 A 标准版' }
      if (name === 'query_records' && args.objectName === 'forge_sales_contract_line') return {
        records: [{ id: 'line-1', contract_id: 'contract-1', sku_id: 'sku-1', item_code: 'MATERIAL-A', quantity_limit: 2, taxed_unit_price: 900 }],
        total: 1, hasMore: false,
      }
      throw new Error(`unexpected ${name}`)
    }, async (objectName) => metadata(objectName, objectName, definitions[objectName]!))
    const result = await reader.readRecord('forge_sales_contract', 'contract-1', 1)
    const detail = result.snapshot.relations.find((relation) => relation.requiredForCalculation)
    expect(detail?.records[0]).toEqual(expect.arrayContaining([
      { label: '物料编码', value: 'MATERIAL-A' },
      { label: '物料规格编码', value: 'SKU-A' },
      { label: '物料规格名称', value: '设备 A 标准版' },
    ]))
    expect(detail?.records[0]).not.toEqual(expect.arrayContaining([{ label: '物料规格', value: 'sku-1' }]))
    expect(calls.some((call) => call.name === 'get_record' && call.args.objectName === 'forge_material_sku')).toBe(true)
  })

  it('does not expose a native owner user ID as a person name', async () => {
    const requested: Record<string, unknown>[] = []
    const fields = [
      { name: 'id', type: 'text', label: 'ID' },
      { name: 'name', type: 'text', label: '名称' },
      { name: 'responsible_id', type: 'user', label: '负责人' },
    ]
    const reader = new ForgeBusinessReader(async (name, args) => {
      if (name === 'list_objects') return { objects: [{ name: 'sales_lead', label: '销售线索' }], totalCount: 1 }
      if (name === 'describe_object') return { name: 'sales_lead', label: '销售线索', fields }
      if (name === 'query_records') {
        requested.push(args)
        return { object: 'sales_lead', records: [{ id: 'lead-1', name: '青峦工业视觉检测改造', responsible_id: 'opaque-native-user-id' }], total: 1, hasMore: false }
      }
      throw new Error('unexpected tool')
    }, async () => ({ name: 'sales_lead', label: '销售线索', fields }))
    const page = await reader.findRecords('sales_lead', '青峦工业视觉检测改造', 0, 20, 1)
    expect(page.records).toMatchObject([{ name: '青峦工业视觉检测改造' }])
    expect(page.records[0]).not.toHaveProperty('owner')
    expect(requested[0].fields).not.toContain('responsible_id')
  })

  it('uses only the selected object and one native query page for search', async () => {
    const f = readerFixture()
    const page = await f.reader.findRecords('sales_quote', '采购订单 Q-999', 20, 10, 1)
    expect(page).toMatchObject({ offset: 20, limit: 10, hasMore: false, complete: true, records: [] })
    expect(f.calls.filter((call) => call.name === 'query_records')).toEqual([{
      name: 'query_records', args: expect.objectContaining({ objectName: 'sales_quote', offset: 20, limit: 10 }),
    }])
    expect(f.calls.filter((call) => call.name === 'query_records').every((call) => call.args.objectName !== 'customer')).toBe(true)
  })

  it('returns every matching record from a native page before advancing its offset', async () => {
    const fields = [
      { name: 'id', type: 'text', label: 'ID' },
      { name: 'name', type: 'text', label: '名称' },
    ]
    const reader = new ForgeBusinessReader(async (name, args) => {
      if (name === 'list_objects') return { objects: [{ name: 'sales_lead', label: '销售线索' }], totalCount: 1 }
      if (name === 'describe_object') return { name: 'sales_lead', fields }
      if (name === 'query_records') {
        const offset = Number(args.offset)
        return {
          records: Array.from({ length: Math.max(0, Math.min(50, 75 - offset)) }, (_, index) => ({
            id: `lead-${offset + index + 1}`, name: `客户需求 ${offset + index + 1}`,
          })),
          totalCount: 75,
        }
      }
      throw new Error(`unexpected ${name}`)
    }, async () => ({ name: 'sales_lead', fields }))
    const first = await reader.findRecords('sales_lead', '客户需求', 0, 50, 1)
    const second = await reader.findRecords('sales_lead', '客户需求', 50, 50, 1)
    expect(first).toMatchObject({ offset: 0, limit: 50, hasMore: true })
    expect(second).toMatchObject({ offset: 50, limit: 50, hasMore: false })
    expect([...first.records, ...second.records].map((record) => record.name)).toEqual(
      Array.from({ length: 75 }, (_, index) => `客户需求 ${index + 1}`),
    )
  })

  it('keeps the first truncation flag for a long field and nested collection', async () => {
    const fields = [
      { name: 'id', type: 'text', label: 'ID' },
      { name: 'name', type: 'text', label: '名称' },
      { name: 'terms', type: 'text', label: '合同条款' },
      { name: 'items', type: 'text', label: '项目清单' },
    ]
    const reader = new ForgeBusinessReader(async (name) => {
      if (name === 'list_objects') return { objects: [{ name: 'sales_contract', label: '销售合同' }], totalCount: 1 }
      if (name === 'get_record') return {
        id: 'contract-1', name: '测试合同', terms: 'A'.repeat(8_001), items: Array.from({ length: 21 }, (_, index) => index),
      }
      throw new Error(`unexpected ${name}`)
    }, async () => ({ name: 'sales_contract', fields }))
    const read = await reader.readRecord('sales_contract', 'contract-1', 1)
    expect(read.snapshot.completeness).toBe('truncated')
    expect(read.snapshot.completenessNotes.join(' ')).toContain('主记录字段已按安全读取上限截断')
    expect(read.snapshot.record).toEqual(expect.arrayContaining([
      { label: '合同条款', value: 'A'.repeat(8_000) },
      { label: '项目清单', value: Array.from({ length: 20 }, (_, index) => index) },
    ]))
  })

  it('does not report no matches when RLS/FLS omits every searchable display field', async () => {
    const f = readerFixture({ hideSearchFields: true })
    const page = await f.reader.findRecords('sales_quote', 'Q-240', 0, 20, 1)
    expect(page).toMatchObject({ records: [], complete: false, warning: expect.stringContaining('可读字段不足') })
  })

  it('returns the employee-readable state, owner and native record version with the opaque selection context', async () => {
    const f = readerFixture()
    const page = await f.reader.findRecords('sales_quote', 'Q-240 设备交接报价', 0, 20, 1)
    expect(page.records).toMatchObject([{ name: '设备交接报价', code: 'Q-240', status: '草稿', owner: '销售小李', recordVersion: '7' }])
    const query = f.calls.find((call) => call.name === 'query_records')!
    expect(query.args.fields).toEqual(expect.arrayContaining(['status', 'owner_name', 'version']))
  })

  it('confirms a related detail object from native metadata and compares the full row count with item_count', async () => {
    const f = readerFixture()
    const read = await f.reader.readRecord('sales_quote', 'quote-internal-1', 1)
    expect(read.snapshot).toMatchObject({
      completeness: 'partial',
      pricingDetailCompleteness: 'complete',
      expectedDetailCount: 2,
    })
    expect(read.snapshot.relations).toEqual(expect.arrayContaining([expect.objectContaining({ direction: 'related', returnedCount: 2, expectedCount: 2, requiredForCalculation: true, complete: true, recordIds: ['line-1', 'line-2'] })]))
    expect(f.metadataCalls).toEqual(['sales_quote', 'sales_quote_line', 'customer'])
    expect(f.calls.find((call) => call.name === 'query_records' && call.args.objectName === 'sales_quote_line')?.args.where).toEqual({ quote_id: 'quote-internal-1' })
    expect(f.calls.some((call) => call.name === 'query_records' && call.args.objectName === 'customer')).toBe(false)
    expect(JSON.stringify(read.snapshot)).not.toContain('quote-internal-1')
    expect(JSON.stringify(read.snapshot)).not.toContain('customer-internal-1')
    expect(JSON.stringify(read.snapshot)).not.toContain('private@example.test')
    expect(JSON.stringify(read.snapshot)).not.toContain('do-not-expose')
    expect(JSON.stringify(read.snapshot)).toContain('设备 2')
  })

  it('marks a declared item-count mismatch as blocking incomplete detail data', async () => {
    const f = readerFixture({ lineCount: 1 })
    const read = await f.reader.readRecord('sales_quote', 'quote-internal-1', 1)
    expect(read.snapshot).toMatchObject({ completeness: 'incomplete', pricingDetailCompleteness: 'incomplete', expectedDetailCount: 2 })
    expect(read.snapshot.completenessNotes.join(' ')).toContain('停止按完整明细核算')
    expect(read.snapshot.relations[0]).toMatchObject({ returnedCount: 1, expectedCount: 2, complete: false })
    expect(read.snapshot.relations[0]).not.toHaveProperty('recordIds')
  })

  it('keeps the selected record while reporting a child query denial as incomplete detail data', async () => {
    const f = readerFixture({ deniedLineQuery: true })
    const read = await f.reader.readRecord('sales_quote', 'quote-internal-1', 1)
    expect(read.snapshot).toMatchObject({ completeness: 'incomplete', pricingDetailCompleteness: 'incomplete' })
    expect(read.snapshot.relations.find((relation) => relation.direction === 'related')).toMatchObject({ returnedCount: 0, requiredForCalculation: true, complete: false })
    expect(read.candidate.name).toBe('设备交接报价')
  })

  it('keeps the selected record while reporting an unreadable native parent relation as partial', async () => {
    const f = readerFixture({ denyParentRead: true })
    const read = await f.reader.readRecord('sales_quote', 'quote-internal-1', 1)
    expect(read.snapshot.completeness).toBe('partial')
    expect(read.snapshot.pricingDetailCompleteness).toBe('complete')
    expect(read.snapshot.relations).toEqual(expect.arrayContaining([expect.objectContaining({ direction: 'reference', returnedCount: 0, complete: false })]))
  })
})

it('binds creation SKU names to the actual authorized material read, without parsing display labels', async () => {
  for (const mode of ['read', 'denied', 'wrong-record'] as const) {
    const skuFields: Field[] = [{ name: 'id', type: 'text', label: 'ID' }, { name: 'name', type: 'text', label: '规格名称' },
      { name: 'code', type: 'text', label: '规格编号' }, { name: 'material_id', type: 'lookup', label: '所属物料', reference: 'forge_material' }]
    const materialFields: Field[] = [{ name: 'id', type: 'text', label: 'ID' }, { name: 'name', type: 'text', label: '物料名称' }]
    const reader = new ForgeBusinessReader(async (name, args) => {
      if (name === 'list_objects') return { objects: [{ name: 'forge_material_sku', label: '物料规格' }, { name: 'forge_material', label: '物料' }], totalCount: 2 }
      if (name === 'query_records') return { records: [], total: 0, hasMore: false }
      if (name === 'get_record' && args.objectName === 'forge_material_sku') return { id: 'sku-a', name: '标准配置', code: 'SKU-A', material_id: 'material-a' }
      if (name === 'get_record' && args.objectName === 'forge_material') {
        if (mode === 'denied') throw new ForgeBusinessReadError('forbidden', 'denied')
        return { id: mode === 'wrong-record' ? 'other-material' : 'material-a', name: '设备甲' }
      }
      throw new Error('unexpected read')
    }, async objectName => metadata(objectName, objectName === 'forge_material_sku' ? '物料规格' : '物料', objectName === 'forge_material_sku' ? skuFields : materialFields))
    const result = await reader.readRecord('forge_material_sku', 'sku-a', 1)
    expect(result.candidate.name).toBe('标准配置')
    if (mode === 'read') expect(result.creationSku).toEqual({ name: '标准配置', materialName: '设备甲', code: 'SKU-A' })
    else expect(result).not.toHaveProperty('creationSku')
  }
})
