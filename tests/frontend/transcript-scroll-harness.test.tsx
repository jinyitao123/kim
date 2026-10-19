// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { useTranscriptScroll } from '../../src/components/transcript/scroll'
import type { HarnessId, TranscriptMessage } from '../../src/types/api'

const activeMessage: TranscriptMessage = {
  id: 'active', role: 'assistant', timestamp: 1, streaming: true, parts: [],
}

function Announcement({ harness, messages }: { harness: HarnessId; messages: TranscriptMessage[] }) {
  const { announcement } = useTranscriptScroll(messages, harness)
  return <div role="status">{announcement}</div>
}

describe('transcript live announcements', () => {
  it.each([
    ['prime', 'Prime'],
    ['pi', 'Pi'],
  ] as const)('names the active %s harness while working and after completion', async (harness, shortName) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => { root.render(<Announcement harness={harness} messages={[activeMessage]} />) })
      expect(container.textContent).toBe(`${shortName} is working.`)

      await act(async () => { root.render(<Announcement harness={harness} messages={[]} />) })
      expect(container.textContent).toBe(`${shortName} response complete.`)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
