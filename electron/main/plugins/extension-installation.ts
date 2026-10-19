import { lstatSync, realpathSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import { isRecord, requireString } from '../validation'

const EXTENSION_SUFFIXES = new Set(['.ts', '.js', '.mjs', '.cjs'])
const MAX_EXTENSION_BYTES = 4 * 1024 * 1024

export interface ValidatedExtensionInstallInput {
  source: string
  scope: 'user' | 'project'
  projectPath?: string
}

export function validateExtensionInstallInput(value: unknown): ValidatedExtensionInstallInput {
  if (!isRecord(value)) throw new TypeError('Extension installation must contain an object')
  const requested = requireString(value.source, 'extension source', { min: 1, max: 4_096, trim: true })
  if (!isAbsolute(requested)) throw new TypeError('Extension source must be an absolute local file path')
  let source: string
  try { source = realpathSync(requested) } catch { throw new TypeError('Extension source does not exist') }
  const stat = lstatSync(source)
  if (!stat.isFile()) throw new TypeError('Extension source must be a regular file')
  if (!EXTENSION_SUFFIXES.has(extname(source).toLowerCase())) throw new TypeError('Extension source must be a .ts, .js, .mjs, or .cjs file')
  if (stat.size > MAX_EXTENSION_BYTES) throw new TypeError(`Extension source must not exceed ${MAX_EXTENSION_BYTES} bytes`)
  if (value.scope !== 'user' && value.scope !== 'project') throw new TypeError('Extension scope must be user or project')
  const projectPath = value.scope === 'project'
    ? requireString(value.projectPath, 'projectPath', { min: 1, max: 4_096 })
    : undefined
  return { source, scope: value.scope, projectPath }
}
