import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PrimeModelDescriptor } from '../../src/types/api'
import { CliModelCatalogService, validateModelEntry, type CliModelCatalogOptions } from './model-catalog-cli'
import type { ExecutableSource } from './process-utils'
import type { LoomModelConfig } from './providers'
import { runModelProbe } from './providers-pi'

export const LOOM_NOT_INSTALLED_WARNING = 'Loom is not installed. Add the loom executable to load its model catalog.'

export interface LoomModelCatalogOptions extends CliModelCatalogOptions {
  /** Loom's private configuration directory (LOOM_AGENT_DIR). */
  agentDir: string
  /** The models and keys Loom may use, derived from the connected providers. */
  modelConfig: () => Promise<LoomModelConfig>
}

/**
 * Model catalog for the Loom harness. Before each fetch it writes Loom's
 * models.json and auth.json from the providers connected in the app, then asks
 * `loom agent --mode rpc` for `get_available_models`, the same probe pi uses.
 * The files are private to the app profile (0600) and rewritten only when
 * their content changes.
 */
export class LoomModelCatalogService extends CliModelCatalogService {
  protected readonly harnessLabel = 'Loom'
  protected readonly notInstalledWarning = LOOM_NOT_INSTALLED_WARNING
  protected readonly credentialsLabel = 'Shared with the providers connected for Prime Work'
  private readonly agentDir: string
  private readonly modelConfig: () => Promise<LoomModelConfig>

  constructor(executable: ExecutableSource, options: LoomModelCatalogOptions) {
    super(executable, options)
    this.agentDir = options.agentDir
    this.modelConfig = options.modelConfig
  }

  /** `loom --version` prints `loom <version>`. */
  protected parseVersion(stdout: string): string | null {
    return stdout.trim().match(/^loom\s+v?([0-9A-Za-z][0-9A-Za-z.+-]{0,63})$/)?.[1] ?? null
  }

  /** Writes models.json and auth.json when their content changed. */
  async syncModelConfig(): Promise<void> {
    const config = await this.modelConfig()
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 })
    await writePrivateIfChanged(join(this.agentDir, 'models.json'), `${JSON.stringify(config.models, null, 2)}\n`)
    await writePrivateIfChanged(join(this.agentDir, 'auth.json'), `${JSON.stringify(config.auth, null, 2)}\n`)
  }

  protected async fetchModelEntries(executable: string): Promise<unknown[]> {
    await this.syncModelConfig()
    const frame = await runModelProbe(executable, { timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes, environment: this.environment, args: ['agent', '--mode', 'rpc'] })
    if (frame.success !== true) {
      const reason = typeof frame.error === 'string' && frame.error.length > 0
        ? frame.error.replace(/[^\x20-\x7e]+/g, ' ').slice(0, 200)
        : 'unknown error'
      throw new Error(`loom rejected the model catalog request: ${reason}`)
    }
    return this.requireModelEntries(frame.data)
  }

  protected toModelDescriptor(value: unknown): PrimeModelDescriptor | null {
    const entry = validateModelEntry(value)
    if (!entry) return null
    return {
      ...entry.descriptor,
      availableThinkingLevels: entry.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : ['off'],
    }
  }
}

async function writePrivateIfChanged(path: string, content: string): Promise<void> {
  try {
    if (await readFile(path, 'utf8') === content) return
  } catch { /* missing: write it */ }
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(temporary, 0o600)
  await rename(temporary, path)
}
