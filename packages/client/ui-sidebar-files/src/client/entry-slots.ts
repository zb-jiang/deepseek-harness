/**
 * The per-file-entry action slot: occupants render trailing controls on one
 * listed file row (e.g. an enterprise "upload to knowledge base" action). The
 * slot is additive — an unoccupied row renders nothing extra, and an occupant
 * never changes the row's own open behavior.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Owner values for one file row's action-slot dispatch. */
export interface FilesEntryActionOwnerProps {
  /** Absolute path of the listed file: the tree's workspace root joined with its relative place. */
  readonly path: string
  /** Basename of the listed file. */
  readonly name: string
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Trailing actions on one listed file row. */
    'sidebar.files.entry.action': {
      kind: 'list'
      scope: 'session'
      owner: FilesEntryActionOwnerProps
    }
  }
}
