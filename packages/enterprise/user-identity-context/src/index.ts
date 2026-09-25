/**
 * Enterprise session-identity context: `ctx.currentUser` remembers the latest
 * verified platform user, and the first step of every turn injects a
 * model-visible identity block (identity + org positions) so the assistant
 * knows who it is serving and where that person sits in the org tree. The
 * block also carries the current verified access token so the assistant can
 * call enterprise internal systems (Supabase SSO, bearer auth) as the signed-in
 * employee; identity fields stay display-only.
 *
 * The store is fed by the `platform-user/verified` and `platform-user/signout`
 * events that `platform-user-api` emits on its auth touchpoints, so the two
 * packages stay decoupled: without this plugin the events emit into the void.
 *
 * Org positions (design 2026-09-19 §6.4) are fetched from the web-console
 * runtime API with the verified token at injection time and cached per token;
 * a fetch failure degrades to a positions-free identity block (warn, retry on
 * the next turn) so the org dimension never blocks identity injection.
 *
 * @module @deepseek-ai/dsh-user-identity-context
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { PlatformUser } from '@deepseek-ai/dsh-platform-user'
import { fetchOrgPositions } from './positions.ts'
import { type OrgPosition, renderIdentityText } from './text.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'user-identity-context'

/** Service that must be available before the identity listener mounts. */
export const inject = ['agents'] as const

/** 插件配置:web-console 基地址(组织身份清单拉取目标)。 */
export interface Config {
  /** web-console 基地址(协议+主机+端口,无路径)。 */
  webConsoleBaseUrl: string
}

export const Config: z<Config> = z.object({
  webConsoleBaseUrl: z.string().default('http://127.0.0.1:8080'),
})

/** This package's message-source kind: the identity block's package ownership in the durable log. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'user-identity-context': { kind: 'user-identity-context' } & ContextFormed
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Latest verified platform user on this DSH instance; undefined before the first verified request. */
    currentUser: CurrentUserService
  }
}

/**
 * In-process store of the latest verified platform user. The
 * `platform-user/verified` event (emitted on every verified
 * `GET /api/enterprise/auth/me`) feeds {@link CurrentUserService.observe};
 * `platform-user/signout` feeds {@link CurrentUserService.clear}; the identity
 * context listener reads the store at each turn's first step. State lives in
 * memory only: a restarted webserver learns the identity at the client's next
 * `/me` call, and a token expiring mid-session leaves the last verified
 * identity in place until the next touchpoint (a same-human staleness window is
 * benign). The raw access token is kept next to the identity with two
 * consumers: enterprise background services (skill-sync) call server-side APIs
 * as the signed-in employee, and the identity block renders it so the assistant
 * can call enterprise internal systems (Supabase SSO bearer auth) as that
 * employee.
 */
export class CurrentUserService extends Service {
  private user: PlatformUser | undefined
  private accessToken: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'currentUser')
  }

  /**
   * Record one verified platform user as the current identity.
   * @param user - platform user resolved from a JWT-verified access token.
   * @param accessToken - the verified bearer token; omitted keeps any previous
   * token (callers that re-verify only the user).
   */
  observe(user: PlatformUser, accessToken?: string): void {
    this.user = user
    if (accessToken !== undefined) this.accessToken = accessToken
  }

  /** Forget the current identity (employee signed out). */
  clear(): void {
    this.user = undefined
    this.accessToken = undefined
  }

  /** @returns the latest verified identity, or undefined when nobody is logged in. */
  get(): PlatformUser | undefined {
    return this.user
  }

  /**
   * @returns the latest verified bearer token, or undefined when nobody has
   * signed in; may be stale after token expiry — callers treat a 401 as
   * "signed out" and retry after the next verified `/me`.
   */
  getToken(): string | undefined {
    return this.accessToken
  }
}

/** 组织身份缓存 TTL:调动岗位/新设部门后最迟 5 分钟对齐。 */
const POSITIONS_TTL_MILLIS = 5 * 60_000

/**
 * Mount the current-user store and register the identity-injection listener.
 * Injection happens at step 1 of every turn: one deterministic block per turn
 * keeps the identity fresh in context without per-step duplicates, and the
 * store being empty (no verified login yet) injects nothing.
 *
 * <p>webConsoleBaseUrl 在注册前解析一次,格式非法立即失败(misconfiguration
 * fails loud),否则表现为每次注入一条难排查的 fetch 错误。
 *
 * @param ctx - plugin context; the listener and store are disposed with it.
 * @param config - 插件配置,提供 web-console 基地址。
 */
export function apply(ctx: Context, config: Config): void {
  const webConsoleBaseUrl = config.webConsoleBaseUrl.replace(/\/+$/, '')
  new URL(webConsoleBaseUrl)
  new CurrentUserService(ctx)

  /** 单条组织身份缓存(按 token 失效;失败不缓存,下一轮重试)。 */
  let positionsCache: { token: string; expiresAt: number; positions: OrgPosition[] } | undefined

  const loadPositions = async (token: string): Promise<OrgPosition[]> => {
    const now = Date.now()
    if (positionsCache !== undefined && positionsCache.token === token
      && positionsCache.expiresAt > now) {
      return positionsCache.positions
    }
    try {
      const positions = await fetchOrgPositions(webConsoleBaseUrl, token)
      positionsCache = { token, expiresAt: now + POSITIONS_TTL_MILLIS, positions }
      return positions
    } catch (error) {
      ctx.logger.warn(
        'user-identity-context: 组织身份拉取失败,本轮身份块不含组织位置',
        error instanceof Error ? error : new Error(String(error)),
      )
      return []
    }
  }

  ctx.on('platform-user/verified', (user, accessToken) => {
    ctx.currentUser.observe(user, accessToken)
  }, { global: true })
  ctx.on('platform-user/signout', () => {
    ctx.currentUser.clear()
    positionsCache = undefined
  }, { global: true })
  ctx.on('agent/pre-step', async (
    { step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (step !== 1) return decision
    const user = ctx.currentUser.get()
    if (user === undefined) return decision
    const token = ctx.currentUser.getToken()
    const positions = token === undefined ? [] : await loadPositions(token)
    const text = renderIdentityText(user, positions, token)
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user-identity-context', form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  }, { prepend: true })
}
