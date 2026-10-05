# Enterprise platform

English | [中文](enterprise.zh.md)

The enterprise profile mounts three services: the platform-user governance seam (`ctx.platformUsers`), the latest verified employee identity on this DSH instance (`ctx.currentUser`), and enterprise skill sync (`ctx.skillSync`). The package READMEs own the behavioral contracts: [platform-user](../../packages/enterprise/platform-user/README.md), [user-identity-context](../../packages/enterprise/user-identity-context/README.md), and [skill-sync](../../packages/enterprise/skill-sync/README.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcurrentuser--currentuserservice"></a>

### `ctx.currentUser` — `CurrentUserService`

In-process store of the latest verified platform user. The `platform-user/verified` event (emitted on every verified `GET /api/enterprise/auth/me`) feeds CurrentUserService.observe; `platform-user/signout` feeds CurrentUserService.clear; the identity context listener reads the store at each turn's first step. State lives in memory only: a restarted webserver learns the identity at the client's next `/me` call, and a token expiring mid-session leaves the last verified identity in place until the next touchpoint (a same-human staleness window is benign). The raw access token is kept next to the identity with two consumers: enterprise background services (skill-sync) call server-side APIs as the signed-in employee, and the identity block renders it so the assistant can call enterprise internal systems (Supabase SSO bearer auth) as that employee.

```ts cordis-catalog
/**
 * Record one verified platform user as the current identity.
 * @param user - platform user resolved from a JWT-verified access token.
 * @param accessToken - the verified bearer token; omitted keeps any previous
 * token (callers that re-verify only the user).
 */
observe(user: PlatformUser, accessToken?: string): void

/** Forget the current identity (employee signed out). */
clear(): void

/**
 * Read the latest verified identity.
 * @returns the latest verified identity, or undefined when nobody is logged in.
 */
get(): PlatformUser | undefined

/**
 * Read the latest verified bearer token.
 * @returns the latest verified bearer token, or undefined when nobody has
 * signed in; may be stale after token expiry — callers treat a 401 as
 * "signed out" and retry after the next verified `/me`.
 */
getToken(): string | undefined
```

Source: [`packages/enterprise/user-identity-context/src/index.ts`](../../packages/enterprise/user-identity-context/src/index.ts)

<a id="ctxplatformusers--platformuserservice"></a>

### `ctx.platformUsers` — `PlatformUserService`

`ctx.platformUsers`: one active provider plus the read entry point.

```ts cordis-catalog
/**
 * Register the active provider. Only one provider may be mounted.
 * @param provider - provider implementation.
 * @returns disposer that unregisters it.
 */
registerProvider(provider: PlatformUserProvider): () => void

/**
 * Resolve a platform user from a Supabase Auth access token.
 * @param accessToken - Supabase Auth access token (Bearer).
 * @returns the platform user record.
 */
getUserByToken(accessToken: string): Promise<PlatformUser>
```

Source: [`packages/enterprise/platform-user/src/index.ts`](../../packages/enterprise/platform-user/src/index.ts)

<a id="ctxskillsync--skillsyncservice"></a>

### `ctx.skillSync` — `SkillSyncService`

员工端 skill 分发服务:周期同步 + 即时安装入口(工作项 3 的对接面)。

<p>daemon 只在有人登录时干活:未登录(token 缺失)或 token 过期(401)的 一轮直接跳过,下轮重试;单 skill 下载失败记 warn 不中断同轮其他 skill。

```ts cordis-catalog
/**
 * 启动服务:缓存目录不存在时创建,随后立即跑一轮同步(不等第一个 interval)。
 * 本服务由 apply() 内普通构造挂载(非 class 插件),cordis 不会自动调用
 * `[Service.init]`,故由 apply 显式调用本方法。
 */
async start(): Promise<void>

/**
 * 执行一轮同步:拉取当前用户所需清单,下载缺失/过期的 skill 到缓存目录,
 * 有安装动作后失效 skill 注册表缓存。错误记日志不上抛(daemon 语义)。
 * 已有一轮在跑时合并等待,不重复出站。
 */
async sync(): Promise<void>

/**
 * 确保指定 skill 已安装;缺失时立即执行一轮同步再复查。
 *
 * @param names - 需要就绪的 skill 裸名(待办 dshMeta.skillRefs)。
 * @returns 仍缺失的 skill 名(同步后依旧不可用,调用方走降级提示)。
 */
async ensureInstalled(names: readonly string[]): Promise<readonly string[]>
```

Source: [`packages/enterprise/skill-sync/src/index.ts`](../../packages/enterprise/skill-sync/src/index.ts)

<a id="platform-user-events"></a>

### `platform-user/*` events

<a id="platform-usersignout--emit"></a>

#### `platform-user/signout` — emit

The employee signed out on this DSH instance (emitted by `platform-user-api` on the signout touchpoint). Listeners holding a latest-verified-identity cache must forget it. Carries no payload: the touchpoint does not prove which identity signed out.

```ts cordis-catalog
/**
 * The employee signed out on this DSH instance (emitted by
 * `platform-user-api` on the signout touchpoint). Listeners holding a
 * latest-verified-identity cache must forget it. Carries no payload:
 * the touchpoint does not prove which identity signed out.
 * @mode emit
 */
'platform-user/signout'(): void
```

Source: [`packages/enterprise/platform-user/src/index.ts`](../../packages/enterprise/platform-user/src/index.ts)

<a id="platform-userverified--emit"></a>

#### `platform-user/verified` — emit

A platform user identity was verified through an auth touchpoint (emitted by `platform-user-api` after `getUserByToken` resolves). Listeners typically maintain a latest-verified-identity cache.

```ts cordis-catalog
/**
 * A platform user identity was verified through an auth touchpoint
 * (emitted by `platform-user-api` after `getUserByToken` resolves).
 * Listeners typically maintain a latest-verified-identity cache.
 * @param user - the verified platform user record.
 * @param accessToken - the verified bearer token, re-carried so enterprise
 *   consumers (e.g. skill-sync) can call server-side APIs as the signed-in
 *   employee.
 * @mode emit
 */
'platform-user/verified'(user: PlatformUser, accessToken: string): void
```

Source: [`packages/enterprise/platform-user/src/index.ts`](../../packages/enterprise/platform-user/src/index.ts)
<!-- END GENERATED cordis-surface -->
