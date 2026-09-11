/**
 * Enterprise skill distribution channel (skill-repo-design §4/§6.2/§7).
 *
 * The employee-side DSH keeps enterprise skills in a dedicated cache root
 * (`$DSH_HOME/skill-sync/skills`), fed by a periodic daemon: it calls
 * flowable-engine `GET /dsh/skills/required` with the signed-in employee's
 * Supabase JWT (`ctx.currentUser.getToken()`), diffs the required list against
 * the local install state, downloads missing or stale skills from SkillHub
 * (namespace list → zip download → fingerprint check), and registers a
 * filesystem skill provider over the cache root so `ctx.skills` serves the
 * installed entries. Failures are logged and retried on the next tick;
 * nothing here blocks employee startup (skill-repo-design §6.2 降级).
 *
 * For opening a todo (work item 3) the plugin also serves
 * `POST /api/enterprise/skills/ensure`: the web UI posts the task's
 * `dshMeta.skillRefs` before creating the session and receives the names
 * still missing after an immediate sync round, driving the degraded-continue
 * notice instead of blocking the session (skill-repo-design §7).
 *
 * @module @deepseek-ai/dsh-skill-sync
 */

import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { unzipSync } from 'fflate'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-platform-user'
import type {} from '@deepseek-ai/dsh-user-identity-context'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-sync'

/** 等待 skill 注册表、登录身份存储与本地 webserver 就绪后才挂载。 */
export const inject = ['skills', 'currentUser', 'webServer'] as const

/** daemon 默认扫描间隔:10 分钟(skill-repo-design §6.2)。 */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000

/** SkillHub 命名空间清单单页上限(服务端 CLI 端点上限 100)。 */
const SKILLHUB_PAGE_LIMIT = 100

/** 插件配置,全部来自 enterprise profile 的 cordis.yml config 段。 */
export interface Config {
  /** flowable-engine 基地址(协议+主机+端口,无路径)。 */
  flowableBaseUrl: string
  /** SkillHub 后端 API 基地址(协议+主机+端口,无路径)。 */
  skillhubBaseUrl: string
  /** SkillHub 只读分发 token;空串时跳过清单/下载(仅靠已装缓存)。 */
  skillhubToken: string
  /** daemon 扫描间隔毫秒。 */
  intervalMs: number
  /** 覆盖缓存目录;缺省用 `$DSH_HOME/skill-sync/skills`。 */
  skillDir?: string
}

export const Config: z<Config> = z.object({
  flowableBaseUrl: z.string().default('http://127.0.0.1:8090'),
  skillhubBaseUrl: z.string().default('http://127.0.0.1:8095'),
  skillhubToken: z.string().default(''),
  intervalMs: z.number().default(DEFAULT_INTERVAL_MS),
  skillDir: z.string(),
})

/** `/dsh/skills/required` 的单条清单项。 */
export interface RequiredSkill {
  /** skill 裸名(dsh:skillRef 值)。 */
  name: string
  /** 所属 SkillHub 命名空间;流程定义无法映射应用时缺省。 */
  namespace?: string
}

/** 本地安装状态:skill 名 → 溯源(fingerprint 用于增量升级检测)。 */
interface SkillSyncState {
  skills: Record<string, { namespace: string; fingerprint: string }>
}

/** SkillHub 命名空间清单的单个 skill 条目(CliNamespaceSyncItemResponse)。 */
interface SkillHubItem {
  slug: string
  fingerprint: string
  downloadUrl: string
}

/** 已解析的运行选项(apply 阶段完成校验与默认值合并)。 */
export interface SkillSyncOptions {
  flowableBaseUrl: string
  skillhubBaseUrl: string
  skillhubToken: string
  skillDir: string
}

/**
 * 员工端 skill 分发服务:周期同步 + 即时安装入口(工作项 3 的对接面)。
 *
 * <p>daemon 只在有人登录时干活:未登录(token 缺失)或 token 过期(401)的
 * 一轮直接跳过,下轮重试;单 skill 下载失败记 warn 不中断同轮其他 skill。
 */
export class SkillSyncService extends Service {
  private readonly options: SkillSyncOptions
  private readonly control: () => SkillProviderControl | undefined
  /** 进行中的一轮同步;并发调用合并等待同一轮(端点触发/登录触发/daemon 可同时到达)。 */
  private syncGate: Promise<void> | undefined

