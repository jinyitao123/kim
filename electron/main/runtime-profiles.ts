import { chmod, lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessId } from '../../src/types/api'
import { safeChildEnvironment, type ExecutableSource } from './process-utils'
import { PrimeProviderService } from './providers'
import { LoomModelCatalogService } from './providers-loom'
import { PiModelCatalogService } from './providers-pi'

export interface RuntimeProfile {
  agentDir: string
  environment: NodeJS.ProcessEnv
}

/** Explicit agent roots preserve the user's real HOME and never migrate CLI credentials. */
export function runtimeProfile(directory: string, harness: HarnessId, inherited: NodeJS.ProcessEnv = process.env): RuntimeProfile {
  const agentDir = join(directory, 'runtime-profiles', harness, 'agent')
  const environment: NodeJS.ProcessEnv = { ...inherited }
  // Missing app credentials must not silently fall back to inherited provider keys.
  for (const key of Object.keys({ ...process.env, ...inherited })) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ACCESS_KEY)|^(?:AWS_|GOOGLE_|GCLOUD_|AZURE_|NPM_CONFIG_)/i.test(key)) environment[key] = undefined
  }
  environment[harness === 'prime' ? 'PRIME_AGENT_CODING_AGENT_DIR' : harness === 'loom' ? 'LOOM_AGENT_DIR' : 'PI_CODING_AGENT_DIR'] = agentDir
  environment.GOOGLE_APPLICATION_CREDENTIALS = join(agentDir, 'google-credentials.json')
  environment.AWS_SHARED_CREDENTIALS_FILE = join(agentDir, 'aws-credentials')
  environment.AWS_CONFIG_FILE = join(agentDir, 'aws-config')
  environment.AWS_EC2_METADATA_DISABLED = 'true'
  environment.NPM_CONFIG_USERCONFIG = join(agentDir, 'npm-user.rc')
  environment.NPM_CONFIG_GLOBALCONFIG = join(agentDir, 'npm-global.rc')
  environment.NPM_CONFIG_CACHE = join(agentDir, 'npm-cache')
  environment.NPM_CONFIG_PREFIX = join(agentDir, 'npm-global')
  environment.NODE_PATH = undefined
  const sessions = join(directory, 'agent-sessions', 'accounts', 'signed-out', harness)
  if (harness === 'prime') {
    environment.WEAVE_DISABLE_SHARED_PRIME_AUTH = '1'
    environment.PRIME_AGENT_SESSION_DIR = sessions
    environment.PRIME_AGENT_CODING_AGENT_SESSION_DIR = sessions
  } else if (harness === 'loom') {
    environment.LOOM_SESSION_DIR = sessions
  } else {
    environment.PI_SESSION_DIR = sessions
    environment.PI_CODING_AGENT_SESSION_DIR = sessions
  }
  return { agentDir, environment: safeChildEnvironment(environment) }
}

export async function initializeRuntimeProfiles(directory: string, piExecutable: ExecutableSource, openExternal: (url: string) => Promise<void>, loomExecutable: ExecutableSource = null) {
  const prime = runtimeProfile(directory, 'prime')
  const pi = runtimeProfile(directory, 'pi')
  const loom = runtimeProfile(directory, 'loom')
  for (const profile of [prime, pi, loom]) {
    for (const path of [join(directory, 'runtime-profiles'), join(profile.agentDir, '..'), profile.agentDir]) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('应用运行配置目录不可用。')
      if (process.platform !== 'win32') await chmod(path, 0o700)
    }
  }
  const providers = new PrimeProviderService({ authPath: join(prime.agentDir, 'auth.json'), modelsPath: join(prime.agentDir, 'models.json'), isolated: true, openExternal })
  return { prime, pi, loom,
    providers,
    piProviders: new PrimeProviderService({ authPath: join(pi.agentDir, 'auth.json'), modelsPath: join(pi.agentDir, 'models.json'), isolated: true, openExternal }),
    piCatalog: new PiModelCatalogService(piExecutable, { environment: safeChildEnvironment(pi.environment) }),
    // Loom has no provider store of its own: it runs the OpenAI-compatible
    // models of the providers connected for Prime Work.
    loomCatalog: new LoomModelCatalogService(loomExecutable, { environment: safeChildEnvironment(loom.environment), agentDir: loom.agentDir, modelConfig: () => providers.loomModelConfig() }),
  }
}
