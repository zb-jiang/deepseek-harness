/**
 * Enterprise session-identity context: `ctx.currentUser` remembers the latest
 * verified platform user, and the first step of every turn injects a
 * model-visible identity block so the assistant knows who it is serving. The
 * block is display-only; authorization never travels through the model.
 *
 * The store is fed by the `platform-user/verified` and `platform-user/signout`
 * events that `platform-user-api` emits on its auth touchpoints, so the two
 * packages stay decoupled: without this plugin the events emit into the void.
 *
 * @module @deepseek-ai/dsh-user-identity-context
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PlatformUser } from '@deepseek-ai/dsh-platform-user'
import { renderIdentityText } from './text.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'user-identity-context'

/** Service that must be available before the identity listener mounts. */
export const inject = ['agents'] as const

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
 * identity in place until the next touchpoint (the block is display-only, so
 * a same-human staleness window is benign). The raw access token is kept next
 * to the identity so enterprise background consumers (skill-sync) can call
 * server-side APIs as the signed-in employee; it never enters the model
 * context.
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

/**
 * Mount the current-user store and register the identity-injection listener.
 * Injection happens at step 1 of every turn: one deterministic block per turn
 * keeps the identity fresh in context without per-step duplicates, and the
 * store being empty (no verified login yet) injects nothing.
 *
 * @param ctx - plugin context; the listener and store are disposed with it.
 */
export function apply(ctx: Context): void {
  new CurrentUserService(ctx)
  ctx.on('platform-user/verified', (user, accessToken) => {
    ctx.currentUser.observe(user, accessToken)
  }, { global: true })
  ctx.on('platform-user/signout', () => { ctx.currentUser.clear() }, { global: true })
  ctx.on('agent/pre-step', async (
    { step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (step !== 1) return decision
    const user = ctx.currentUser.get()
    if (user === undefined) return decision
    const text = renderIdentityText(user)
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  }, { prepend: true })
}
