/**
 * Fetch the current user's org positions from the web-console runtime API
 * (`GET /api/runtime/my-org-positions`, design 2026-09-19 §6.4). The raw
 * access token travels server-side only and never enters the model context.
 *
 * @module
 */

import { type OrgPosition } from './text.ts'

/** web-console {@code ApiResponse} 信封(成功时 data 必有值)。 */
interface ApiEnvelope {
  success?: boolean
  data?: OrgPosition[]
  error?: { message?: string }
}

/**
 * 调 web-console 拉取当前登录人的组织身份清单。
 *
 * @param webConsoleBaseUrl - web-console 基地址(无尾斜杠)。
 * @param accessToken - 当前登录员工的 Supabase JWT。
 * @returns 组织身份列表;组织维度未启用时为空数组。
 * @throws Error 未授权(401,token 失效)或 web-console 不可达/响应异常——调用方
 *   降级为空清单并记 warn,不让身份块注入因组织维度失败而中断。
 */
export async function fetchOrgPositions(
  webConsoleBaseUrl: string,
  accessToken: string,
): Promise<OrgPosition[]> {
  let resp: Response
  try {
    resp = await fetch(new URL('/api/runtime/my-org-positions', webConsoleBaseUrl), {
      headers: { authorization: `Bearer ${accessToken}` },
    })
  } catch (error) {
    throw new Error(
      `web-console 不可达(${webConsoleBaseUrl}): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let body: ApiEnvelope
  try {
    body = await resp.json() as ApiEnvelope
  } catch {
    throw new Error(`web-console 组织身份响应不是 JSON(HTTP ${resp.status})`)
  }
  if (!resp.ok || body.success !== true || !Array.isArray(body.data)) {
    throw new Error(body.error?.message ?? `web-console 组织身份请求失败(HTTP ${resp.status})`)
  }
  return body.data
}
