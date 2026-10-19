import { digest, type HandoffStore } from './handoff-store'

/**
 * How far one material got on its way into Forge. `presigned` has a file
 * number but no confirmed bytes, `uploaded` sent the bytes but has no confirmed
 * commit, `completed` is a committed Forge file.
 */
export interface MaterialUploadReceipt {
  fileId: string
  phase: 'presigned' | 'uploaded' | 'completed'
}

/** Per-file receipts kept while materials are uploaded, so an interrupted upload resumes file by file. */
export interface MaterialUploadProgress {
  read(materialKey: string): Promise<MaterialUploadReceipt | undefined>
  write(materialKey: string, receipt: MaterialUploadReceipt): Promise<void>
}

/** A material's identity within one upload: the frozen material and its exact bytes. */
export function materialUploadKey(material: { materialId: string; sha256: string }): string {
  return `${material.materialId}:${material.sha256}`
}

/**
 * Receipts for the uploads of one frozen handoff, kept in the handoff store
 * under the handoff's own key. A receipt only ever moves forward.
 */
export function storedUploadProgress(store: HandoffStore, scope: string): MaterialUploadProgress {
  const key = (materialKey: string) => `${scope}:upload:${materialKey}`
  return {
    async read(materialKey) {
      const saved = await store.inspect<MaterialUploadReceipt>(key(materialKey))
      return saved?.fingerprint === digest(materialKey) ? saved.value : undefined
    },
    async write(materialKey, receipt) {
      await store.checkpoint(key(materialKey), digest(materialKey), receipt)
    },
  }
}
