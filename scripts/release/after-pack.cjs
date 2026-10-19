const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

function executablePath(context, platform = process.platform) {
  const { appOutDir, packager } = context
  const { productFilename } = packager.appInfo
  if (platform === 'darwin') return join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename)
  if (platform === 'win32') return join(appOutDir, `${productFilename}.exe`)
  // LinuxPackager exposes the final name after merging platform and global
  // configuration and applying electron-builder's filename sanitization.
  if (typeof packager.executableName !== 'string' || !packager.executableName) {
    throw new Error('Linux packager did not expose its final executable name')
  }
  return join(appOutDir, packager.executableName)
}

exports.executablePath = executablePath

exports.default = async function hardenElectron(context) {
  const expected = process.env.WEAVE_RUNTIME_RESOURCE_DIR
  const platform = process.env.WEAVE_RUNTIME_PLATFORM
  const arch = process.env.WEAVE_RUNTIME_ARCH
  if (!expected || !platform || !arch) throw new Error('Package through scripts/release/electron-builder.mjs to include the verified runtime.')
  const resources = platform === 'darwin' ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources') : join(context.appOutDir, 'resources')
  const result = spawnSync(
    process.execPath,
    [join(__dirname, '../runtime/verify.mjs'), `--platform=${platform}`, `--arch=${arch}`, `--root=${join(resources, 'runtime')}`, `--expected-manifest=${join(expected, 'runtime-manifest.json')}`],
    { stdio: 'inherit' },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Packaged runtime integrity verification failed.')
  await flipFuses(executablePath(context), {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: process.platform === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    // Remote browser credentials are session-only; app settings contain no login tokens.
    [FuseV1Options.EnableCookieEncryption]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true,
  })
}
