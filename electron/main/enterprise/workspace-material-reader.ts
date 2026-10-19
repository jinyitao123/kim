import type { WorkspaceMaterialPromptReference } from '../../../src/types/api'
import { freezeMaterials } from './materials'
import { rejectUnknownKeys, requireString } from '../validation'

/** Read only the exact original selected by this employee turn. */
export async function readSelectedWorkspaceMaterial(
  cwd: string,
  selected: readonly WorkspaceMaterialPromptReference[],
  params: Record<string, unknown>,
) {
  rejectUnknownKeys(params, ['turn_key', 'path', 'sha256'], 'selected material')
  const path = requireString(params.path, 'path', { min: 1, max: 4000 })
  const sha256 = requireString(params.sha256, 'sha256', { min: 64, max: 64 })
  const reference = selected.find(item => item.path === path && item.sha256 === sha256)
  if (!reference) throw new Error('该文件及版本未由本轮员工选定，请重新添加准确材料后读取')
  const [material] = await freezeMaterials(cwd, [{ path, sha256 }])
  if (!material || material.bytes !== reference.bytes || material.mediaType !== reference.mimeType || material.name !== reference.name) {
    throw new Error('材料与本轮选定的名称、格式或字节数不一致，请重新选择')
  }
  return { name: material.name, mediaType: material.mediaType, bytes: material.bytes, sha256: material.sha256, extraction: material.extraction }
}
