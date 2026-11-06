import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { TreeNode } from '@shared/types'
import { IChevron, IFile, INewFile, INewFolder, IRename, ISearch, ITarget, ITrash } from './Icons'

interface Props {
  tree: TreeNode[]
  expanded: Set<string>
  onToggle: (path: string) => void
  scope: string[]
  current: string | null
  highlight: { paths: string[]; color: string }
  scrollTo: { path: string; key: number } | null
  onOpenFile: (path: string) => void
  onNew: (parent: string, dir: boolean) => void
  onRename: (path: string) => void
  onDelete: (path: string) => void
  onToggleScope: (path: string) => void
}

const inScope = (p: string, scope: string[]) => !scope.length || scope.some((s) => p === s || p.startsWith(s + '/'))

export default function FileTree(p: Props) {
  const [q, setQ] = useState('')
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const hi = useMemo(() => new Set(p.highlight.paths), [p.highlight.paths])

  // 항목 선택 시 첫 번째 매핑 파일로 한 번만 스크롤
  useEffect(() => {
    if (!p.scrollTo) return
    const t = setTimeout(() => rowRefs.current.get(p.scrollTo!.path)?.scrollIntoView({ block: 'nearest' }), 30)
    return () => clearTimeout(t)
  }, [p.scrollTo?.key])

  const flat = useMemo(() => {
    const out: TreeNode[] = []
    const visit = (ns: TreeNode[]) => ns.forEach((n) => (n.dir ? visit(n.children ?? []) : out.push(n)))
    visit(p.tree)
    return out
  }, [p.tree])

  const row = (n: TreeNode, depth: number, label?: string) => {
    const mapped = hi.has(n.path)
    const scoped = p.scope.includes(n.path)
    return (
      <div
        key={n.path}
        ref={(el) => {
          if (el) rowRefs.current.set(n.path, el)
          else rowRefs.current.delete(n.path)
        }}
        className={`trow${mapped ? ' mapped' : ''}${n.path === p.current ? ' current' : ''}${inScope(n.path, p.scope) ? '' : ' out'}`}
        style={{ paddingLeft: 8 + depth * 14, boxShadow: mapped ? `inset 0 0 0 1px ${p.highlight.color}` : undefined }}
      >
        <button
          className="row grow"
          style={{ gap: 6, minWidth: 0, height: 28 }}
          onClick={() => (n.dir ? p.onToggle(n.path) : p.onOpenFile(n.path))}
          title={n.path}
        >
          {n.dir ? <IChevron open={p.expanded.has(n.path)} /> : <IFile />}
          <span className="name">{label ?? n.name}</span>
          {scoped && <span className="chip" style={{ background: '#e7f3f8', color: '#1f5f99' }}>반영 범위</span>}
          {mapped && <span style={{ width: 6, height: 6, borderRadius: 3, background: p.highlight.color, flex: '0 0 6px' }} />}
        </button>
        <span className="acts">
          {n.dir && (
            <button className="icon-btn" title="새 파일" aria-label="새 파일" onClick={() => p.onNew(n.path, false)}>
              <INewFile />
            </button>
          )}
          <button className="icon-btn" title={scoped ? '반영 범위에서 제외' : '반영 범위로 지정'} aria-label="반영 범위 지정" onClick={() => p.onToggleScope(n.path)}>
            <ITarget />
          </button>
          <button className="icon-btn" title="이름 변경 (참조 검사 후 변경안 생성)" aria-label="이름 변경" onClick={() => p.onRename(n.path)}>
            <IRename />
          </button>
          <button className="icon-btn" title="삭제" aria-label="삭제" onClick={() => p.onDelete(n.path)}>
            <ITrash />
          </button>
        </span>
      </div>
    )
  }

  const walk = (ns: TreeNode[], depth: number): JSX.Element[] =>
    ns.flatMap((n) => [row(n, depth), ...(n.dir && p.expanded.has(n.path) ? walk(n.children ?? [], depth + 1) : [])])

  const query = q.trim().toLowerCase()
  return (
    <aside className="pane-left">
      <div className="tree-head">
        <span className="tree-title">프로젝트 파일</span>
        <span className="grow" />
        <button className="icon-btn" title="새 파일" aria-label="새 파일" onClick={() => p.onNew('', false)}>
          <INewFile />
        </button>
        <button className="icon-btn" title="새 폴더" aria-label="새 폴더" onClick={() => p.onNew('', true)}>
          <INewFolder />
        </button>
      </div>
      <label className="search">
        <ISearch />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="파일명 검색" aria-label="파일명 검색" />
      </label>
      <nav className="tree">
        {query ? flat.filter((n) => n.path.toLowerCase().includes(query)).map((n) => row(n, 0, n.path)) : walk(p.tree, 0)}
      </nav>
      <div className="tree-foot">파일 이동은 드래그 대신 AI 대화로 요청합니다. 이름 변경도 참조 검사를 거친 변경안으로 만들어집니다.</div>
    </aside>
  )
}
