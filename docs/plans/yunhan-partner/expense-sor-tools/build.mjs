/**
 * 构建脚本：把 src/index.ts 打成单文件 lib/index.js（ESM）。
 *
 * 关键点：@deepseek-ai/dsh-tools 与 @deepseek-ai/schemastery 被【内联】进产物，
 * @deepseek-ai/cordis 只有 type import（编译期擦除）。因此产物运行时零依赖——
 * 部署时把整个包目录拷进员工端 profile 的 node_modules 即可，无需任何 npm install。
 *
 * 两种依赖来源（改 DEPS 预设）：
 *  - 'workspace'：开发机上有汉云 deepseek-harness 检出（默认，适合本机联调）；
 *  - 'registry' ：私有 registry 安装的 node_modules（真实实施场景，
 *                 `npm i @deepseek-ai/dsh-tools @deepseek-ai/schemastery -D` 后无 alias 自然解析）。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'

const DEPS = process.env.DEPS ?? 'workspace'
const WORKSPACE = 'D:/works/deepseek-harness'

/**
 * esbuild 导入：优先本包 devDependencies（真实实施场景）；
 * 开发机上本包没装依赖时，回退到汉云 workspace 的 pnpm store 里的 esbuild。
 */
async function loadEsbuild() {
  try {
    return await import('esbuild')
  } catch {
    const { readdir } = await import('node:fs/promises')
    const pnpmEsbuildDir = `${WORKSPACE}/node_modules/.pnpm`
    const candidates = (await readdir(pnpmEsbuildDir))
      .filter(name => name.startsWith('esbuild@'))
      .sort()
      .reverse()
    for (const candidate of candidates) {
      try {
        return await import(pathToFileURL(`${pnpmEsbuildDir}/${candidate}/node_modules/esbuild/lib/main.js`).href)
      } catch { /* try next */ }
    }
    throw new Error('esbuild 不可用：请在本包 npm i -D esbuild，或检查汉云 workspace 路径')
  }
}

const { build } = await loadEsbuild()

/** workspace 预设：直连汉云检出（vendor 的 schemastery / 已构建的 dsh-tools lib）。 */
const workspaceAlias = {
  '@deepseek-ai/schemastery': `${WORKSPACE}/vendor/schemastery/lib/index.cjs`,
  '@deepseek-ai/dsh-tools': `${WORKSPACE}/packages/core/tools/lib/index.js`,
}

await mkdir(fileURLToPath(new URL('./lib', import.meta.url)), { recursive: true })

const result = await build({
  entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./lib/index.js', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  sourcemap: false,
  ...(DEPS === 'workspace' ? { alias: workspaceAlias } : {}),
  // 运行时零外部依赖：cordis 仅类型导入不会出现在产物里；其余全内联
  external: [],
})

if (result.warnings.length > 0) {
  for (const warning of result.warnings) console.warn('esbuild warning:', warning.text)
}
console.log('built lib/index.js')
