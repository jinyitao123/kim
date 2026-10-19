import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { extractAll, extractFile } from '@electron/asar'

const require = createRequire(import.meta.url)

/** Real imports catch absent transitive dependencies that archive layout checks cannot detect. */
export function startupRuntimeModules(mainSource) {
  const modules = [...mainSource.matchAll(/^\s*import\s+[^;\n]+?\s+from\s*["']([A-Za-z@][A-Za-z0-9:@._/-]*)["']/gm)].map((match) => match[1])
  return [...new Set(modules.filter((name) => name !== 'electron' && !name.startsWith('node:') && !name.startsWith('.')))].sort()
}

export function verifyRuntimeModules({ asar, electronExecutable = require('electron'), modules = startupRuntimeModules(extractFile(asar, 'out/main/index.js').toString()) }) {
  if (!modules.length) throw new Error('Packaged main contains no recognizable runtime imports')
  const temporary = mkdtempSync(join(tmpdir(), 'weave-package-closure-'))
  try {
    // Extract the exact archive outside the repository, including its native
    // unpack entries. Parent node_modules cannot mask omissions, and ESM
    // imports retain their normal package "import" export conditions.
    const isolated = join(temporary, 'payload'),
      resultPath = join(temporary, 'result.json')
    extractAll(asar, isolated)
    const probe = join(isolated, 'probe.mjs')
    writeFileSync(
      probe,
      `import {app} from 'electron';import fs from 'node:fs';const modules=${JSON.stringify(modules)};
app.whenReady().then(async()=>{const loaded=[];try{for(const name of modules){await import(name);loaded.push(name)}fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({status:'loaded',loaded}));app.exit(0)}catch(error){fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({status:'failed',loaded,code:error.code,message:error.message}));app.exit(1)}});`,
    )
    const environment = Object.fromEntries(
      ['PATH', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING', 'DISPLAY', 'XAUTHORITY']
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    )
    const child = spawnSync(electronExecutable, [probe, `--user-data-dir=${join(temporary, 'user-data')}`], { cwd: isolated, env: environment, timeout: 20_000, encoding: 'utf8' })
    const receipt = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : undefined
    if (child.error || child.status !== 0 || receipt?.status !== 'loaded' || receipt.loaded.length !== modules.length) {
      throw new Error(`Isolated packaged runtime import failed: ${receipt?.message ?? child.error?.message ?? child.stderr.slice(0, 2000) ?? 'no receipt'}`)
    }
    console.log(`Isolated Electron/ASAR runtime imports passed: ${receipt.loaded.join(', ')}`)
    return receipt.loaded
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
