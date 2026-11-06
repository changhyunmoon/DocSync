import { contextBridge, ipcRenderer } from 'electron'
import type { DocSyncApi, PublicState } from '@shared/types'

const invoke = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args)
const listen = <T>(ch: string) => (cb: (v: T) => void) => {
  const fn = (_: unknown, v: T): void => cb(v)
  ipcRenderer.on(ch, fn)
  return () => {
    ipcRenderer.removeListener(ch, fn)
  }
}

const api: DocSyncApi = {
  openProject: invoke('openProject'),
  openDemoProject: invoke('openDemoProject'),
  getState: invoke('getState'),
  setTestMode: invoke('setTestMode'),
  onState: listen<PublicState>('state'),
  onFsChanged: listen<void>('fs-changed') as DocSyncApi['onFsChanged'],
  onToast: listen<string>('toast'),
  tree: invoke('tree'),
  readFile: invoke('readFile'),
  writeFile: invoke('writeFile'),
  createEntry: invoke('createEntry'),
  deleteEntry: invoke('deleteEntry'),
  toggleScope: invoke('toggleScope'),
  setKey: invoke('setKey'),
  setModel: invoke('setModel'),
  clearKey: invoke('clearKey'),
  useSavedKey: invoke('useSavedKey'),
  pickAttachments: invoke('pickAttachments'),
  send: invoke('send'),
  stop: invoke('stop'),
  clearConversation: invoke('clearConversation'),
  itemAction: invoke('itemAction'),
  fileAction: invoke('fileAction'),
  applyItems: invoke('applyItems'),
  applyAllApproved: invoke('applyAllApproved'),
  regenerate: invoke('regenerate'),
  editMapping: invoke('editMapping'),
  setMappingFile: invoke('setMappingFile'),
  setNewFilePath: invoke('setNewFilePath'),
  proposeMove: invoke('proposeMove'),
  previews: invoke('previews'),
} as DocSyncApi

contextBridge.exposeInMainWorld('api', api)
