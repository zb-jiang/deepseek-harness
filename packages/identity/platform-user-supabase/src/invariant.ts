/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-platform-user-supabase`.
 * @module @deepseek-ai/dsh-platform-user-supabase/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-platform-user-supabase'

/** Cordis companion plugin name. */
export const name = 'platform-user-supabase-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider is a thin transport adapter over one
 * external table, and every relation it owns is checked inline when a row
 * crosses into the seam.
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
