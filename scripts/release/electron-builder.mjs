#!/usr/bin/env node
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function runtimeTarget(args, host = process.platform, architecture = process.arch) {
  const platforms = [
    ['--mac', 'darwin'],
    ['--linux', 'linux'],
    ['--win', 'win32'],
  ].filter(([flag]) => args.includes(flag))
  const arches = ['arm64', 'x64'].filter((arch) => args.includes(`--${arch}`))
  if (platforms.length > 1 || arches.length > 1) throw new Error('Package one platform and architecture at a time.')
  const platform = platforms[0]?.[1] ?? host
  const arch = arches[0] ?? architecture
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported bundled runtime target.')
  return { platform, arch, root: resolve('.build', 'runtime', `${platform}-${arch}`) }
}

function prepareRuntime(target) {
  for (const script of ['prepare', 'verify']) {
    const args = [`scripts/runtime/${script}.mjs`, `--platform=${target.platform}`, `--arch=${target.arch}`]
    if (script === 'verify' && target.platform === process.platform && target.arch === process.arch) args.push('--execute')
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Bundled runtime ${script} failed; packaging stopped.`)
  }
  // electron-builder expands env macros after resolving extraResources.from.
  // Keep this value project-relative so the project path is not prefixed twice.
  process.env.WEAVE_RUNTIME_RESOURCE_DIR = relative(process.cwd(), target.root)
  process.env.WEAVE_RUNTIME_PLATFORM = target.platform
  process.env.WEAVE_RUNTIME_ARCH = target.arch
}

/**
 * Select electron-builder's bundled filesystem collector in this process.
 * The npm collector can omit duplicate transitive references with npm 12 and
 * shared node_modules. We do not edit the installed library or dependencies.
 * This explicit adapter fails closed if the pinned builder API changes.
 */
export function selectTraversalCollector(factory) {
  if (typeof factory?.getCollectorByPackageManager !== 'function' || factory.PM?.TRAVERSAL !== 'traversal') {
    throw new Error('electron-builder traversal collector API is unavailable; packaging cannot safely collect runtime dependencies')
  }
  const original = factory.getCollectorByPackageManager
  factory.getCollectorByPackageManager = (_manager, root, temporary) => original(factory.PM.TRAVERSAL, root, temporary)
}

if (!process.argv[1] || import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareRuntime(runtimeTarget(process.argv.slice(2)))
  const require = createRequire(import.meta.url)
  selectTraversalCollector(require('app-builder-lib/out/node-module-collector/index.js'))
  console.log("Packaging uses electron-builder's built-in traversal collector; installed dependencies remain unchanged.")
  await import(pathToFileURL(require.resolve('electron-builder/cli.js')).href)
}
