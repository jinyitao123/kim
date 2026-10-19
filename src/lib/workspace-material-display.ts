import type { TranscriptMessage } from '../types/api'
import { splitWorkspaceMaterialContext } from './workspace-material-attachments'

/** Presentation only. Original messages, tool arguments and source references stay intact. */
export function projectMaterialDisplayMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  const replacements = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.parts)) continue
    for (const part of message.parts) {
      if (part.type !== 'text') continue
      for (const source of splitWorkspaceMaterialContext(part.text).attachments) {
        replacements.set(source.path, source.name)
        replacements.set(source.path.replaceAll('/', '\\'), source.name)
      }
    }
  }
  if (!replacements.size) return messages
  let changed = false
  const result = messages.map(message => {
    if ((message.role !== 'assistant' && message.role !== 'agent') || !Array.isArray(message.parts)) return message
    let messageChanged = false
    const parts = message.parts.map(part => {
      if (part.type !== 'text' && part.type !== 'thinking') return part
      let text = part.text
      for (const [path, name] of replacements) text = text.replaceAll(path, name)
      if (text === part.text) return part
      messageChanged = true
      return { ...part, text }
    })
    if (!messageChanged) return message
    changed = true
    return { ...message, parts }
  })
  return changed ? result : messages
}
