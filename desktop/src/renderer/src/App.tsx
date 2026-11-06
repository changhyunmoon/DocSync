import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActionResult, PublicState, TreeNode } from '@shared/types'
import TopBar from './components/TopBar'
import FileTree from './components/FileTree'
import ChatPanel from './components/ChatPanel'
import RightPane, { tabKey, type Sel, type Tab } from './components/RightPane'
import { KeyDialog, PromptDialog, type PromptSpec } from './components/Dialogs'
import Resizer from './components/Resizer'
import { STATUS } from './status'

const DEFAULT_W = { left: 260, center: 440 }
const MIN = { left: 180, center: 320, right: 360 }

function loadWidths(): { left: number; center: number } {
  try {
    const v = JSON.parse(localStorage.getItem('docsync.paneWidths') ?? '')
    if (typeof v?.left === 'number' && typeof v?.center === 'number') return v
  } catch {
    /* 저장된 값이 없으면 기본값 */
  }
  return DEFAULT_W
}

const ancestors = (p: string): string[] => {
  const parts = p.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

export default function App() {
  const [st, setSt] = useState<PublicState | null>(null)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [fsVer, setFsVer] = useState(0)
  // 오른쪽 화면은 브라우저처럼 탭을 쌓는다 (원문 · 항목 · 파일)
  const [{ tabs, activeKey }, setTabState] = useState<{ tabs: Tab[]; activeKey: string | null }>({ tabs: [], activeKey: null })
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set())
  /** 이미 탭으로 연 적 있는 입력 자료 (새 자료만 자동으로 연다) */
  const seenSources = useRef<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [scrollTo, setScrollTo] = useState<{ path: string; key: number } | null>(null)
  const [toast, setToast] = useState('')
  const [keyDlg, setKeyDlg] = useState<null | { retry?: () => Promise<ActionResult> }>(null)
  const [prompt, setPrompt] = useState<PromptSpec | null>(null)
  const [chatEpoch, setChatEpoch] = useState(0)
  const sel: Sel = tabs.find((t) => tabKey(t) === activeKey) ?? { kind: 'none' }

  /** 탭 열기. 이미 열려 있으면 그 탭으로 이동만 한다 */
  const openTab = useCallback((t: Tab) => {
    const k = tabKey(t)
    setTabState((s) => ({ tabs: s.tabs.some((x) => tabKey(x) === k) ? s.tabs : [...s.tabs, t], activeKey: k }))
  }, [])

  /** 여러 탭을 한 번에 열고 마지막 탭을 보여준다 */
  const openTabs = useCallback((ts: Tab[]) => {
    if (!ts.length) return
    setTabState((s) => ({ tabs: [...s.tabs, ...ts.filter((t) => !s.tabs.some((x) => tabKey(x) === tabKey(t)))], activeKey: tabKey(ts[ts.length - 1]) }))
  }, [])

  const setActiveKey = useCallback((k: string) => setTabState((s) => ({ ...s, activeKey: k })), [])

  const updateTab = useCallback((k: string, t: Tab) => setTabState((s) => ({ ...s, tabs: s.tabs.map((x) => (tabKey(x) === k ? t : x)) })), [])

  /** 탭을 닫는다. 보고 있던 탭이 닫히면 옆 탭(오른쪽, 없으면 왼쪽)을 보여준다 */
  const removeTabs = useCallback((drop: (t: Tab) => boolean) => {
    setTabState((s) => {
      const next = s.tabs.filter((t) => !drop(t))
      if (next.length === s.tabs.length) return s
      const cur = s.activeKey
      if (cur && next.some((t) => tabKey(t) === cur)) return { tabs: next, activeKey: cur }
      const i = s.tabs.findIndex((t) => tabKey(t) === cur)
      const near = s.tabs.slice(i + 1).find((t) => !drop(t)) ?? s.tabs.slice(0, Math.max(i, 0)).reverse().find((t) => !drop(t))
      return { tabs: next, activeKey: near ? tabKey(near) : null }
    })
  }, [])

  const closeTab = (k: string) => {
    const t = tabs.find((x) => tabKey(x) === k)
    if (t?.kind === 'file' && dirtyPaths.has(t.path) && !window.confirm('저장하지 않은 수정이 있습니다. 문서를 닫고 수정을 버릴까요?')) return
    removeTabs((x) => tabKey(x) === k)
  }

  const onDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyPaths((prev) => {
      if (prev.has(path) === dirty) return prev
      const n = new Set(prev)
      if (dirty) n.add(path)
      else n.delete(path)
      return n
    })
  }, [])
  const [widths, setWidths] = useState(loadWidths)
  const [winW, setWinW] = useState(window.innerWidth)
  const dragStart = useRef(widths)

  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 창 크기에 맞게 너비를 제한 (오른쪽 화면이 최소 너비를 유지하도록)
  const clampW = (w: { left: number; center: number }) => {
    const left = Math.min(Math.max(w.left, MIN.left), Math.max(MIN.left, winW - MIN.center - MIN.right))
    const center = Math.min(Math.max(w.center, MIN.center), Math.max(MIN.center, winW - left - MIN.right))
    return { left, center }
  }
  const eff = clampW(widths)
  const saveWidths = (w: { left: number; center: number }) => {
    try {
      localStorage.setItem('docsync.paneWidths', JSON.stringify(w))
    } catch {
      /* 저장 실패는 무시 */
    }
  }
  const resize = (which: 'left' | 'center') => (dx: number, phase: 'start' | 'move' | 'end') => {
    if (phase === 'start') {
      dragStart.current = eff
      return
    }
    const s = dragStart.current
    const next = clampW(which === 'left' ? { left: s.left + dx, center: s.center } : { left: s.left, center: s.center + dx })
    setWidths(next)
    if (phase === 'end') saveWidths(next)
  }
  const resetW = () => {
    setWidths(DEFAULT_W)
    saveWidths(DEFAULT_W)
  }
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((m: string) => {
    setToast(m)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 3500)
  }, [])

  useEffect(() => {
    window.api.getState().then(setSt)
    const a = window.api.onState(setSt)
    const b = window.api.onFsChanged(() => setFsVer((v) => v + 1))
    const c = window.api.onToast(showToast)
    return () => {
      a()
      b()
      c()
    }
  }, [showToast])

  useEffect(() => {
    if (!st?.root) return setTree([])
    window.api.tree().then(setTree)
  }, [st?.root, fsVer])

  // 프로젝트를 새로 열면 범위 폴더를 펼친다
  useEffect(() => {
    if (st?.root) setExpanded(new Set(st.scope.flatMap((s) => [...ancestors(s + '/x')])))
    setTabState({ tabs: [], activeKey: null })
    seenSources.current = new Set()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.root])

  // 새 입력 자료가 들어오면(분석 시작) 원문 탭을 무조건 열고 그 탭을 보여준다
  useEffect(() => {
    if (!st) return
    const fresh = st.sources.filter((s) => !seenSources.current.has(s.id))
    if (!fresh.length) return
    fresh.forEach((s) => seenSources.current.add(s.id))
    openTabs(fresh.map((s): Tab => ({ kind: 'source', sourceId: s.id })))
  }, [st, openTabs])

  // 사라진 항목·자료의 탭은 닫는다
  useEffect(() => {
    if (!st) return
    const items = new Set(st.items.map((i) => i.id))
    const sources = new Set(st.sources.map((s) => s.id))
    for (const id of seenSources.current) if (!sources.has(id)) seenSources.current.delete(id)
    removeTabs((t) => (t.kind === 'item' && !items.has(t.itemId)) || (t.kind === 'source' && !sources.has(t.sourceId)))
  }, [st, removeTabs])

  /** 액션 결과 처리. 키가 필요하면 키 입력 창을 열고, 저장 후 retry를 실행한다 */
  const run = useCallback(
    async (p: Promise<ActionResult>, retry?: () => Promise<ActionResult>): Promise<ActionResult> => {
      const r = await p
      if (r?.message === 'need-key') setKeyDlg({ retry })
      else if (r?.message) showToast(r.message)
      return r ?? { ok: false }
    },
    [showToast]
  )

  const selectedItem = sel.kind === 'item' ? st?.items.find((i) => i.id === sel.itemId) ?? null : null

  const mappedPaths = useMemo(() => {
    if (!selectedItem) return []
    const all = new Set<string>()
    const visit = (ns: TreeNode[]) => ns.forEach((n) => (n.dir ? visit(n.children ?? []) : all.add(n.path)))
    visit(tree)
    const out: string[] = []
    for (const m of selectedItem.mappings) {
      if (m.file && all.has(m.file)) out.push(m.file)
      if (m.moveTo && all.has(m.moveTo)) out.push(m.moveTo)
    }
    return [...new Set(out)]
  }, [selectedItem, tree])

  /** 항목을 누르면 그 항목 탭을 연다 (이미 열려 있으면 그 탭으로 이동) */
  const selectItem = (id: string) => {
    const it = st?.items.find((i) => i.id === id)
    if (!it) return
    openTab({ kind: 'item', itemId: id, mappingId: it.mappings[0]?.id ?? null })
    const files = it.mappings.flatMap((m) => [m.file, m.moveTo]).filter(Boolean) as string[]
    setExpanded((prev) => new Set([...prev, ...files.flatMap(ancestors)]))
    if (files[0]) setScrollTo({ path: files[0], key: Date.now() })
  }

  const openSource = (id: string) => openTab({ kind: 'source', sourceId: id })

  /** 트리에서 파일을 누르면 그 파일 탭을 연다 (항목별 diff는 항목 탭에서 본다) */
  const openFile = (path: string) => openTab({ kind: 'file', path })

  const clearConversation = async () => {
    const result = await run(window.api.clearConversation())
    if (!result.ok) return
    removeTabs((t) => t.kind !== 'file')
    seenSources.current = new Set()
    setChatEpoch((n) => n + 1)
  }

  const openDemo = async () => {
    const next = await window.api.openDemoProject()
    if (next?.root) setSt(next)
    else showToast('샘플 프로젝트를 열지 못했습니다.')
  }

  if (!st) return null

  if (!st.root) {
    return (
      <div className="app">
        <TopBar st={st} onOpen={() => window.api.openProject()} onDemo={openDemo} onMode={(v) => run(window.api.setTestMode(v))} onKey={() => setKeyDlg({})} />
        <div className="welcome">
          <span className="logo" style={{ width: 40, height: 40, fontSize: 20, borderRadius: 9 }}>D</span>
          <h1 style={{ margin: 0, fontSize: 22 }}>프로젝트 폴더를 여세요</h1>
          <p className="muted" style={{ margin: 0, textAlign: 'center', lineHeight: '22px' }}>
            Markdown 문서가 있는 로컬 프로젝트를 연결하면,
            <br />
            기획안·회의록의 내용을 항목 단위로 검토해 docs에 반영할 수 있습니다.
          </p>
          <button className="btn primary" onClick={() => window.api.openProject()}>폴더 열기</button>
          {st.testMode && <button className="btn" onClick={openDemo}>샘플 프로젝트로 체험하기</button>}
        </div>
        {keyDlg && <KeyDialog info={st.key} needed={false} saved={st.savedKeys} persist={st.keyPersist} onClose={() => setKeyDlg(null)} onSaved={() => setKeyDlg(null)} />}
      </div>
    )
  }

  return (
    <div className="app">
      <TopBar st={st} onOpen={() => window.api.openProject()} onDemo={openDemo} onMode={(v) => run(window.api.setTestMode(v))} onKey={() => setKeyDlg({})} />
      <div className="panes" style={{ ['--left-w' as string]: `${eff.left}px`, ['--center-w' as string]: `${eff.center}px` }}>
        <FileTree
          tree={tree}
          expanded={expanded}
          onToggle={(p) => setExpanded((prev) => {
            const n = new Set(prev)
            if (n.has(p)) n.delete(p)
            else n.add(p)
            return n
          })}
          scope={st.scope}
          current={sel.kind === 'file' ? sel.path : sel.kind === 'item' ? selectedItem?.mappings.find((m) => m.id === sel.mappingId)?.file ?? null : null}
          highlight={{ paths: mappedPaths, color: selectedItem ? STATUS[selectedItem.status].fg : '' }}
          scrollTo={scrollTo}
          onOpenFile={openFile}
          onNew={(parent, dir) =>
            setPrompt({
              title: dir ? '새 폴더' : '새 파일',
              label: '경로 (프로젝트 루트 기준)',
              initial: parent ? `${parent}/` : dir ? '' : 'docs/',
              ok: '만들기',
              onSubmit: async (v) => {
                const r = await run(window.api.createEntry(v, dir))
                if (r.ok) {
                  setFsVer((x) => x + 1)
                  setExpanded((prev) => new Set([...prev, ...ancestors(v)]))
                  if (!dir) openFile(v)
                }
              }
            })
          }
          onRename={(path) =>
            setPrompt({
              title: '이름 변경',
              label: '새 경로 · 참조 링크를 검사해 이동 변경안으로 만듭니다',
              initial: path,
              ok: '변경안 만들기',
              onSubmit: async (v) => {
                if (v === path) return
                const before = new Set(st.items.map((i) => i.id))
                const r = await run(window.api.proposeMove(path, v))
                if (r.ok) {
                  const s = await window.api.getState()
                  const ni = s.items.find((i) => !before.has(i.id))
                  if (ni) openTab({ kind: 'item', itemId: ni.id, mappingId: ni.mappings[0]?.id ?? null })
                }
              }
            })
          }
          onDelete={async (path) => {
            const r = await run(window.api.deleteEntry(path))
            if (r.ok) {
              setFsVer((x) => x + 1)
              removeTabs((t) => t.kind === 'file' && (t.path === path || t.path.startsWith(path + '/')))
            }
          }}
          onToggleScope={(p) => run(window.api.toggleScope(p))}
        />
        <Resizer label="파일 탐색기 너비 조절" onResize={resize('left')} onReset={resetW} />
        <ChatPanel
          key={`${chatEpoch}:${st.root}:${st.testMode}`}
          st={st}
          selectedId={selectedItem?.id ?? null}
          onSelectItem={(id) => selectItem(id)}
          onOpenSource={openSource}
          onClearConversation={clearConversation}
          run={run}
        />
        <Resizer label="대화·항목 영역 너비 조절" onResize={resize('center')} onReset={resetW} />
        <RightPane st={st} tabs={tabs} activeKey={activeKey} onActivate={setActiveKey} onCloseTab={closeTab} onOpen={openTab} onUpdateTab={updateTab}
          onDirty={onDirty} dirtyPaths={dirtyPaths} run={run} fsVer={fsVer} tree={tree} onSelectItem={selectItem} />
      </div>

      {keyDlg && (
        <KeyDialog
          info={st.key}
          needed={!!keyDlg.retry}
          saved={st.savedKeys}
          persist={st.keyPersist}
          onClose={() => setKeyDlg(null)}
          onSaved={() => {
            const retry = keyDlg.retry
            setKeyDlg(null)
            showToast(st.keyPersist ? 'API 키를 확인하고 이 PC에 암호화해서 저장했습니다.' : 'API 키를 확인했습니다. 앱 실행 중에만 보관합니다.')
            if (retry) run(retry())
          }}
        />
      )}
      {prompt && <PromptDialog spec={prompt} onClose={() => setPrompt(null)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}
