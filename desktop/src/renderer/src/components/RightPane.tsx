import { useEffect, useMemo, useRef, useState } from 'react'
import { DiffEditor, Editor, type DiffOnMount, type OnMount } from '@monaco-editor/react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ActionResult, Item, Mapping, MappingPreview, PublicState, TreeNode } from '@shared/types'
import { buildSegments, existsAlready, locateQuote } from '@shared/text'
import { FILE_REVIEWABLE, fileReview, isChange, reviewCounts, type FileReview } from '@shared/review'
import { REL, STATUS, basename, relLabel } from '../status'
import { editorBaseOptions, embeddedEditorOptions, languageOf } from '../monaco'
import { IClose } from './Icons'

type Run = (p: Promise<ActionResult>, retry?: () => Promise<ActionResult>) => Promise<ActionResult>

const isNewFile = (m: Mapping) => !!m.file && !m.moveTo && m.oldText === '' && m.relation !== '중복' && m.relation !== '판단 필요'

/** git(GitHub split view)처럼 왼쪽 원본 · 오른쪽 변경 후를 나란히 보여주는 diff */
export interface EditRegion {
  prefix: string
  suffix: string
}

/** 변경 후 내용에서 이 항목이 바꾸는 구간(앞뒤를 뺀 부분)만 편집 가능하게 하기 위한 경계 */
export function editRegion(original: string, m: Mapping): EditRegion | null {
  if (m.oldText === '') {
    if (original === '') return { prefix: '', suffix: '' }
    return { prefix: original + (original.endsWith('\n') ? '' : '\n'), suffix: '' }
  }
  const i = original.indexOf(m.oldText)
  if (i < 0 || original.indexOf(m.oldText, i + 1) >= 0) return null
  return { prefix: original.slice(0, i), suffix: original.slice(i + m.oldText.length) }
}

/**
 * git(GitHub split view)처럼 왼쪽 원본 · 오른쪽 변경 후를 나란히 보여주는 diff.
 * editable이면 오른쪽(변경 후)에서 바로 고칠 수 있다. 단, 이 항목이 바꾸는 구간 밖은 고칠 수 없다.
 */
/** 반영된 항목: 현재 파일(modified)에서 이 항목이 쓴 구간 */
export function appliedRegion(modified: string, m: Mapping): EditRegion | null {
  if (!m.newText) return null
  const i = modified.indexOf(m.newText)
  if (i < 0 || modified.indexOf(m.newText, i + 1) >= 0) return null
  return { prefix: modified.slice(0, i), suffix: modified.slice(i + m.newText.length) }
}

