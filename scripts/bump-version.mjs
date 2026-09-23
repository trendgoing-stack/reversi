/**
 * バージョンを上げる（sw.js と js/version.js の両方を書き換える）。
 * あわせて、sw.js のキャッシュ対象（ASSETS）に漏れや存在しないファイルがないか確認する。
 *   node scripts/bump-version.mjs 1.1.0   … バージョンを変更して確認
 *   node scripts/bump-version.mjs         … 確認だけ
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SW = join(ROOT, 'sw.js')
const VERSION_JS = join(ROOT, 'js', 'version.js')

const next = process.argv[2]
if (next) {
  if (!/^\d+\.\d+\.\d+$/.test(next)) {
    console.error('バージョンは 1.2.3 の形で指定してください')
    process.exit(1)
  }
  writeFileSync(
    SW,
    readFileSync(SW, 'utf8').replace(/const VERSION = '[^']*'/, `const VERSION = '${next}'`),
  )
  writeFileSync(
    VERSION_JS,
    readFileSync(VERSION_JS, 'utf8').replace(/APP_VERSION = '[^']*'/, `APP_VERSION = '${next}'`),
  )
  console.log(`バージョンを ${next} にしました`)
}

const sw = readFileSync(SW, 'utf8')
const swVersion = sw.match(/const VERSION = '([^']*)'/)?.[1]
const appVersion = readFileSync(VERSION_JS, 'utf8').match(/APP_VERSION = '([^']*)'/)?.[1]
let ok = true
if (swVersion !== appVersion) {
  console.error(`sw.js (${swVersion}) と js/version.js (${appVersion}) のバージョンが違います`)
  ok = false
}

const listed = new Set([...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean))

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [relative(ROOT, path).replaceAll('\\', '/')]
  })
}
const required = [
  'index.html',
  'manifest.webmanifest',
  ...walk(join(ROOT, 'css')),
  ...walk(join(ROOT, 'js')),
  ...walk(join(ROOT, 'icons')).filter((p) => p.endsWith('.png')),
]
for (const path of required) {
  if (!listed.has(path)) {
    console.error(`sw.js の ASSETS に入っていません: ./${path}`)
    ok = false
  }
}
for (const path of listed) {
  if (!existsSync(join(ROOT, path))) {
    console.error(`sw.js の ASSETS にあるファイルが存在しません: ./${path}`)
    ok = false
  }
}

if (!ok) process.exit(1)
console.log(`OK: バージョン ${swVersion}、キャッシュ対象 ${listed.size + 1} 件`)
