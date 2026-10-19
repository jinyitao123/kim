import { projectWorkActionFact, workActionTitle, workActionReceiptMeaning } from '@/lib/work-action-outcomes'
import type { EnterpriseWorkContinuationContextView } from '@/types/api'

type Outcomes = NonNullable<Extract<EnterpriseWorkContinuationContextView, { kind: 'weave' }>['actionOutcomes']>


export function WorkActionReceipt({ outcomes }: { outcomes?: Outcomes }) {
  return <aside className="work-action-receipt" aria-label="本次业务动作回执">
    <strong>本次业务动作回执</strong>
    {outcomes === undefined
      ? <p>未取得业务动作回执；不能根据团队摘要认定已提交。</p>
      : outcomes.length === 0
        ? <p>平台记录本次调用次数为 0；不能根据团队摘要认定已提交。</p>
        : <ul>{outcomes.map((raw, index) => { const outcome = projectWorkActionFact(raw); return <li key={`${outcome.status}:${index}`}><strong>{workActionTitle(outcome)}</strong><p>{outcome.summary}</p><p>{workActionReceiptMeaning(outcome.status)}</p></li> })}</ul>}
  </aside>
}