function GitDiff({ path, language, original, modified, isNew, editable, region, onEdit, lockReason, live: liveFile }: {
  path: string
  language: string
  original: string
  modified: string
  isNew: boolean
  editable: boolean
  region: EditRegion | null
  onEdit: (newText: string) => void
  /** 편집할 수 없을 때 이유 */
  lockReason?: string
  /** 반영된 항목: 고치면 파일에 바로 저장 */
  live?: boolean
}) {
  const [wide, setWide] = useState(false)
  const [stat, setStat] = useState<{ add: number; del: number } | null>(null)
  const [warn, setWarn] = useState('')
  const [mod, setMod] = useState(modified)
  const focused = useRef(false)
  const lastValid = useRef(modified)
  const applying = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<string | null>(null)
  const live = useRef({ region, onEdit, editable })
  // 입력 중에는 잠깐 구간을 못 찾는 순간(저장 직후 새로고침)이 있어도 직전 구간을 유지한다
  live.current = { region: region ?? (focused.current ? live.current.region : null), onEdit, editable }
  const canEdit = editable && !!live.current.region

  // 편집 중이 아닐 때만 바깥(저장된 변경안)의 내용으로 맞춘다
  useEffect(() => {
    if (!focused.current) {
      setMod(modified)
      lastValid.current = modified
    }
  }, [modified])

  useEffect(() => {
    if (!wide) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setWide(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wide])

  useEffect(() => () => flush(), [])

  function flush(): void {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (pending.current !== null) {
      live.current.onEdit(pending.current)
      pending.current = null
    }
  }

  const onMount: DiffOnMount = (ed) => {
    const update = () => {
      let add = 0
      let del = 0
      for (const c of ed.getLineChanges() ?? []) {
        if (c.modifiedEndLineNumber > 0) add += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1
        if (c.originalEndLineNumber > 0) del += c.originalEndLineNumber - c.originalStartLineNumber + 1
      }
      setStat({ add, del })
    }
    ed.onDidUpdateDiff(update)
    update()

    const me = ed.getModifiedEditor()
    me.onDidFocusEditorText(() => {
      focused.current = true
    })
    me.onDidBlurEditorText(() => {
      focused.current = false
      flush()
    })
    me.onDidChangeModelContent(() => {
      if (applying.current) return
      const { region: r, editable: ok } = live.current
      if (!ok || !r) return
      const v = me.getValue()
      if (!v.startsWith(r.prefix) || !v.endsWith(r.suffix) || v.length < r.prefix.length + r.suffix.length) {
        // 변경 구간 밖을 고쳤다 → 직전 상태로 되돌린다
        applying.current = true
        const pos = me.getPosition()
        me.setValue(lastValid.current)
        if (pos) me.setPosition(pos)
        applying.current = false
        setWarn('이 항목이 바꾸는 구간(초록색)만 수정할 수 있습니다.')
        setTimeout(() => setWarn(''), 2500)
        return
      }
      lastValid.current = v
      setMod(v)
      pending.current = v.slice(r.prefix.length, v.length - r.suffix.length)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(flush, 500)
    })
  }

  const body = (
    <div className={`gitdiff${wide ? ' wide' : ''}`}>
      <div className="gitdiff-head">
        <span className="mono gitdiff-path" title={path}>{path}</span>
        {isNew && <span className="chip" style={{ background: '#e6ffec', color: '#1a7f37' }}>새 파일</span>}
        {stat && (
          <span className="gitdiff-stat">
            <span className="add">+{stat.add}</span>
            <span className="del">−{stat.del}</span>
          </span>
        )}
        <span className="grow" />
        {warn && <span style={{ color: '#cf222e', fontSize: 12 }}>{warn}</span>}
        <button className="btn ghost sm" onClick={() => { flush(); setWide(!wide) }}>{wide ? '닫기 (Esc)' : '넓게 보기'}</button>
      </div>
      <div className="gitdiff-cols">
        <span>원본{isNew ? ' (없음)' : ' · 읽기 전용'}</span>
        <span>
          변경 후
          {canEdit ? (
            <b style={{ color: '#1a7f37', fontWeight: 600 }}>{liveFile ? ' · 초록색 구간을 고치면 파일에 바로 저장됩니다' : ' · 초록색 구간을 바로 수정할 수 있습니다'}</b>
          ) : lockReason ? (
            ` · ${lockReason}`
          ) : (
            ''
          )}
        </span>
      </div>
      <div className="gitdiff-body">
        <DiffEditor
          height={wide ? '100%' : 440}
          language={language}
          original={original}
          modified={mod}
          theme="docsync"
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          onMount={onMount}
          options={{
            ...(wide ? editorBaseOptions : embeddedEditorOptions),
            readOnly: !canEdit,
            originalEditable: false,
            renderSideBySide: true,
            useInlineViewWhenSpaceIsLimited: false,
            enableSplitViewResizing: true,
            renderIndicators: true,
            renderMarginRevertIcon: false,
            ignoreTrimWhitespace: false,
            renderOverviewRuler: false,
            glyphMargin: false,
            folding: false,
            lineDecorationsWidth: 6,
            hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 }
          }}
        />
      </div>
    </div>
  )
  return wide ? (
    <>
      <div className="gitdiff-placeholder muted small">넓게 보기로 열려 있습니다.</div>
      <div className="overlay" style={{ alignItems: 'stretch', padding: 24 }} onMouseDown={(e) => e.target === e.currentTarget && setWide(false)}>
        {body}
      </div>
    </>
  ) : (
    body
  )
}

/** 새 문서 위치: AI가 추천한 경로를 보여주고 바꿀 수 있게 한다 */
function NewFilePath({ item, m, editable, run }: { item: Item; m: Mapping; editable: boolean; run: Run }) {
  const [v, setV] = useState(m.file ?? '')
  useEffect(() => setV(m.file ?? ''), [m.file])
  return (
    <div className="note info col" style={{ gap: 8 }}>
      <span style={{ fontWeight: 600, color: 'var(--ink)' }}>새 문서 위치 추천</span>
      <span className="muted" style={{ fontSize: 13 }}>{m.reason}</span>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="field" style={{ minWidth: 300, flex: '1 1 300px', background: '#fff' }}>
          <input className="mono" value={v} disabled={!editable} onChange={(e) => setV(e.target.value)} aria-label="새 문서 경로" />
        </span>
        <button className="btn sm" disabled={!editable || !v.trim() || v.trim() === m.file} onClick={() => run(window.api.setNewFilePath(item.id, m.id, v.trim()))}>
          위치 변경
        </button>
      </div>
    </div>
  )
}

/** diff를 직접 고칠 수 없는 이유 (화면 안내용) */
function lockReasonOf(item: Item, m: Mapping, pv: MappingPreview): string {
  if (m.rejected) return '기존 유지로 결정한 파일입니다 · 고치려면 결정을 취소하세요'
  if (m.moveTo) return '문서 이동은 여기서 고칠 수 없습니다'
  if (item.status === 'rejected') return '모든 파일을 기존 유지로 결정한 항목입니다 · 고치려면 파일 결정을 취소하세요'
  if (item.status === 'confirmed') return '이미 존재로 표시된 항목은 수정할 수 없습니다'
  if (item.status === 'applied' && !pv.appliedEdit) return '반영 후 파일이 바뀌어 이 항목의 구간을 찾을 수 없습니다 · 파일 보기에서 직접 수정하세요'
  if (!pv.valid) return '기준 문구를 현재 파일에서 찾을 수 없어 수정할 수 없습니다 · 채팅으로 다시 만들어 달라고 요청하세요'
  return '이 항목의 변경 구간을 특정할 수 없어 수정할 수 없습니다'
}