  /** @param ctx - 携带 `currentUser` 的 Cordis 上下文。 */
  constructor(
    ctx: Context,
    options: SkillSyncOptions,
    control: () => SkillProviderControl | undefined,
  ) {
    super(ctx, 'skillSync')
    this.options = options
    this.control = control
  }

  /**
   * 启动服务:缓存目录不存在时创建,随后立即跑一轮同步(不等第一个 interval)。
   * 本服务由 apply() 内普通构造挂载(非 class 插件),cordis 不会自动调用
   * `[Service.init]`,故由 apply 显式调用本方法。
   */
  async start(): Promise<void> {
    await mkdir(this.options.skillDir, { recursive: true })
    await mkdir(dirname(this.statePath), { recursive: true })
    void this.sync().catch(error => this.ctx.logger.warn('skill-sync 首轮同步失败', error))
  }

  private get statePath(): string {
    return join(dirname(this.options.skillDir), 'state.json')
  }

  /**
   * 执行一轮同步:拉取当前用户所需清单,下载缺失/过期的 skill 到缓存目录,
   * 有安装动作后失效 skill 注册表缓存。错误记日志不上抛(daemon 语义)。
   * 已有一轮在跑时合并等待,不重复出站。
   */
  async sync(): Promise<void> {
    if (this.syncGate !== undefined) {
      await this.syncGate
      return
    }
    this.syncGate = this.runSync()
    try {
      await this.syncGate
    } finally {
      this.syncGate = undefined
    }
  }

