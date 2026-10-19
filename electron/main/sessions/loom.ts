import type { SessionServiceOptions } from '../sessions'
import { createBucketedCatalogIo, isBucketedSessionPath } from './bucketed'
import { piSessionServiceOptions } from './pi'

/**
 * Loom writes the same version-3 JSONL session files as pi, one cwd bucket
 * below LOOM_SESSION_DIR (`<root>/--<cwd>--/<timestamp>_<uuid>.jsonl`), so the
 * pi readers apply unchanged; only the harness and the plain bucketed layout
 * differ.
 */
export function loomSessionServiceOptions(sessionRoot: string): SessionServiceOptions {
  return {
    ...piSessionServiceOptions(sessionRoot),
    harness: 'loom',
    catalogIo: createBucketedCatalogIo(),
    isSessionPathAuthorized: isBucketedSessionPath,
  }
}