export const REVIEW: Record<FileReview, { label: string; fg: string; bg: string; dot: string }> = {
  adopted: { label: '제안 채택', fg: '#1f6fc5', bg: '#e3eefa', dot: '#1f6fc5' },
  kept: { label: '기존 유지', fg: '#6b6a66', bg: '#ebebe9', dot: '#b4b4b0' },
  held: { label: '보류', fg: '#7a5a00', bg: '#fbf3db', dot: '#d9a400' },
  pending: { label: '검토 전', fg: '#b9382f', bg: '#fbe4e4', dot: '#e0574c' }
}

/** 매핑된 파일 하나의 결정 막대: 기존 유지 · 제안 채택 · 보류 */
function FileReviewBar({ item, m, run }: { item: Item; m: Mapping; run: Run }) {
  const r = fileReview(m)
  const can = FILE_REVIEWABLE.includes(item.status)
  const act = (a: 'adopt' | 'keep' | 'hold' | 'reset') => run(window.api.fileAction(item.id, m.id, a))
  const c = reviewCounts(item)
  if (!can) {
    if (r !== 'kept' && r !== 'held') return null
    return <div className="note file-review">{REVIEW[r].label}로 결정해 이 파일은 {item.status === 'applied' ? '반영하지 않았습니다' : '반영하지 않습니다'}.</div>
  }
  const pick = (a: 'adopt' | 'keep' | 'hold', key: FileReview, label: string, primary = false) => (
    <button className={`btn sm${r === key ? ' on' : primary ? ' primary' : ''}`} aria-pressed={r === key} onClick={() => act(r === key ? 'reset' : a)} title={r === key ? '다시 누르면 결정을 취소합니다' : undefined}>
      {r === key && '✓ '}{label}
    </button>
  )
  return (
    <div className="file-review row">
      <span className="chip" style={{ background: REVIEW[r].bg, color: REVIEW[r].fg }}>{REVIEW[r].label}</span>
      <span className="muted small">
        {r === 'adopted' ? '반영할 때 이 파일을 수정합니다' : r === 'kept' ? '이 파일은 지금 내용을 유지합니다' : r === 'held' ? '지금은 반영하지 않고 나중에 다시 봅니다' : '아래 diff를 확인하고 결정하세요 · 직접 고친 뒤 채택하면 고친 내용으로 반영됩니다'}
        {c.total > 1 && ` · 파일 ${c.total}개 중 검토 ${c.total - c.pending}`}
      </span>
      <span className="grow" />
      {pick('keep', 'kept', '기존 유지')}
      {pick('adopt', 'adopted', '제안 채택', true)}
      {pick('hold', 'held', '보류')}
    </div>
  )
}

/** 문서에 이미 있는 문구를 앞뒤 두 줄과 함께 강조해서 보여준다 */
function ExistingExcerpt({ text, quote }: { text: string; quote: string }) {
  const r = quote ? locateQuote(text, quote) : null
  if (!r) {
    return (
      <div className="col" style={{ gap: 4 }}>
        {quote && <div className="exists-excerpt"><mark>{quote}</mark></div>}
        <span className="muted small">문서에서 이 문구를 그대로 찾지 못했습니다. 문서를 열어 같은 의미인지 확인하세요.</span>
      </div>
    )
  }
  const before = text.slice(0, r[0]).split('\n')
  const after = text.slice(r[1]).split('\n')
  const head = before.slice(-3).join('\n').replace(/^\n+/, '')
  const tail = after.slice(0, 3).join('\n').replace(/\n+$/, '')
  return (
    <div className="exists-excerpt">
      {before.length > 3 && <span>…{'\n'}</span>}
      {head}
      <mark>{text.slice(r[0], r[1])}</mark>
      {tail}
      {after.length > 3 && <span>{'\n'}…</span>}
    </div>
  )
}

// ───────── 항목 보기 ─────────


