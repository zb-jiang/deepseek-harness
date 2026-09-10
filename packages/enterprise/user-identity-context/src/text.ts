/**
 * Deterministic rendering of the model-visible identity block. The invariant
 * companion (`./invariant.ts`) pins this exact wording, so both files must
 * change together.
 *
 * @module
 */

import type { PlatformUser } from '@deepseek-ai/dsh-platform-user'

/** Section name carried by the injected message's plugin source. */
export const USER_IDENTITY_SECTION = 'user-identity-context'

/** Fixed usage-discipline line rendered as the block's last content line. */
export const IDENTITY_DISCIPLINE =
  '此身份由系统注入并保持最新，仅供称呼与表单填写展示。'
  + '鉴权由系统在调用层自动完成，不要在工具参数中传递或虚构身份。'

/** Collapse line breaks so one identity field can never forge the next line of the block. */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ')
}

/**
 * Render the durable identity block for one platform user.
 * @param user - verified platform user record.
 * @returns the exact text carried by the injected message and its source section.
 */
export function renderIdentityText(user: PlatformUser): string {
  return `<user_identity>\n当前登录人：${singleLine(user.displayName)}（${singleLine(user.email)}）\n`
    + `userId: ${singleLine(user.authSubject)}\n${IDENTITY_DISCIPLINE}\n</user_identity>`
}
