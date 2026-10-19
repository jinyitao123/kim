import { join } from 'node:path'
import type { HarnessId } from '../../src/types/api'

export type ExtensionCapability = 'schedule' | 'browser' | 'askUser' | 'collaboration' | 'enterprise' | 'teamDevelopment' | 'piFastMode'

export interface ExtensionInjection {
  readonly capability: ExtensionCapability
  readonly filename: string
  readonly environmentVariable: string
}

const injectionsByHarness = {
  prime: [
    { capability: 'browser', filename: 'prime-work-browser.ts', environmentVariable: 'PRIME_WORK_BROWSER_EXTENSION_PATH' },
    { capability: 'askUser', filename: 'gooeypi-work-ask-user.ts', environmentVariable: 'PRIME_WORK_ASK_USER_EXTENSION_PATH' },
    { capability: 'collaboration', filename: 'gooeypi-work-collaboration.ts', environmentVariable: 'GOOEYPI_COLLABORATION_EXTENSION_PATH' },
    { capability: 'enterprise', filename: 'gooeypi-enterprise.ts', environmentVariable: 'GOOEYPI_ENTERPRISE_EXTENSION_PATH' },
  ],
  pi: [
    { capability: 'piFastMode', filename: 'pi-work-fast-mode.ts', environmentVariable: 'GOOEYPI_PI_FAST_MODE_EXTENSION_PATH' },
    { capability: 'teamDevelopment', filename: 'gooeypi-team-development.ts', environmentVariable: 'GOOEYPI_TEAM_DEVELOPMENT_EXTENSION_PATH' },
    { capability: 'schedule', filename: 'gooeypi-work-schedules.ts', environmentVariable: 'PRIME_WORK_SCHEDULE_EXTENSION_PATH' },
    { capability: 'browser', filename: 'gooeypi-work-browser.ts', environmentVariable: 'PRIME_WORK_BROWSER_EXTENSION_PATH' },
    { capability: 'askUser', filename: 'gooeypi-work-ask-user.ts', environmentVariable: 'PRIME_WORK_ASK_USER_EXTENSION_PATH' },
    { capability: 'collaboration', filename: 'gooeypi-work-collaboration.ts', environmentVariable: 'GOOEYPI_COLLABORATION_EXTENSION_PATH' },
    { capability: 'enterprise', filename: 'gooeypi-enterprise.ts', environmentVariable: 'GOOEYPI_ENTERPRISE_EXTENSION_PATH' },
  ],
  // Loom runs no TypeScript extensions; the same capabilities reach it as
  // MCP tool servers hosted by the main process.
  loom: [],
} as const satisfies Readonly<Record<HarnessId, readonly ExtensionInjection[]>>

export const EXTENSION_INJECTIONS = Object.freeze(injectionsByHarness)

export const SHIPPED_EXTENSION_FILENAMES = [...new Set(
  Object.values(injectionsByHarness).flatMap((injections) => injections.map(({ filename }) => filename)),
)].sort()

export function extensionInjections(harness: HarnessId): readonly ExtensionInjection[] {
  return EXTENSION_INJECTIONS[harness]
}

export function extensionInjection(harness: HarnessId, capability: ExtensionCapability): ExtensionInjection {
  const injection = extensionInjections(harness).find((candidate) => candidate.capability === capability)
  if (!injection) throw new Error(`Harness ${harness} does not inject the ${capability} extension`)
  return injection
}

export interface ExtensionPathContext {
  readonly isPackaged: boolean
  readonly appPath: string
  readonly resourcesPath: string
}

export function resolveExtensionPath(filename: string, context: ExtensionPathContext): string {
  const root = context.isPackaged ? context.resourcesPath : join(context.appPath, 'assets')
  return join(root, 'extensions', filename)
}
