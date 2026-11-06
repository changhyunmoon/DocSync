import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { Session } from './session'
import { Settings } from './settings'
import { IGNORED } from './core/projectFs'
import { DEMO_FILES } from './mock'
import type { Provider, PublicState } from '@shared/types'

let win: BrowserWindow | null = null
let watcher: FSWatcher | null = null
let allowClose = false

const settings = new Settings()

let session: Session
const emitState = (state: PublicState): void => {
  if (session?.testMode === state.testMode) win?.webContents.send('state', state)
}
const emitToast = (message: string): void => { win?.webContents.send('toast', message) }
const realSession = new Session(emitState, emitToast)
realSession.testMode = false
const demoSession = new Session(emitState, emitToast)
session = demoSession

/** 설정 파일에 현재 프로젝트·키를 기록하고, 화면에 보여줄 저장 키 목록을 갱신 */
async function persistProject(): Promise<void> {
  if (session === realSession && realSession.fs) await settings.saveProject(realSession.fs.root, realSession.scope)
}
async function persistKey(): Promise<void> {
  if (realSession.key) await settings.saveKey(realSession.key.provider, realSession.key.apiKey, realSession.key.model, realSession.key.models)
  realSession.savedKeys = settings.savedKeys()
  realSession.changed()
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'DocSync',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // 외부 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  // 종료 전 안내
  win.on('close', (e) => {
    if (allowClose) return
    const real = realSession.quitSummary()
    const demo = demoSession.quitSummary()
    const unapplied = real.unapplied + demo.unapplied
    const applied = real.applied + demo.applied
    if (!unapplied && !applied) return
    e.preventDefault()
    const lines: string[] = []
    if (unapplied) lines.push(`반영하지 않은 항목 ${unapplied}개`)
    if (applied) lines.push(`되돌릴 수 있는 반영 ${applied}개`)
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['종료', '취소'],
      defaultId: 1,
      cancelId: 1,
      title: 'DocSync 종료',
      message: `${lines.join(', ')}이 있습니다.`,
      detail: '작업 정보와 되돌리기 정보는 삭제됩니다. 이미 반영한 파일 변경과 프로젝트·API 키 설정은 유지됩니다.'
    })
    if (choice === 0) {
      allowClose = true
      win?.close()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

async function startWatch(root: string | null): Promise<void> {
  await watcher?.close()
  watcher = null
  if (!root) return
  let timer: NodeJS.Timeout | null = null
  const observedSession = session
  watcher = watch(root, {
    ignoreInitial: true,
    ignored: (p: string) => {
      const parts = path.relative(root, p).split(path.sep)
      return parts.some((x) => IGNORED.has(x)) || p.endsWith('.tmp')
    },
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  })
  watcher.on('all', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      if (session !== observedSession) return
      await session.revalidate()
      win?.webContents.send('fs-changed')
    }, 200)
  })
}

