// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { WorkTimeline } from '../../src/components/transcript/timeline'
import { initializationToolView } from '../../src/components/transcript/initialization-tool-view'

describe('initialization activity presentation', () => {
  it('shows business names for native list/run while hiding arguments, UUIDs and native digests', () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div'), root = createRoot(container)
    const internal = '8cbe7c3c-6f01-4841-ad53-a4170c3b4d72', digest = 'b'.repeat(64)
    act(() => root.render(<WorkTimeline showReasoning={false} showTools parts={[
      { type: 'toolCall', name: 'gooeypi_enterprise_initialization_run', args: { record_id: internal, inputs_json: '{"fields_json":"private-input"}' } },
      { type: 'toolResult', text: JSON.stringify({ version: '1', status: 'succeeded', actionLabel: '初始化计量单位', nativeRequestDigest: digest, operationId: internal,
        summary: '已保存计量单位', outcomes: [{ domain: '计量单位', name: '台', fields: { operation_key: internal } }] }) },
    ]} />))
    act(() => (container.querySelector('.activity-tool__summary') as HTMLButtonElement).click())
    expect(container.textContent).toContain('初始化计量单位')
    expect(container.textContent).toContain('计量单位：台')
    for (const hidden of [internal, digest, 'nativeRequestDigest', 'operation_key', 'private-input', 'inputs_json', 'fields_json']) expect(container.textContent).not.toContain(hidden)
    act(() => root.unmount())
    const catalog = initializationToolView('gooeypi_enterprise_initialization_list', JSON.stringify({ actions: [{ label: '创建岗位', name: 'initialization_positions', params: [{ name: 'operation_key' }] }] }))
    expect(catalog?.output).toBe('创建岗位')
  })
  it('keeps protocol handles out of both the activity summary and expanded result', () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div'), root = createRoot(container)
    const internal = '8cbe7c3c-6f01-4841-ad53-a4170c3b4d72', plan = 'a'.repeat(64)
    act(() => root.render(<WorkTimeline showReasoning={false} showTools parts={[
      { type: 'toolCall', name: 'gooeypi_enterprise_initialization_apply', args: { plan_key: plan, employee_request: '办理这批资料' } },
      { type: 'toolResult', text: JSON.stringify({ version: '1', operationId: internal, operation_key: plan, summary: '已应用1条资料', outcomes: [{ domain: '计量单位', name: '台', effect: 'create' }] }) },
    ]} />))
    expect(container.textContent).toContain('应用初始化方案')
    act(() => (container.querySelector('.activity-tool__summary') as HTMLButtonElement).click())
    expect(container.textContent).toContain('计量单位：台')
    expect(container.textContent).not.toContain(internal)
    expect(container.textContent).not.toContain(plan)
    expect(container.textContent).not.toContain('plan_key')
    act(() => root.unmount())
  })
  it('shows the reviewed native defaults and keeps malformed results neutral', () => {
    const result = initializationToolView('gooeypi_enterprise_initialization_preview', JSON.stringify({ plan_key: 'internal', changes: [{ domain: '计量单位', name: '套', effect: 'create', fields: { '业务状态（原生默认）': '启用' } }] }))
    expect(result?.output).toContain('业务状态（原生默认）：启用')
    expect(result?.output).not.toContain('internal')
    expect(initializationToolView('gooeypi_enterprise_initialization_result', '{"operation_key":')?.output).not.toContain('operation_key')
    expect(initializationToolView('read_file', 'ordinary output')).toBeUndefined()
  })
  it('keeps source cell values and reading limits visible without exposing the workbook digest', () => {
    const result = initializationToolView('gooeypi_enterprise_initialization_workbook', JSON.stringify({ sourceSha256: 'private-digest', sheets: [{ name: '期初', visibility: 'hidden', rows: [{ cells: [{ cell: 'A1', value: '00001234' }, { cell: 'B1', value: null, unread: true }] }] }], warnings: [{ sheet: '期初', cell: 'B1', reason: '公式没有可靠缓存结果' }] }))
    expect(result?.output).toContain('期初（隐藏表）')
    expect(result?.output).toContain('A1：00001234')
    expect(result?.output).toContain('B1：未可靠读取')
    expect(result?.output).toContain('期初 B1：公式没有可靠缓存结果')
    expect(result?.output).not.toContain('private-digest')
  })
})
