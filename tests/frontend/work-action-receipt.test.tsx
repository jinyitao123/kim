// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { WorkActionReceipt } from '../../src/components/WorkActionReceipt'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('keeps an empty action receipt separate from a model summary that claims submission', async () => {
  await act(async () => root.render(<WorkActionReceipt outcomes={[]}/>))

  expect(container.textContent).toContain('平台记录本次调用次数为 0')
  expect(container.textContent).toContain('不能根据团队摘要认定已提交')
})

it('shows successful, failed, and unknown platform action outcomes without promoting unknown to success', async () => {
  await act(async () => root.render(<WorkActionReceipt outcomes={[
    { actionName: 'submit', objectName: 'record', status: 'succeeded', summary: '平台记录：业务动作“线索转商机”已确认完成。' },
    { actionName: 'update', objectName: 'record', status: 'failed', summary: '平台记录：业务动作“调整客户信息”返回失败。' },
    { actionName: 'resume', objectName: 'record', status: 'unknown', summary: '平台记录：业务动作“合同提交”结果未知，请先核对业务记录。' },
    { actionName: 'forge_contract.submit_r2', objectName: 'forge_contract', status: 'succeeded', summary: '平台记录：业务动作“forge_contract.submit_r2”已确认完成。' },
  ]}/>))

  expect(container.textContent).toContain('线索转商机：工具调用返回成功')
  expect(container.textContent).toContain('调整客户信息未完成')
  expect(container.textContent).toContain('合同提交结果待核对')
  expect(container.textContent).toContain('业务动作：工具调用返回成功')
  expect(container.textContent).not.toContain('forge_contract.submit_r2')
})

it('states when the work message carries no action receipt', async () => {
  await act(async () => root.render(<WorkActionReceipt/>))

  expect(container.textContent).toContain('未取得业务动作回执')
  expect(container.textContent).toContain('不能根据团队摘要认定已提交')
})
