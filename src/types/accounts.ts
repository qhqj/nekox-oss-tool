import type { OssConfig } from './oss'

export interface OssAccount {
  id: string
  name: string
  notes: string
  config: OssConfig
}

export interface AccountState {
  version: 1
  accounts: OssAccount[]
  activeAccountId: string
  /** A recoverable local migration/storage problem, safe to display. */
  storageWarning?: string
}
