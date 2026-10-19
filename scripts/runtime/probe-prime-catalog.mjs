import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Use the same public subpath exports as PrimeProviderService. Prime's RPC
// mode starts a persistent daemon; model discovery in this app uses its SDK.
const packageRoot = path.resolve(process.argv[2])
const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'))
async function publicExport(name) {
  const entry = pkg.exports?.[name]?.import
  if (typeof entry !== 'string' || !entry.startsWith('./dist/') || entry.includes('..')) throw new Error('Unexpected Prime public export')
  return import(pathToFileURL(path.join(packageRoot, entry)).href)
}
const { AuthStorage } = await publicExport('./auth-storage')
const { ModelRegistry } = await publicExport('./model-registry')
const privateDir = process.env.PRIME_AGENT_CODING_AGENT_DIR
if (!privateDir) throw new Error('Private Prime profile is required')
const auth = AuthStorage.create(path.join(privateDir, 'auth.json'), { usePrimeCliConfig: false })
const registry = ModelRegistry.create(auth, path.join(privateDir, 'models.json'))
const all = registry.getAll()
const available = registry.getAvailable()
if (!Array.isArray(all) || !Array.isArray(available) || all.length === 0 || available.length !== 0) throw new Error('Unexpected empty-profile Prime catalog')
console.log(JSON.stringify({ mode: 'public-sdk', models: all.length, available: available.length }))
