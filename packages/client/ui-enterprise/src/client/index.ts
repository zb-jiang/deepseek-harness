import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { EnterpriseNav, EnterpriseOverlay } from './EnterpriseUi.tsx'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.dshEnterpriseProfile = 'true'
  }

  ctx.slots.inject('sidebar.nav', () => ctx.slots.register(
    { name: 'sidebar.nav' },
    EnterpriseNav,
  ))

  ctx.slots.register(
    { name: 'shell.overlay', id: 'enterprise', order: 50 },
    EnterpriseOverlay,
  )
}
