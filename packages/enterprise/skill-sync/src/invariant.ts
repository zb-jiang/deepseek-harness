/** Package-owned invariant companion for `@deepseek-ai/dsh-skill-sync`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-skill-sync'

/** Cordis companion plugin name. */
export const name = 'skill-sync-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the cache root is package-owned scratch state whose
 * consumers see only through `ctx.skills` (already covered by the registry's
 * own consistency) and `ensureInstalled` (returns exactly what is absent);
 * no independent observation can diverge from either.
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
