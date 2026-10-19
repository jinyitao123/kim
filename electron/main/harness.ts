import { join } from 'node:path'

import type { HarnessId } from '../../src/types/api'

/**
 * Static description of one agent harness: how its executable is discovered
 * and where its agent state lives on disk. Discovery itself stays in
 * process-utils (`harnessExecutableCandidates`/`findHarnessExecutable`) so
 * every harness shares the same absolute-path and X_OK rules.
 */
export interface HarnessDescriptor {
  id: HarnessId
  productName: string
  agentName: string
  executableName: (platform: NodeJS.Platform) => string
  /** Environment override for the executable; only absolute paths are honored. */
  binaryEnvVar: string
  /** Directories under process.resourcesPath (as path segments) that may bundle the executable. */
  bundledResourceDirs: readonly (readonly string[])[]
  /** Harness-specific locations beyond the shared package-manager and system directories. */
  candidateDirs: (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv) => string[]
  /** Official npm `.cmd` shim on Windows and the package entrypoint below `<shim dir>\node_modules`. */
  windowsNpmShim?: { shim: string; entrypoint: readonly string[] }
  agentDir: (home: string) => string
  sessionRoot: (home: string) => string
}

export const PRIVATE_PRIME_RUNTIME_VERSION = '0.7.0-gooeypi.2'

export const HARNESSES: Record<HarnessId, HarnessDescriptor> = {
  prime: {
    id: 'prime',
    productName: 'Prime Work',
    agentName: 'Prime Agent',
    executableName: (platform) => platform === 'win32' ? 'prime-agent.exe' : 'prime-agent',
    binaryEnvVar: 'PRIME_AGENT_BINARY',
    bundledResourceDirs: [['runtime', 'bin'], ['agent'], ['agent', 'bin']],
    candidateDirs: (platform, home, env) => platform === 'win32' ? [] : [
      join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'prime-agent-node', 'current', 'bin'),
    ],
    windowsNpmShim: { shim: 'prime-agent.cmd', entrypoint: ['prime-agent', 'dist', 'bundle', 'cli.js'] },
    agentDir: (home) => join(home, '.prime', 'agent'),
    sessionRoot: (home) => join(home, '.prime', 'agent', 'sessions'),
  },
  pi: {
    id: 'pi',
    productName: 'Pi Work',
    agentName: 'Pi',
    executableName: (platform) => platform === 'win32' ? 'pi.exe' : 'pi',
    binaryEnvVar: 'PI_BINARY',
    bundledResourceDirs: [['runtime', 'bin']],
    candidateDirs: (platform, home, env) => platform === 'win32' ? [] : [
      join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'pi-node', 'current', 'bin'),
    ],
    windowsNpmShim: { shim: 'pi.cmd', entrypoint: ['@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'] },
    agentDir: (home) => join(home, '.pi', 'agent'),
    sessionRoot: (home) => join(home, '.pi', 'agent', 'sessions'),
  },
  loom: {
    id: 'loom',
    productName: 'Loom Work',
    agentName: 'Loom',
    // One self-contained Go executable; no Node runtime or npm shim.
    executableName: (platform) => platform === 'win32' ? 'loom.exe' : 'loom',
    binaryEnvVar: 'LOOM_BINARY',
    bundledResourceDirs: [['runtime', 'bin']],
    candidateDirs: (_platform, home) => [join(home, 'go', 'bin')],
    agentDir: (home) => join(home, '.loom', 'agent'),
    sessionRoot: (home) => join(home, '.loom', 'agent', 'sessions'),
  },
}