/** 기존 샘플의 변경은 보존하고, 필요하면 새 번호의 시연 폴더를 만든다. */
async function openDemo(): Promise<PublicState> {
  const base = path.join(app.getPath('userData'), 'sample-project-v2')
  let root = base
  for (let n = 2; ; n++) {
    try { await fsp.access(root) } catch { break }
    const same = await Promise.all(Object.entries(DEMO_FILES).map(async ([rel, content]) => {
      try { return await fsp.readFile(path.join(root, rel), 'utf8') === content } catch { return false }
    }))
    if (same.every(Boolean)) break
    root = `${base}-${n}`
  }
  for (const [rel, content] of Object.entries(DEMO_FILES)) {
    const file = path.join(root, rel)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    try { await fsp.writeFile(file, content, { encoding: 'utf8', flag: 'wx' }) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  }
  await demoSession.openProject(root, ['docs'])
  session = demoSession
  await startWatch(root)
  win?.webContents.send('fs-changed')
  demoSession.changed()
  return demoSession.publicState()
}

function registerIpc(): void {
  const h = <A extends unknown[], R>(ch: string, fn: (...a: A) => R | Promise<R>): void => {
    ipcMain.handle(ch, async (_e, ...args) => {
      try {
        return await fn(...(args as A))
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  h('openProject', async () => {
    if (session !== realSession) return session.publicState()
    const r = await dialog.showOpenDialog(win!, { title: '프로젝트 폴더 선택', properties: ['openDirectory'] })
    if (!r.canceled && r.filePaths[0]) {
      await realSession.openProject(r.filePaths[0], settings.scopeOf(r.filePaths[0]))
      await startWatch(r.filePaths[0])
      await persistProject()
    }
    return session.publicState()
  })
  h('openDemoProject', () => openDemo())
  h('getState', () => session.publicState())
  h('setTestMode', async (enabled: boolean) => {
    if (session.processing) return { ok: false, message: '처리가 끝난 뒤 프로젝트를 바꾸세요.' }
    if (session.testMode === enabled) return { ok: true }
    if (enabled && !demoSession.fs) await openDemo()
    session = enabled ? demoSession : realSession
    await startWatch(session.fs?.root ?? null)
    session.changed()
    win?.webContents.send('fs-changed')
    return { ok: true, message: enabled ? '샘플 프로젝트로 전환했습니다.' : realSession.fs ? '실제 프로젝트로 돌아왔습니다.' : '실제 프로젝트 폴더를 여세요.' }
  })
  h('tree', () => session.tree())
  h('readFile', (p: string) => session.fs?.read(p) ?? null)
  h('writeFile', (p: string, c: string, base?: string | null) => session.writeFile(p, c, base))
  h('createEntry', (p: string, dir: boolean) => session.createEntry(p, dir))
  h('deleteEntry', async (p: string) => {
    const c = dialog.showMessageBoxSync(win!, { type: 'warning', buttons: ['삭제', '취소'], defaultId: 1, cancelId: 1, message: `${p}을(를) 삭제할까요?`, detail: '삭제한 파일은 앱에서 되돌릴 수 없습니다.' })
    if (c !== 0) return { ok: false }
    return session.deleteEntry(p)
  })
  h('toggleScope', async (p: string) => {
    const r = session.toggleScope(p)
    await persistProject()
    return r
  })

  h('setKey', async (provider: Provider, key: string) => {
    const r = await session.setKey(provider, key)
    if (r.ok) await persistKey()
    return r
  })
  h('setModel', async (m: string) => {
    const r = await session.setModel(m)
    if (r.ok) await persistKey()
    return r
  })
  h('clearKey', async () => {
    const p = session.key?.provider
    if (p) await settings.removeKey(p)
    session.savedKeys = settings.savedKeys()
    return session.clearKey()
  })
  h('useSavedKey', async (provider: Provider) => {
    const k = settings.getKey(provider)
    if (!k) return { ok: false, message: '저장된 키를 불러올 수 없습니다. 키를 다시 입력하세요.' }
    session.restoreKey(provider, k.apiKey, k.model, k.models)
    await settings.setActive(provider)
    return { ok: true, message: `저장된 ${provider} 키로 바꿨습니다 · 모델 ${k.model}` }
  })

  h('pickAttachments', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '자료 첨부',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '텍스트·Markdown', extensions: ['md', 'markdown', 'mdx', 'txt'] }]
    })
    if (r.canceled) return []
    const out: { name: string; text: string }[] = []
    for (const f of r.filePaths) {
      const st = await fsp.stat(f)
      if (st.size > 2_000_000) continue
      out.push({ name: path.basename(f), text: await fsp.readFile(f, 'utf8') })
    }
    return out
  })
  h('send', (input) => session.send(input as Parameters<Session['send']>[0]))
  h('stop', () => session.stop())
  h('clearConversation', () => {
    if (session.processing) return { ok: false, message: 'AI 처리가 끝난 뒤 대화를 지우세요.' }
    const hasApplied = session.items.some((item) => item.status === 'applied')
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['대화 전체 지우기', '취소'],
      defaultId: 1,
      cancelId: 1,
      message: '대화와 현재 작업을 모두 지울까요?',
      detail: hasApplied
        ? '대화, 입력 자료, 추출 항목과 변경안을 지웁니다. 이미 반영한 파일은 그대로 남지만 앱에서 되돌릴 수 없게 됩니다.'
        : '대화, 입력 자료, 추출 항목과 변경안을 지웁니다. 프로젝트 파일은 변경하지 않습니다.'
    })
    return choice === 0 ? session.clearConversation() : { ok: false }
  })

  h('itemAction', (id: string, action: string) => session.itemAction(id, action))
  h('fileAction', (i: string, m: string, action: string) => session.fileAction(i, m, action))
  h('applyItems', (ids: string[]) => session.applyItems(ids))
  h('applyAllApproved', () => session.applyAllApproved())
  h('regenerate', (id: string, instr?: string) => session.regenerate(id, instr))
  h('editMapping', (i: string, m: string, t: string) => session.editMapping(i, m, t))
  h('setMappingFile', (i: string, m: string, p: string | null) => session.setMappingFile(i, m, p))
  h('setNewFilePath', (i: string, m: string, p: string) => session.setNewFilePath(i, m, p))
  h('proposeMove', (a: string, b: string) => session.proposeMove(a, b))
  h('previews', (id: string) => session.previews(id))
}

app.whenReady().then(async () => {
  // 실제 작업 프로젝트는 메모리에 유지하고, 시작 화면은 샘플 프로젝트로 연다.
  await settings.load()
  realSession.keyPersist = settings.canEncrypt
  realSession.savedKeys = settings.savedKeys()
  const active = settings.activeProvider
  const k = active ? settings.getKey(active) : null
  if (active && k) realSession.restoreKey(active, k.apiKey, k.model, k.models)
  const last = settings.lastRealProject
  if (last) {
    try {
      await fsp.access(last)
      await realSession.openProject(last, settings.scopeOf(last))
    } catch {
      /* 폴더가 사라졌으면 실제 모드에서 폴더 선택 화면을 보여준다. */
    }
  }
  await openDemo()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await watcher?.close()
  // 작업 데이터(항목·되돌리기 정보)는 메모리에만 있어 종료와 함께 사라진다. 프로젝트·키 설정은 settings.json에 남는다
  app.quit()
})