  private async runSync(): Promise<void> {
    const token = this.ctx.currentUser.getToken()
    if (token === undefined) {
      this.ctx.logger.info('skill-sync: 未登录,本轮跳过')
      return
    }
    let required: readonly RequiredSkill[]
    try {
      required = await this.fetchRequired(token)
    } catch (error) {
      this.ctx.logger.warn('skill-sync: 拉取所需 skill 清单失败', error)
      return
    }
    const state = await this.readState()
    let changed = false
    const installedNames: string[] = []
    // 同一 namespace 的清单只拉一次;按 namespace 分组处理
    const manifests = new Map<string, Map<string, SkillHubItem>>()
    for (const skill of required) {
      if (skill.namespace === undefined || skill.namespace === '') {
        this.ctx.logger.warn(`skill-sync: skill '${skill.name}' 无 namespace,跳过`)
        continue
      }
      let manifest = manifests.get(skill.namespace)
      if (manifest === undefined) {
        try {
          manifest = await this.fetchManifest(skill.namespace)
        } catch (error) {
          this.ctx.logger.warn(`skill-sync: 拉取 SkillHub 命名空间 '${skill.namespace}' 清单失败`, error)
          manifests.set(skill.namespace, new Map())
          continue
        }
        manifests.set(skill.namespace, manifest)
      }
      const item = manifest.get(skill.name)
      if (item === undefined) {
        this.ctx.logger.warn(`skill-sync: skill '${skill.name}' 不在命名空间 '${skill.namespace}' 已发布清单中`)
        continue
      }
      const installed = state.skills[skill.name]
      const skillDir = join(this.options.skillDir, skill.name)
      if (installed !== undefined && installed.fingerprint === item.fingerprint
        && await isDirectory(skillDir)) {
        continue
      }
      try {
        await this.install(skill.name, item)
        state.skills[skill.name] = { namespace: skill.namespace, fingerprint: item.fingerprint }
        changed = true
        installedNames.push(skill.name)
      } catch (error) {
        this.ctx.logger.warn(`skill-sync: 安装 skill '${skill.name}' 失败`, error)
      }
    }
    if (changed) {
      await writeFile(this.statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
      this.control()?.invalidate()
    }
    this.ctx.logger.info(
      `skill-sync: 本轮所需 ${required.length} 个 skill,安装/更新 ${installedNames.length} 个`
        + (installedNames.length > 0 ? `: ${installedNames.join(', ')}` : ''),
    )
  }

  /**
   * 确保指定 skill 已安装;缺失时立即执行一轮同步再复查。
   *
   * @param names - 需要就绪的 skill 裸名(待办 dshMeta.skillRefs)。
   * @returns 仍缺失的 skill 名(同步后依旧不可用,调用方走降级提示)。
   */
  async ensureInstalled(names: readonly string[]): Promise<readonly string[]> {
    const missing = async (list: readonly string[]): Promise<readonly string[]> => {
      const absent: string[] = []
      for (const name of list) {
        if (!(await isDirectory(join(this.options.skillDir, name)))) absent.push(name)
      }
      return absent
    }
    const before = await missing(names)
    if (before.length === 0) return []
    // 同步失败不阻断:已装 skill 依旧可用,缺失项进入返回值走降级提示
    await this.sync().catch(error => this.ctx.logger.warn('skill-sync: ensure 触发的同步失败', error))
    return await missing(names)
  }

  /**
   * 拉取当前登录用户「现在 + 将来」需要的 skill 清单。
   * @param token - 当前登录员工的 Supabase JWT(currentUser.getToken())。
   * @returns 清单条目;401 视为未登录抛错由调用方跳过本轮。
   */
  private async fetchRequired(token: string): Promise<readonly RequiredSkill[]> {
    const response = await fetch(`${this.options.flowableBaseUrl}/dsh/skills/required`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (response.status === 401) {
      throw new Error('登录 token 已过期或无效')
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      throw new Error(`flowable-engine 返回 ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    const body = await response.json() as { skills?: RequiredSkill[] }
    return body.skills ?? []
  }

  /**
   * 拉取 SkillHub 命名空间的已发布 skill 清单(翻页取全量)。
   * @returns slug → 清单条目的索引。
   */
  private async fetchManifest(namespace: string): Promise<Map<string, SkillHubItem>> {
    const index = new Map<string, SkillHubItem>()
    let cursor: string | undefined = '0'
    while (cursor !== undefined && cursor !== '') {
      const response = await fetch(
        `${this.options.skillhubBaseUrl}/api/cli/v1/namespaces/${encodeURIComponent(namespace)}/skills`
          + `?cursor=${encodeURIComponent(cursor)}&limit=${SKILLHUB_PAGE_LIMIT}`,
        { headers: { authorization: `Bearer ${this.options.skillhubToken}` } },
      )
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500)
        throw new Error(`SkillHub 命名空间清单返回 ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      const body = await response.json() as {
        code?: number
        data?: { items?: SkillHubItem[]; nextCursor?: string | null }
      }
      if (body.code !== 0 || body.data === undefined) {
        throw new Error(`SkillHub 响应信封异常: code=${body.code ?? 'missing'}`)
      }
      for (const item of body.data.items ?? []) {
        index.set(item.slug, item)
      }
      cursor = body.data.nextCursor ?? undefined
    }
    return index
  }

  /**
   * 下载并安装单个 skill 包:zip 根即 SKILL.md(SkillHub 打包已剥外层目录),
   * 解压到临时目录后原子改名到 `<skillDir>/<name>`。
   */
  private async install(name: string, item: SkillHubItem): Promise<void> {
    const downloadUrl = new URL(item.downloadUrl, `${this.options.skillhubBaseUrl}/`)
    const response = await fetch(downloadUrl, {
      headers: { authorization: `Bearer ${this.options.skillhubToken}` },
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      throw new Error(`下载 skill 包返回 ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()))
    const tempDir = await mkdtemp(join(this.options.skillDir, `.tmp-${name}-`))
    try {
      for (const [entryPath, content] of Object.entries(entries)) {
        if (entryPath === '' || entryPath.endsWith('/')) continue
        const target = safeJoin(tempDir, entryPath)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content)
      }
      const dest = join(this.options.skillDir, name)
      await rm(dest, { recursive: true, force: true })
      await rename(tempDir, dest)
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true })
      throw error
    }
  }

  /** 读取本地安装状态;文件缺失/损坏视为空状态(全部重装)。 */
  private async readState(): Promise<SkillSyncState> {
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8')) as SkillSyncState
    } catch {
      return { skills: {} }
    }
  }
}

/** 目标是否为已存在的目录。 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 把 zip 条目名安全映射到解压根目录下;绝对路径或 `..` 段(zip 炸弹/路径
 * 穿越特征)抛错拒绝整个安装。
 */
function safeJoin(root: string, entryPath: string): string {
  const normalized = entryPath.replaceAll('\\', '/')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`zip 条目路径不安全: ${entryPath}`)
  }
  return join(root, normalized)
}

/** 即时安装端点的前缀(与 /api/enterprise/auth 平行的 enterprise 命名区)。 */
const SKILL_ROUTE_PREFIX = '/api/enterprise/skills'

/** skill 裸名值域:拒绝路径分隔符与穿越段(names 直接拼缓存目录路径)。 */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** JSON 响应辅助函数。 */
function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

/** 读取并解析请求体 JSON;坏 JSON 抛错由调用方映射 400。 */
function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('error', reject)
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

/**
 * 即时安装端点分发:`POST /api/enterprise/skills/ensure`,请求体
 * `{ names: string[] }`,响应 `{ missing: string[] }`(同步后仍不可用的
 * skill 裸名,调用方走降级提示)。names 元素超出 skill 裸名值域时 400。
 */
async function dispatchEnsure(
  service: SkillSyncService,
  method: string,
  urlPath: string,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const segments = urlPath.slice(SKILL_ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '')
  if (method !== 'POST' || segments !== 'ensure') {
    sendJson(res, 404, { error: `no route for ${method} ${urlPath}` })
    return
  }
  let names: readonly string[]
  try {
    const parsed = await readJsonBody(req) as { names?: unknown }
    if (!Array.isArray(parsed.names)
      || parsed.names.some(name => typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name))) {
      throw new Error('names 必须为 skill 裸名数组(每项匹配 [A-Za-z0-9][A-Za-z0-9._-]*)')
    }
    names = parsed.names
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    return
  }
  const missing = await service.ensureInstalled(names)
  sendJson(res, 200, { missing })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Enterprise skill distribution: periodic sync plus on-demand install. */
    skillSync: SkillSyncService
  }
}

/**
 * 挂载 skill-sync:缓存目录上的 filesystem provider 注册进 `ctx.skills`
 * (不含默认根,不 watch——安装后由本插件主动 invalidate),`ctx.skillSync`
 * 服务提供周期同步与即时安装;daemon 定时器随上下文销毁清理。
 *
 * @param ctx - 携带 `skills` 与 `currentUser` 的 Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const flowableBaseUrl = config.flowableBaseUrl.replace(/\/+$/, '')
  const skillhubBaseUrl = config.skillhubBaseUrl.replace(/\/+$/, '')
  const skillDir = config.skillDir !== undefined && config.skillDir !== ''
    ? config.skillDir
    : dshHomePath('skill-sync', 'skills')
  new URL(flowableBaseUrl)
  new URL(skillhubBaseUrl)
  if (!Number.isFinite(config.intervalMs) || config.intervalMs <= 0) {
    throw new Error(`skill-sync: intervalMs 必须为正有限数,得到 ${config.intervalMs}`)
  }
  let providerControl: SkillProviderControl | undefined
  let provider: FileSystemSkillProvider | undefined
  ctx.effect(
    () => ctx.skills.registerProvider((control) => {
      providerControl = control
      provider = new FileSystemSkillProvider(ctx, control, {
        providerName: 'skill-sync',
        includeDefaultRoots: false,
        customSkillDirs: [skillDir],
        watch: false,
      })
      return provider
    }),
    'skill-sync: cache-root skill provider',
  )
  ctx.effect(() => () => { void provider?.dispose() }, 'skill-sync: provider disposal')
  const service = new SkillSyncService(
    ctx,
    { flowableBaseUrl, skillhubBaseUrl, skillhubToken: config.skillhubToken, skillDir },
    () => providerControl,
  )
  // mkdir 失败(如 DSH_HOME 只读)不阻塞员工端启动,记日志后每轮 interval 重试
  void service.start().catch(error => ctx.logger.warn('skill-sync 启动失败', error))
  const timer = setInterval(() => {
    void service.sync().catch(error => ctx.logger.warn('skill-sync 周期同步异常', error))
  }, config.intervalMs)
  ctx.effect(() => () => { clearInterval(timer) }, 'skill-sync: daemon interval')
  // 登录即触发一轮同步:启动首轮通常发生在登录前,不让用户等下一个 interval
  ctx.on('platform-user/verified', () => {
    void service.sync().catch(error => ctx.logger.warn('skill-sync 登录触发同步异常', error))
  }, { global: true })
  // 即时安装端点(工作项 3):待办打开时前端先调 ensure 再建会话
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: SKILL_ROUTE_PREFIX,
      handler: (req, res) => {
        const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
        dispatchEnsure(service, req.method ?? 'GET', urlPath, req, res)
          .catch((error) => {
            ctx.logger.warn('skill-sync: ensure 端点异常', error)
            if (!res.headersSent) {
              sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          })
      },
    }),
  'skill-sync: /api/enterprise/skills prefix route',
  )
}
