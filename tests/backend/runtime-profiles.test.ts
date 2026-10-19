import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeProfile, initializeRuntimeProfiles } from '../../electron/main/runtime-profiles'

const roots: string[] = []
const temporary = () => { const root = mkdtempSync(join(tmpdir(), 'weave-runtime-profile-')); roots.push(root); return root }
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('application-private runtime profiles', () => {
  it('isolates both agents without rewriting HOME, CODEX_HOME or the host environment', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'inherited-test-key')
    const root = temporary(), inherited = { ...process.env, HOME: '/user/home', CODEX_HOME: '/user/codex', npm_config_userconfig: '/shared/npmrc' }
    const pi = runtimeProfile(root, 'pi', inherited), prime = runtimeProfile(root, 'prime', inherited)
    expect(pi.environment.PI_CODING_AGENT_DIR).toBe(join(root, 'runtime-profiles', 'pi', 'agent'))
    expect(prime.environment.PRIME_AGENT_CODING_AGENT_DIR).toBe(join(root, 'runtime-profiles', 'prime', 'agent'))
    expect(prime.environment.WEAVE_DISABLE_SHARED_PRIME_AUTH).toBe('1')
    for (const profile of [pi, prime]) {
      expect(profile.environment.HOME).toBe('/user/home')
      expect(profile.environment.CODEX_HOME).toBe('/user/codex')
      expect(profile.environment.DEEPSEEK_API_KEY).toBeUndefined()
      expect(profile.environment.npm_config_userconfig).toBeUndefined()
      expect(profile.environment.NPM_CONFIG_USERCONFIG).toBe(join(profile.agentDir, 'npm-user.rc'))
      expect(profile.environment.NPM_CONFIG_GLOBALCONFIG).toBe(join(profile.agentDir, 'npm-global.rc'))
      expect(profile.environment.GOOGLE_APPLICATION_CREDENTIALS).toBe(join(profile.agentDir, 'google-credentials.json'))
      expect(profile.environment.AWS_SHARED_CREDENTIALS_FILE).toBe(join(profile.agentDir, 'aws-credentials'))
    }
    expect(process.env.DEEPSEEK_API_KEY).toBe('inherited-test-key')
  })
  it('provider writes remain under the app profile and do not import ambient credentials', async () => {
    vi.stubEnv('PI_OFFLINE', '1'); vi.stubEnv('DEEPSEEK_API_KEY', 'inherited-test-key')
    const root = temporary(), profiles = await initializeRuntimeProfiles(root, null, async () => undefined)
    const catalog = await profiles.providers.catalog(true)
    expect(catalog.providers.find(p => p.id === 'deepseek')?.configured).not.toBe(true)
    await profiles.providers.saveApiKey('deepseek', 'private-app-fixture-key')
    const configured = (await profiles.providers.catalog(true)).providers.find(p => p.id === 'deepseek')
    expect(configured?.configured).toBe(true)
    expect(configured?.availableModelCount).toBeGreaterThan(0)
    expect(readFileSync(join(profiles.prime.agentDir, 'auth.json'), 'utf8')).toContain('private-app-fixture-key')
    expect(readFileSync(join(profiles.prime.agentDir, 'auth.json'), 'utf8')).not.toContain('inherited-test-key')
    await profiles.piProviders.saveApiKey('deepseek', 'private-pi-fixture-key')
    expect(readFileSync(join(profiles.pi.agentDir, 'auth.json'), 'utf8')).toContain('private-pi-fixture-key')
    expect(readFileSync(join(profiles.pi.agentDir, 'auth.json'), 'utf8')).not.toContain('private-app-fixture-key')
    expect(readFileSync(join(profiles.prime.agentDir, 'auth.json'), 'utf8')).not.toContain('private-pi-fixture-key')
    await profiles.piProviders.logout('deepseek')
    expect(readFileSync(join(profiles.pi.agentDir, 'auth.json'), 'utf8')).not.toContain('private-pi-fixture-key')
    expect(readFileSync(join(profiles.prime.agentDir, 'auth.json'), 'utf8')).toContain('private-app-fixture-key')
  })
  it('the opt-in vendor guard never reads shared Prime config, while private auth still works and the default remains compatible', () => {
    const root = temporary(), shared = join(root, 'shared', 'config.json'), auth = join(root, 'app', 'auth.json')
    mkdirSync(join(root, 'shared')); mkdirSync(join(root, 'app'))
    writeFileSync(shared, JSON.stringify({ api_key: 'shared-fixture-key' })); writeFileSync(auth, '{}')
    const script = `
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const [shared, auth] = process.argv.slice(1); let reads = 0;
      const original = fs.readFileSync;
      fs.readFileSync = function(path, ...args) { if (String(path) === shared) reads++; return original.call(this, path, ...args) };
      syncBuiltinESMExports();
      const {AuthStorage} = await import('prime-agent/auth-storage');
      const store = AuthStorage.create(auth, {usePrimeCliConfig: true, primeCliConfigPath: shared});
      const key = await store.getApiKey('prime-inference');
      console.log(JSON.stringify({reads, shared: key === 'shared-fixture-key', private: key === 'private-fixture-key', missing: key === undefined}));
    `
    const probe = (enabled: boolean) => {
      const environment = runtimeProfile(root, 'prime').environment
      environment.WEAVE_DISABLE_SHARED_PRIME_AUTH = enabled ? '1' : undefined
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, shared, auth], { env: environment, encoding: 'utf8', timeout: 10_000 })
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    expect(probe(true)).toEqual({ reads: 0, shared: false, private: false, missing: true })
    expect(probe(false)).toMatchObject({ shared: true, missing: false })
    writeFileSync(auth, JSON.stringify({ 'prime-inference': { type: 'api_key', key: 'private-fixture-key' } }))
    expect(probe(true)).toEqual({ reads: 0, shared: false, private: true, missing: false })
    expect(JSON.parse(readFileSync(shared, 'utf8'))).toEqual({ api_key: 'shared-fixture-key' })
  })
})
