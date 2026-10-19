#!/usr/bin/env node
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { assertSupportedToolchain, runCommand, validateReleaseCredentials, validateWindowsReleaseCredentials, withoutReleaseCredentials } from './lib.mjs'

const args = new Set(process.argv.slice(2))
const isPublic = args.has('--public')
const isQa = args.has('--qa')
const dryRun = args.has('--dry-run')
// CI release jobs pass --skip-verify because the CI workflow has already run
// the identical typecheck/lint/test suite on the same commit; the release job
// then only builds the bundle, packages, and runs post-package verification.
const skipVerify = args.has('--skip-verify')
const platformIndex = process.argv.indexOf('--platform')
const platform = platformIndex === -1 ? undefined : process.argv[platformIndex + 1]
const archIndex = process.argv.indexOf('--arch')
const outputIndex = process.argv.indexOf('--output-directory')
const platformHosts = { mac: 'darwin', linux: 'linux', win: 'win32' }
const nativeArchitectures = { arm64: 'arm64', x64: 'x64' }
if (isPublic === isQa) {
  console.error('Choose exactly one release mode: --public or --qa')
  process.exit(2)
}
if (!platform || !(platform in platformHosts)) {
  console.error('Choose a supported platform: --platform mac, linux, or win')
  process.exit(2)
}
// An explicit --arch is authoritative; only its absence falls back to the
// build machine's architecture, so a malformed flag fails instead of silently
// packaging the host arch.
const defaultArch = process.arch === 'arm64' ? 'arm64' : 'x64'
const arch = archIndex === -1 ? defaultArch : process.argv[archIndex + 1]
if (!arch || !(arch in nativeArchitectures)) {
  console.error('Choose a supported architecture: --arch arm64 or x64')
  process.exit(2)
}

function run(command, commandArgs, env = process.env) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`)
  if (dryRun) return
  runCommand(command, commandArgs, { env })
}

try {
  assertSupportedToolchain()
  if (outputIndex !== -1 && platform !== 'mac') throw new Error('--output-directory currently supports macOS packaging only')
  const releaseRoot = resolve('release')
  const output = outputIndex === -1 ? resolve('release', platform, arch) : resolve(process.argv[outputIndex + 1] ?? '')
  const outputRelative = relative(releaseRoot, output)
  if (!outputRelative || outputRelative === '..' || outputRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(outputRelative))
    throw new Error('Output directory must be inside release/')
  if (outputIndex !== -1 && (!process.argv[outputIndex + 1] || process.argv[outputIndex + 1].startsWith('--'))) throw new Error('--output-directory requires a directory inside release/')
  if (outputIndex !== -1 && existsSync(output)) throw new Error('Requested output directory already exists; existing QA artifacts are preserved')
  if (process.platform !== platformHosts[platform]) throw new Error(`${platform} packaging must run natively on ${platformHosts[platform]}`)
  // Distribution packages always carry the Loom kernel; only CI and local QA
  // builds without access to its source may leave it out.
  if (isPublic && process.env.GOOEYPI_RUNTIME_WITHOUT_LOOM === '1') throw new Error('Public packages must bundle Loom; unset GOOEYPI_RUNTIME_WITHOUT_LOOM.')
  if (isPublic && platform === 'mac') validateReleaseCredentials(process.env)
  if (isPublic && platform === 'win') validateWindowsReleaseCredentials(process.env)
  const verifyScript = skipVerify ? 'build:bundle' : platform === 'mac' ? 'release:verify' : 'release:verify:package'
  run('npm', ['run', verifyScript], withoutReleaseCredentials(process.env))
  if (!dryRun && outputIndex === -1) rmSync(output, { recursive: true, force: true })

  const builderArgs = [`--${platform}`, `--${arch}`, '--publish', 'never', `--config.directories.output=${output}`]
  if (isPublic && platform === 'win') builderArgs.push('--config.forceCodeSigning=true')
  const builderEnv = isQa ? { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } : process.env
  if (isQa && platform === 'mac') builderArgs.push('--config.mac.identity=null', '--config.mac.notarize=false')
  run('node', ['scripts/release/electron-builder.mjs', ...builderArgs], builderEnv)
  if (platform === 'win' && !dryRun) {
    const outputDirectory = output
    const appx = readdirSync(outputDirectory).find((name) => name.endsWith('.appx'))
    if (!appx) throw new Error('Windows AppX/MSIX package was not produced')
    copyFileSync(resolve(outputDirectory, appx), resolve(outputDirectory, appx.replace(/\.appx$/, '.msix')))
  }
  if (platform === 'mac') {
    run(
      'node',
      ['scripts/release/verify-package.mjs', '--mode', isPublic ? 'public' : 'qa', '--arch', arch, '--release-directory', output],
      withoutReleaseCredentials(process.env, ['RELEASE_SIGNING_TEAM_ID']),
    )
  } else {
    run('node', ['scripts/release/verify-cross-platform-package.mjs', '--platform', platform, '--arch', arch, '--mode', isPublic ? 'public' : 'qa'], withoutReleaseCredentials(process.env))
  }
  if (dryRun) console.log('\nDRY RUN — nothing executed.')
  else console.log(`\n${isPublic ? 'Distribution' : 'Local QA'} ${platform}/${arch} package pipeline passed.`)
} catch (error) {
  console.error(`\nPackaging failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
