import type { DocSyncApi } from '../shared/types'

declare global {
  interface Window {
    api: DocSyncApi
  }
}
export {}