function ItemView({ st, item, mappingId, setMapping, run, onOpenSource, onOpenFile, fsVer, docFiles }: {
  st: PublicState; item: Item; mappingId: string | null; setMapping: (id: string) => void; run: Run
  onOpenSource: (id: string) => void; onOpenFile: (p: string) => void; fsVer: number; docFiles: string[]
}) {
  const [previews, setPreviews] = useState<MappingPreview[]>([])
  const m = item.mappings.find((x) => x.id === mappingId) ?? item.mappings[0]
  const s = STATUS[item.status]
  const sig = JSON.stringify([item.status, item.mappings.map((x) => [x.id, x.file, x.newText, x.stale])])

  useEffect(() => {
    let alive = true
    window.api.previews(item.id).then((p) => alive && setPreviews(p))
    return () => {
      alive = false
    }
  }, [item.id, sig, fsVer])

  const pv = previews.find((p) => p.mappingId === m?.id)
  const editable = ['pending', 'approved', 'rereview', 'excluded', 'held'].includes(item.status)
  const act = (a: Parameters<typeof window.api.itemAction>[1]) => run(window.api.itemAction(item.id, a))
  const rc = reviewCounts(item)
  const srcName = (id: string) => st.sources.find((x) => x.id === id)?.name ?? ''

  return (
    <div className="doc">
      <div className="col" style={{ gap: 8 }}>
        <span className="muted small">{item.kind === 'move' ? '이동 변경안' : '추출 항목'} #{item.no}</span>
        <h1>{item.title}</h1>
        <div className="row" style={{ flexWrap: 'wrap', fontSize: 13 }}>
          <span className="badge" style={{ color: s.fg, background: s.bg }}>{s.label}</span>
          {!item.confirmed && <span className="chip" style={{ background: '#fbf3db', color: '#7a5a00' }}>회의에서 결정되지 않은 내용 · 기본으로 반영하지 않음</span>}
          {rc.total > 0 && FILE_REVIEWABLE.includes(item.status) && (
            <span className="muted">파일 검토 {rc.total - rc.pending}/{rc.total}{rc.adopted ? ` · 채택 ${rc.adopted}` : ''}{rc.kept ? ` · 기존 유지 ${rc.kept}` : ''}{rc.held ? ` · 보류 ${rc.held}` : ''}</span>
          )}
          <span className="grow" />
          {item.status === 'approved' && <button className="btn primary sm" onClick={() => run(window.api.applyItems([item.id]))}>반영</button>}
          {item.status === 'applied' && <button className="btn sm" onClick={() => act('undo')}>되돌리기</button>}
        </div>
        {item.status === 'confirmed' && existsAlready(item) && <div className="note" style={{ background: '#ddf1ec', color: '#0f7b6c' }}>문서에 이미 있는 내용입니다. 변경하지 않으며, 원문에도 "이미 존재"로 표시됩니다.</div>}
        {item.conflictNote && <div className="note warn">{item.conflictNote}</div>}
        {item.status === 'rereview' && item.rereviewReason && <div className="note err">{item.rereviewReason}</div>}
        {item.notes?.map((n, i) => <div key={i} className="note info">{n}</div>)}
      </div>

      {item.kind === 'content' && (
        <div className="col" style={{ gap: 6 }}>
          <span className="label">원문 근거</span>
          {item.evidence.length === 0 && <span className="muted small">원문에서 근거 위치를 찾지 못했습니다.</span>}
          {item.evidence.map((e, i) => (
            <button key={i} className="quote" onClick={() => onOpenSource(e.sourceId)}>
              <span className="muted small">{srcName(e.sourceId)}</span>
              <span>{e.quote}</span>
            </button>
          ))}
        </div>
      )}

      <div>
        <div className="tabs">
          {item.mappings.map((x) => (
            <button key={x.id} className={`tab${x.id === m?.id ? ' active' : ''}${isChange(x) && fileReview(x) === 'kept' ? ' rejected' : ''}`} onClick={() => setMapping(x.id)}>
              {isChange(x) && <span className="review-dot" title={REVIEW[fileReview(x)].label} style={{ background: REVIEW[fileReview(x)].dot }} />}
              <span className="tab-file">{x.moveTo ? `${basename(x.file)} → ${x.moveTo}` : basename(x.file)}</span>
              <span className="chip" style={{ background: REL[x.relation].bg, color: REL[x.relation].fg }}>{relLabel(x.relation)}</span>
              {x.stale && <span className="chip" style={{ background: '#fbe4e4', color: '#b9382f' }}>기준 변경</span>}
              {isNewFile(x) && previews.find((p) => p.mappingId === x.id)?.original === '' && <span className="chip" style={{ background: '#e6f4ea', color: '#2b6b45' }}>새 문서</span>}
            </button>
          ))}
        </div>

        {m && (
          <div className="col" style={{ gap: 12, paddingTop: 12 }}>
            <div className="col" style={{ gap: 4 }}>
              <span style={{ fontSize: 13 }}>
                <span className="mono">{m.moveTo ? `${m.file} → ${m.moveTo}` : m.file ?? '대상 없음'}</span>
                {m.section && <span className="muted"> · {m.section}</span>}
              </span>
              <span className="muted" style={{ fontSize: 13 }}>분류 이유 · {m.reason}</span>
              {pv && !pv.valid && pv.problem && <span style={{ fontSize: 13, color: 'var(--red)' }}>{pv.problem}</span>}
            </div>

            {isChange(m) && <FileReviewBar item={item} m={m} run={run} />}

            {isNewFile(m) && pv?.original === '' && <NewFilePath item={item} m={m} editable={editable && !m.rejected} run={run} />}

            {isChange(m) && pv && !(item.status === 'applied' && (m.rejected || m.held)) && (
              <GitDiff
                key={`${item.id}-${m.id}`}
                path={m.moveTo ? `${m.file} → ${m.moveTo}` : m.file ?? ''}
                language={languageOf(m.moveTo ?? m.file ?? '')}
                original={pv.original}
                modified={pv.modified}
                isNew={isNewFile(m) && pv.original === ''}
                editable={(editable || !!pv.appliedEdit) && pv.valid && !m.moveTo && !m.rejected}
                region={!pv.valid || m.moveTo ? null : pv.appliedEdit ? appliedRegion(pv.modified, m) : editRegion(pv.original, m)}
                live={!!pv.appliedEdit}
                lockReason={lockReasonOf(item, m, pv)}
                onEdit={(t) => run(window.api.editMapping(item.id, m.id, t))}
              />
            )}

            {m.relation === '중복' && (
              <div className="exists-box">
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <span className="chip" style={{ background: REL['중복'].bg, color: REL['중복'].fg }}>이미 존재</span>
                  <span style={{ fontSize: 13 }}>
                    <span className="mono">{m.file}</span>에 같은 내용이 있어 변경하지 않습니다.
                  </span>
                  <span className="grow" />
                  {m.file && <button className="btn ghost sm" onClick={() => onOpenFile(m.file as string)}>문서 열기</button>}
                </div>
                {pv && <ExistingExcerpt text={pv.original} quote={m.existing} />}
                {item.status === 'pending' && existsAlready(item) && (
                  <button className="btn primary sm" style={{ alignSelf: 'flex-start' }} onClick={() => act('confirmDup')}>이미 존재로 표시</button>
                )}
              </div>
            )}

            {(m.relation === '판단 필요' || !m.file) && (
              <TargetPicker item={item} m={m} docFiles={docFiles} run={run} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function TargetPicker({ item, m, docFiles, run }: { item: Item; m: Mapping; docFiles: string[]; run: Run }) {
  const [file, setFile] = useState(m.file ?? '')
  const [newPath, setNewPath] = useState('')
  const go = (p: string) => run(window.api.setMappingFile(item.id, m.id, p), () => window.api.setMappingFile(item.id, m.id, p))
  return (
    <div className="col" style={{ gap: 10 }}>
      {!m.file && <div className="note info" style={{ border: '1px dashed #d3d1cb', background: '#fff' }}>대상 없음 — 기존 파일을 지정하거나 새 문서를 만들면 그 파일 기준으로 변경안을 다시 만듭니다.</div>}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="field" style={{ minWidth: 260 }}>
          <select value={file} onChange={(e) => setFile(e.target.value)} aria-label="기존 파일 지정">
            <option value="">기존 파일 선택…</option>
            {docFiles.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </span>
        <button className="btn sm" disabled={!file} onClick={() => go(file)}>이 파일로 지정</button>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="field" style={{ minWidth: 260 }}>
          <input className="mono" placeholder="새 문서 경로 예: docs/auth/social-login.md" value={newPath} onChange={(e) => setNewPath(e.target.value)} />
        </span>
        <button className="btn sm" disabled={!newPath.trim()} onClick={() => go(newPath.trim())}>새 문서로 만들기</button>
      </div>
    </div>
  )
}

// ───────── 파일 편집 ─────────

/** 문서 안 상대 경로를 프로젝트 기준 경로로 바꾼다 */
function resolveRel(from: string, href: string): string {
  const parts = from.split('/').slice(0, -1)
  for (const seg of href.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/** 노션처럼 읽기 좋은 Markdown 미리보기 */
function MarkdownView({ path, text, onOpenFile }: { path: string; text: string; onOpenFile: (p: string) => void }) {
  return (
    <div className="md-view">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const h = href ?? ''
            if (/^https?:/i.test(h)) return <a href={h} target="_blank" rel="noreferrer">{children}</a>
            if (h.startsWith('#')) return <a href={h}>{children}</a>
            const target = resolveRel(path, decodeURI(h.split('#')[0]))
            return (
              <a href="#" title={target} onClick={(e) => { e.preventDefault(); onOpenFile(target) }}>
                {children}
              </a>
            )
          },
          // 로컬 이미지는 앱 보안 정책상 표시하지 않고 대체 글만 보여준다
          img: ({ alt, src }) => (/^https?:/i.test(String(src ?? '')) ? <img src={String(src)} alt={alt ?? ''} /> : <span className="md-img">[이미지] {alt || String(src ?? '')}</span>)
        }}
      >
        {text.replace(/<!--[\s\S]*?-->\n?/g, '')}
      </Markdown>
    </div>
  )
}

function FileView({ path, fsVer, scope, run, onOpenFile, onDirty }: { path: string; fsVer: number; scope: string[]; run: Run; onOpenFile: (p: string) => void; onDirty: (path: string, dirty: boolean) => void }) {
  const isMd = /\.(md|markdown|mdx)$/i.test(path)
  const [mode, setMode] = useState<'preview' | 'edit'>(isMd ? 'preview' : 'edit')
  useEffect(() => setMode(/\.(md|markdown|mdx)$/i.test(path) ? 'preview' : 'edit'), [path])
  const [text, setText] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  /** 편집 중에 다른 곳에서 바뀐 파일 내용 (충돌 안내용) */
  const [outside, setOutside] = useState<string | null>(null)
  const dirty = text !== saved
  const ref = useRef({ text, saved, path })
  ref.current = { text, saved, path }

  useEffect(() => {
    let alive = true
    setText(null)
    setSaved(null)
    setOutside(null)
    window.api.readFile(path).then((c) => {
      if (!alive) return
      setSaved(c)
      setText(c)
    })
    return () => {
      alive = false
    }
  }, [path])

  // 외부에서 파일이 바뀌면 편집 중이 아닐 때만 다시 불러온다
  useEffect(() => {
    if (!fsVer) return
    window.api.readFile(path).then((c) => {
      const cur = ref.current
      if (cur.path !== path) return
      if (cur.text !== cur.saved) {
        // 편집 중이면 덮어쓰지 않고 바뀌었다는 사실만 알린다
        setOutside(c !== cur.saved ? c : null)
        return
      }
      setSaved(c)
      setText(c)
      setOutside(null)
    })
  }, [fsVer])

  const save = async (force = false) => {
    const { text: t, path: p, saved: base } = ref.current
    if (t === null) return
    const r = await run(window.api.writeFile(p, t, force ? null : base))
    if (r.ok) {
      setSaved(t)
      setOutside(null)
    } else if (r.conflict) {
      setOutside(await window.api.readFile(p))
    }
  }
  const takeOutside = () => {
    if (outside === null) return
    setSaved(outside)
    setText(outside)
    setOutside(null)
  }

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save())
  }

  // 탭을 닫을 때 저장 안 한 수정이 있는지 확인할 수 있게 알린다
  useEffect(() => {
    onDirty(path, dirty)
  }, [path, dirty, onDirty])
  useEffect(() => () => onDirty(path, false), [path, onDirty])

  const inScope = !scope.length || scope.some((s) => path === s || path.startsWith(s + '/'))
  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="row" style={{ padding: '14px 20px 10px', borderBottom: '1px solid var(--border)' }}>
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <span className="muted small mono">{path}</span>
          <span style={{ fontSize: 18, fontWeight: 700 }}>{basename(path)}{dirty ? ' •' : ''}</span>
        </div>
        <span className="grow" />
        {!inScope && <span className="chip" style={{ background: '#f1f1ef', color: '#6b6a66' }}>반영 범위 밖</span>}
        {isMd && (
          <div className="seg">
            <button className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>미리보기</button>
            <button className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')} title="직접 고치면 반영된 항목의 자동 되돌리기가 막힐 수 있습니다">편집</button>
          </div>
        )}
        {(mode === 'edit' || dirty) && <button className="btn primary sm" disabled={!dirty} onClick={() => save()}>저장 (Ctrl+S)</button>}
      </div>
      {outside !== null && dirty && (
        <div className="note warn row" style={{ margin: '10px 20px 0', flexWrap: 'wrap', gap: 8 }}>
          <span className="grow" style={{ minWidth: 220 }}>편집하는 동안 이 파일이 다른 곳(항목 반영·외부 편집기 등)에서 바뀌었습니다. 그대로 저장하면 그 변경이 사라지고, 반영한 항목의 되돌리기가 막힐 수 있습니다.</span>
          <button className="btn sm" onClick={takeOutside}>바뀐 내용 불러오기 (내 수정 버림)</button>
          <button className="btn sm" onClick={() => save(true)}>내 수정으로 덮어쓰기</button>
        </div>
      )}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: mode === 'preview' ? 'auto' : 'hidden' }}>
        {text === null ? (
          <div className="empty muted">파일을 불러오는 중이거나 텍스트 파일이 아닙니다.</div>
        ) : mode === 'preview' ? (
          <MarkdownView path={path} text={text} onOpenFile={onOpenFile} />
        ) : (
          <Editor
            key={path}
            height="100%"
            language={languageOf(path)}
            value={text}
            theme="docsync"
            options={editorBaseOptions}
            onMount={onMount}
            onChange={(v) => setText(v ?? '')}
          />
        )}
      </div>
    </div>
  )
}

// ───────── 원문 (형광펜) ─────────

function SourceView({ st, sourceId, onSelectItem }: { st: PublicState; sourceId: string; onSelectItem: (id: string) => void }) {
  const [active, setActive] = useState<number | null>(null)
  const src = st.sources.find((s) => s.id === sourceId)
  const segs = useMemo(() => {
    if (!src) return []
    const ranges = st.items.flatMap((it) => it.evidence.filter((e) => e.sourceId === src.id).map((e) => ({ start: e.start, end: e.end, itemId: it.id })))
    return buildSegments(src.text, ranges)
  }, [src, st.items])
  useEffect(() => setActive(null), [sourceId])
  if (!src) return <div className="empty muted">입력 자료가 없습니다.</div>

  // 상태 분류별 칠하기. 한 구간에 여러 항목이 걸리면 각 항목 상태를 줄무늬로 함께 보여준다
  const CAT = {
    red: { bg: '#fcd9d6', color: '#b9382f' },
    appr: { bg: '#e3eefa', color: '#1f6fc5' },
    done: { bg: '#d4e6f7', color: '#1f6fc5' },
    exists: { bg: '#cdeee2', color: '#0f7b6c' },
    gray: { bg: '#ebebe9', color: 'var(--muted)' }
  } as const
  const catOf = (s: string): keyof typeof CAT =>
    ['pending', 'rereview'].includes(s) ? 'red' : s === 'approved' ? 'appr' : s === 'applied' ? 'done' : s === 'confirmed' ? 'exists' : 'gray'
  const files = (i: Item) => [...new Set(i.mappings.map((m) => basename(m.file)).filter((f) => f !== '대상 없음'))].join(', ')
  const labelOf = (i: Item) => (i.status === 'confirmed' ? `이미 존재${files(i) ? ` · ${files(i)}` : ''}` : STATUS[i.status].label)
  const look = (ids: string[]) => {
    const linked = st.items.filter((i) => ids.includes(i.id)).sort((a, b) => a.no - b.no)
    const cats = [...new Set(linked.map((i) => catOf(i.status)))]
    const anyAppr = cats.includes('appr')
    const under = anyAppr ? { textDecoration: 'underline dashed #5b9be0 2px', textUnderlineOffset: 5 } : {}
    let style: React.CSSProperties
    if (cats.length === 1) {
      const c = cats[0]
      style = c === 'appr' ? { ...under } : c === 'gray' ? { background: CAT.gray.bg, color: 'var(--muted)' } : { background: CAT[c].bg }
    } else {
      const order = (['red', 'appr', 'done', 'exists', 'gray'] as const).filter((c) => cats.includes(c))
      const w = 8
      const stops = order.map((c, i) => `${CAT[c].bg} ${i * w}px ${(i + 1) * w}px`).join(', ')
      style = { background: `repeating-linear-gradient(135deg, ${stops})`, ...under }
    }
    const label =
      linked.length === 1
        ? [{ text: labelOf(linked[0]), color: CAT[catOf(linked[0].status)].color }]
        : linked.map((i) => ({ text: `#${i.no} ${labelOf(i)}`, color: CAT[catOf(i.status)].color }))
    return { style, label }
  }

  const activeSeg = active !== null ? segs[active] : null
  return (
    <div className="doc">
      <div className="col src-section" style={{ gap: 6 }}>
        <h1>{src.name}</h1>
      </div>
      <div className="col src-section" style={{ gap: 8 }}>
        <span className="label">표시 안내</span>
      <div className="legend">
        <span><span className="hl" style={{ background: '#fcd9d6', color: 'var(--ink)' }}>검토 대기·재검토</span></span>
        <span><span className="hl" style={{ textDecoration: 'underline dashed #5b9be0 2px', textUnderlineOffset: 5, color: 'var(--ink)' }}>반영 대기</span></span>
        <span><span className="hl" style={{ background: '#d4e6f7', color: 'var(--ink)' }}>반영 완료</span></span>
        <span><span className="hl" style={{ background: '#cdeee2', color: 'var(--ink)' }}>이미 존재</span></span>
        <span><span className="hl" style={{ background: '#ebebe9' }}>기존 유지·보류·제외</span></span>
        <span><span className="hl" style={{ background: 'repeating-linear-gradient(135deg, #fcd9d6 0px 8px, #d4e6f7 8px 16px)', color: 'var(--ink)' }}>줄무늬</span> 여러 항목이 걸린 구간 (항목별 상태 표시)</span>
        <span>칠하지 않은 글 · 연결 항목 없음</span>
      </div>
      </div>
      {activeSeg && (
        <div className="seg-panel">
          {st.items.filter((i) => activeSeg.itemIds.includes(i.id)).map((it) => (
            <button key={it.id} className="plink" onClick={() => onSelectItem(it.id)}>
              <span className="muted" style={{ fontWeight: 600 }}>#{it.no}</span>
              <span className="grow">{it.title} <span className="muted">· {it.mappings.map((m) => basename(m.file)).join(', ')}</span></span>
              <span className="badge" style={{ color: STATUS[it.status].fg, background: STATUS[it.status].bg }}>{STATUS[it.status].label}</span>
            </button>
          ))}
        </div>
      )}
      <span className="label" style={{ marginBottom: -8 }}>본문</span>
      <div className="source-text">
        {segs.map((sg, i) => {
          if (!sg.itemIds.length) return <span key={i}>{sg.text}</span>
          const l = look(sg.itemIds)
          // 항목이 하나면 바로 그 항목 탭으로, 여러 개면 고를 수 있게 목록을 띄운다
          const go = () => (sg.itemIds.length === 1 ? onSelectItem(sg.itemIds[0]) : setActive(active === i ? null : i))
          const one = sg.itemIds.length === 1 ? st.items.find((x) => x.id === sg.itemIds[0]) : undefined
          return (
            <span key={i}>
              <span
                role="button"
                tabIndex={0}
                className={`hl${active === i ? ' active' : ''}`}
                style={{ ...l.style, cursor: 'pointer' }}
                title={one ? `#${one.no} ${one.title} 열기` : `연결된 항목 ${sg.itemIds.length}개 · 눌러서 고르기`}
                onClick={go}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go())}
              >
                {sg.text}
              </span>
              <span className="hlab">
                {l.label.map((x, j) => (
                  <span key={j} style={{ color: x.color }}>{j ? ' · ' : ''}{x.text}</span>
                ))}
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

// ───────── 빈 화면 ─────────

function EmptyView() {
  return (
    <div className="empty">
      <h1 style={{ margin: 0, fontSize: 24 }}>작업 흐름</h1>
      <p className="muted" style={{ margin: 0, lineHeight: '22px' }}>자료를 보내면 원문 탭이 열리고, 추출 항목·파일을 누를 때마다 브라우저처럼 탭이 추가됩니다. 탭은 ✕로 닫을 수 있습니다.</p>
      {[
        '상단에서 API 키를 입력하고 반영 범위를 확인합니다 (트리의 ◎ 버튼으로 변경).',
        '회의록·기획안을 붙여넣거나 파일을 첨부해 보냅니다.',
        '항목을 선택하면 매핑 파일이 강조되고 파일별 diff가 보입니다.',
        '매핑된 파일마다 기존 유지 · 제안 채택 · 보류를 고릅니다. diff를 직접 고친 뒤 채택하면 고친 내용이 반영됩니다.',
        '추가 자료를 보내면 기존 항목과 합쳐서 분석합니다.',
        '모든 파일을 확인하면 항목을 반영합니다. 반영한 항목은 언제든 항목 단위로 되돌릴 수 있습니다.'
      ].map((t, i) => (
        <div key={i} className="step"><span className="step-n">{i + 1}</span><span>{t}</span></div>
      ))}
    </div>
  )
}

/** 오른쪽 화면의 탭 하나: 원문 · 추출 항목 · 파일 */
export type Tab =
  | { kind: 'item'; itemId: string; mappingId: string | null }
  | { kind: 'file'; path: string }
  | { kind: 'source'; sourceId: string }

export type Sel = Tab | { kind: 'none' }

export const tabKey = (t: Tab): string => (t.kind === 'item' ? `item:${t.itemId}` : t.kind === 'file' ? `file:${t.path}` : `source:${t.sourceId}`)

const KIND_LABEL = { source: '원문', item: '항목', file: '문서' } as const

export default function RightPane({ st, tabs, activeKey, onActivate, onCloseTab, onOpen, onUpdateTab, onDirty, dirtyPaths, run, fsVer, tree, onSelectItem }: {
  st: PublicState
  tabs: Tab[]
  activeKey: string | null
  onActivate: (key: string) => void
  onCloseTab: (key: string) => void
  /** 탭을 열거나, 이미 열려 있으면 그 탭으로 이동 */
  onOpen: (t: Tab) => void
  onUpdateTab: (key: string, t: Tab) => void
  onDirty: (path: string, dirty: boolean) => void
  dirtyPaths: Set<string>
  run: Run
  fsVer: number
  tree: TreeNode[]
  onSelectItem: (id: string) => void
}) {
  const docFiles = useMemo(() => {
    const out: string[] = []
    const visit = (ns: TreeNode[]) => ns.forEach((n) => (n.dir ? visit(n.children ?? []) : /\.(md|markdown|mdx|txt)$/i.test(n.path) && basename(n.path) !== 'docs_map.md' && out.push(n.path)))
    visit(tree)
    return out
  }, [tree])
  const barRef = useRef<HTMLDivElement>(null)

  // 활성 탭이 탭 막대에서 보이도록 스크롤
  useEffect(() => {
    barRef.current?.querySelector('.ptab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeKey, tabs.length])

  const labelOf = (t: Tab): { text: string; title: string; color?: string } => {
    if (t.kind === 'source') {
      const name = st.sources.find((s) => s.id === t.sourceId)?.name ?? '입력 자료'
      return { text: name, title: `입력 자료 원문 · ${name}` }
    }
    if (t.kind === 'item') {
      const it = st.items.find((i) => i.id === t.itemId)
      return it ? { text: `#${it.no} ${it.title}`, title: `#${it.no} ${it.title} · ${STATUS[it.status].label}`, color: STATUS[it.status].fg } : { text: '항목', title: '항목' }
    }
    return { text: `${basename(t.path)}${dirtyPaths.has(t.path) ? ' •' : ''}`, title: t.path }
  }

  const body = (t: Tab) => {
    if (t.kind === 'item') {
      const item = st.items.find((i) => i.id === t.itemId)
      if (!item) return null
      return (
        <ItemView st={st} item={item} mappingId={t.mappingId} setMapping={(id) => onUpdateTab(tabKey(t), { ...t, mappingId: id })} run={run}
          onOpenSource={(id) => onOpen({ kind: 'source', sourceId: id })} onOpenFile={(p) => onOpen({ kind: 'file', path: p })} fsVer={fsVer} docFiles={docFiles} />
      )
    }
    if (t.kind === 'file') return <FileView path={t.path} fsVer={fsVer} scope={st.scope} run={run} onOpenFile={(p) => onOpen({ kind: 'file', path: p })} onDirty={onDirty} />
    return <SourceView st={st} sourceId={t.sourceId} onSelectItem={onSelectItem} />
  }

  return (
    <section className="pane-right">
      {tabs.length > 0 && (
        <div className="ptabs" role="tablist" aria-label="열린 창" ref={barRef}>
          {tabs.map((t) => {
            const k = tabKey(t)
            const l = labelOf(t)
            return (
              <div key={k} className={`ptab${k === activeKey ? ' on' : ''}`} onAuxClick={(e) => e.button === 1 && onCloseTab(k)}>
                <button className="ptab-main" role="tab" aria-selected={k === activeKey} title={l.title} onClick={() => onActivate(k)}>
                  <span className={`ptab-kind ${t.kind}`}>{KIND_LABEL[t.kind]}</span>
                  {l.color && <span className="ptab-dot" style={{ background: l.color }} />}
                  <span className="ptab-text">{l.text}</span>
                </button>
                <button className="icon-btn ptab-x" aria-label={`${l.text} 닫기`} title="닫기" onClick={() => onCloseTab(k)}>
                  <IClose />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <div className="right-body">
        {tabs.length === 0 && <div className="ptab-body"><EmptyView /></div>}
        {tabs.map((t) => {
          const k = tabKey(t)
          const on = k === activeKey
          // 파일 탭은 저장 안 한 수정이 사라지지 않도록 숨겨 둔 채 유지하고, 나머지는 보일 때만 그린다
          if (!on && t.kind !== 'file') return null
          return (
            <div key={k} className={`ptab-body${t.kind === 'file' ? ' file' : ''}`} role="tabpanel" hidden={!on}>
              {body(t)}
            </div>
          )
        })}
      </div>
    </section>
  )
}
