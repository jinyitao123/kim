import { expect, it } from 'vitest'
import { trialToolDisplayName, type TrialToolEvidence } from '../../src/lib/trial-tool-evidence'
import { trialToolAction } from '../fixtures/trial-activity'

const output = JSON.stringify({ objectName: trialToolAction.objectName, actionName: trialToolAction.actionName, simulated: true })

it('uses the complete recorded action identity and its unique catalog name', () => {
  expect(trialToolDisplayName({ output, output_state: 'recorded' }, [trialToolAction])).toBe('调整报价明细')
  expect(trialToolDisplayName({ output }, [trialToolAction])).toBe('调整报价明细')
})

it.each([
  { label: 'missing output', tool: {} },
  { label: 'explicitly missing output with stale content', tool: { output, output_state: 'missing' } },
  { label: 'truncated output with syntactically valid content', tool: { output, output_state: 'truncated' } },
  { label: 'non-JSON output', tool: { output: 'already complete' } },
  { label: 'array output', tool: { output: JSON.stringify([{ objectName: trialToolAction.objectName, actionName: trialToolAction.actionName }]) } },
  { label: 'null output', tool: { output: 'null' } },
  { label: 'missing action identity', tool: { output: JSON.stringify({ objectName: trialToolAction.objectName }) } },
  { label: 'different object', tool: { output: JSON.stringify({ objectName: 'other_quotation', actionName: trialToolAction.actionName }) } },
  { label: 'different action', tool: { output: JSON.stringify({ objectName: trialToolAction.objectName, actionName: 'other_price_action' }) } },
] as Array<{ label: string; tool: TrialToolEvidence }>)('falls back to a readable generic label for $label', ({ tool }) => {
  expect(trialToolDisplayName(tool, [trialToolAction])).toBe('工具调用')
})

it('does not choose a catalog entry when identity is missing, ambiguous or has no usable name', () => {
  expect(trialToolDisplayName({ output })).toBe('工具调用')
  expect(trialToolDisplayName({ output }, [trialToolAction, { ...trialToolAction, id: 'duplicate-action', name: '另一调价动作' }])).toBe('工具调用')
  expect(trialToolDisplayName({ output }, [{ ...trialToolAction, name: '  ' }])).toBe('工具调用')
})
