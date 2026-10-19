import { describe, expect, it } from 'vitest'
import { businessNotificationPrompt } from '../../src/lib/business-notification'
import type { EnterpriseBusinessNotificationContextView, EnterpriseWorkItem } from '../../src/types/api'

const item: EnterpriseWorkItem = {
  id: 'notice-1', kind: 'result', notificationType: 'sales.contract.approved',
  title: '合同已通过', summary: '审批当时已通过。', status: 'unknown', actionable: false,
  read: false, source: 'forge', createdAt: '2026-09-30T00:00:00Z',
}

function context(materialStatus: EnterpriseBusinessNotificationContextView['materialStatus']): EnterpriseBusinessNotificationContextView {
  return {
    kind: 'business', currentReadAt: '2026-09-30T01:00:00Z', materialStatus,
    record: {
      objectLabel: '销售合同', name: '设备验收合同', code: 'C-100', status: '内部复核通过',
      fields: [{ label: '状态', value: '内部复核通过' }], relations: [], completeness: 'complete',
      pricingDetailCompleteness: 'unknown', completenessNotes: [],
    },
    materials: materialStatus === 'available' ? [{
      name: '合同正文.pdf', mediaType: 'application/pdf', bytes: 42, verified: true,
      extraction: { status: 'partial', content: '当前合同正文原文', coverage: { pdfPageCount: 2, pdfTextPageCount: 1, pdfPagesWithoutText: [2] }, limitations: ['page-without-text'] },
    }] : [],
  }
}

describe('Forge business notification prompt', () => {
  it('separates historical notification text from the freshly read record and verified files', () => {
    const prompt = businessNotificationPrompt(item, context('available'))
    expect(prompt).toContain('历史通知摘要')
    expect(prompt).toContain('不代表当前业务事实')
    expect(prompt).toContain('当前记录读取时间')
    expect(prompt).toContain('内部复核通过')
    expect(prompt).toContain('当前合同正文原文')
    expect(prompt).toContain('不提交业务动作、不发起团队工作')
    expect(prompt).toContain('之后的新消息中明确提出新的工作要求')
    expect(prompt).toContain('当前账号可见范围内的业务信息已读取')
    expect(prompt).toContain('部分页面、图片或文档内容未能提取')
    expect(prompt).not.toContain('page-without-text')
    expect(prompt).not.toContain('：complete')
    expect(prompt).not.toContain('notificationId')
    expect(prompt).not.toContain('recordId')
  })

  it('does not present unavailable materials as an empty or complete file set', () => {
    const prompt = businessNotificationPrompt(item, context('unavailable'))
    expect(prompt).toContain('暂时无法读取')
    expect(prompt).toContain('不代表没有材料')
    expect(prompt).not.toContain('没有可读取的业务材料')
  })

  it('clearly distinguishes a confirmed absence of business materials', () => {
    expect(businessNotificationPrompt(item, context('none'))).toContain('Forge 确认当前没有可读取的业务材料')
  })

  it('keeps a partial result readable without serializing opaque values or structured field contents', () => {
    const current = context('available')
    current.record.completeness = 'partial'
    current.record.fields.push({ label: '需要法务复核', value: false }, { label: '附件数据', value: { file_id: 'private-reference' } }, { label: '材料说明', value: '{"file_id":"private-reference"}' }, { label: '参考', value: '10000000-0000-4000-8000-000000000001' })
    const prompt = businessNotificationPrompt(item, current)
    expect(prompt).toContain('需要法务复核：否')
    expect(prompt).toContain('部分关联信息未能完整读取')
    expect(prompt).not.toContain('private-reference')
    expect(prompt).not.toContain('10000000-0000-4000-8000-000000000001')
    expect(prompt).not.toContain('：partial')
  })
})
