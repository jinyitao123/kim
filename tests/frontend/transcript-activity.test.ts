import { describe, expect, it } from 'vitest'
import { classifyTool, formatWorkedDuration } from '../../src/components/Transcript'
import { summarizeWork } from '../../src/components/transcript/timeline'
import type { MessagePart } from '../../src/types/api'

describe('transcript activity presentation', () => {
  it('formats only the elapsed units that are needed', () => {
    expect(formatWorkedDuration(8_000)).toBe('8 秒')
    expect(formatWorkedDuration(128_000)).toBe('2 分 08 秒')
    expect(formatWorkedDuration(3_728_000)).toBe('1 小时 02 分 08 秒')
    expect(formatWorkedDuration(59 * 60_000 + 59_000)).toBe('59 分 59 秒')
  })

  it('maps tool names to recognizable activity icons', () => {
    expect(classifyTool('ask_user')).toBe('question')
    expect(classifyTool('bash')).toBe('terminal')
    expect(classifyTool('web_search')).toBe('web')
    expect(classifyTool('git status')).toBe('git')
    expect(classifyTool('read_file')).toBe('file')
    expect(classifyTool('custom_mcp_tool')).toBe('mcp')
  })

  it('summarizes a finished turn by step count and the most frequent kinds', () => {
    const call = (name: string): MessagePart => ({ type: 'toolCall', id: name, name })
    const parts: MessagePart[] = [
      { type: 'thinking', text: 'plan' }, call('read_file'), { type: 'toolResult', name: 'read_file', text: 'ok' },
      call('edit_file'), call('bash'), call('read_file'), call('web_search'),
    ]
    expect(summarizeWork(parts, true)).toBe('做了 5 步 · 处理 3 个文件、运行 1 条命令、查阅 1 次网页')
    expect(summarizeWork(parts, false)).toBe('做了 5 步')
    expect(summarizeWork([{ type: 'thinking', text: 'only thought' }], true)).toBe('')
  })
})
