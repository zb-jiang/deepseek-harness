/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-platform-user-api`.
 * @module @deepseek-ai/dsh-platform-user-api/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-platform-user-api'

/** Cordis companion plugin name. */
export const name = 'platform-user-api-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: route disposer is returned from ctx.effect in apply,
 * guaranteeing fiber unload synchronously removes the registered route.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
