import { useEffect, useRef, useState } from 'react'
import type { ActionResult, Item, PublicState } from '@shared/types'
import { REL, STATUS, basename, relLabel } from '../status'
import { existsAlready } from '@shared/text'
import { FILE_REVIEWABLE, fileReview, isChange, reviewCounts } from '@shared/review'
import { REVIEW } from './RightPane'
import { ICheck, IClip, IClose } from './Icons'
import { SAMPLE_TEXT } from '@shared/demo'

interface Props {
  st: PublicState
  selectedId: string | null
  onSelectItem: (id: string) => void
  onOpenSource: (id: string) => void
  onClearConversation: () => void
  run: (p: Promise<ActionResult>, retry?: () => Promise<ActionResult>) => Promise<ActionResult>
}

function ItemCard({ it, selected, onSelect, run }: { it: Item; selected: boolean; onSelect: () => void; run: Props['run'] }) {
  const s = STATUS[it.status]
  const act = (a: Parameters<typeof window.api.itemAction>[1]) => run(window.api.itemAction(it.id, a))
  const hasDupOnly = existsAlready(it)
  const dupQuote = hasDupOnly ? it.mappings.find((m) => m.existing)?.existing ?? '' : ''
  const st = it.status
  const stale = it.mappings.some((m) => m.stale)
  const rc = reviewCounts(it)
  const reviewing = FILE_REVIEWABLE.includes(st) && rc.total > 0
  const skipped = rc.kept + rc.held
  return (
    <div className={`card${selected ? ' selected' : ''}`}>
      <button className="card-main" onClick={onSelect} aria-pressed={selected}>
        <span className="row" style={{ width: '100%' }}>
          <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>#{it.no}</span>
          <span className="card-title">{it.title}</span>
          <span className="badge" style={{ color: s.fg, background: s.bg }}>
            {st === 'applied' && <ICheck />}
            {s.label}
          </span>
        </span>
        <span className="card-meta">
          {!it.confirmed && st !== 'excluded' && <span className="chip" style={{ background: '#fbf3db', color: '#7a5a00' }}>미확정</span>}
          {it.kind === 'content' && <span>근거 {it.evidence.length}</span>}
          {it.kind === 'content' && <span style={{ color: '#d3d1cb' }}>|</span>}
          {it.mappings.map((m) => {
            const r = isChange(m) ? fileReview(m) : null
            return (
              <span key={m.id} className={`row${r === 'kept' ? ' file-rejected' : ''}`} style={{ gap: 4 }} title={r ? REVIEW[r].label : undefined}>
                <span className="chip" style={{ background: REL[m.relation].bg, color: REL[m.relation].fg }}>{relLabel(m.relation)}</span>
                {r === 'adopted' && st !== 'applied' && <ICheck />}
                <span className="file-name">{m.moveTo ? `${basename(m.file)} → ${m.moveTo}` : basename(m.file)}</span>
                {r === 'held' && <span style={{ color: REVIEW.held.fg, fontSize: 12 }}>보류</span>}
              </span>
            )
          })}
        </span>
        {reviewing && (
          <span className="muted" style={{ fontSize: 12.5 }}>
            파일 검토 {rc.total - rc.pending}/{rc.total}{rc.adopted ? ` · 채택 ${rc.adopted}` : ''}{rc.kept ? ` · 기존 유지 ${rc.kept}` : ''}{rc.held ? ` · 보류 ${rc.held}` : ''}
          </span>
        )}
        {st === 'applied' && skipped > 0 && <span className="muted" style={{ fontSize: 12.5 }}>기존 유지·보류한 파일 {skipped}개는 반영하지 않음</span>}
        {hasDupOnly && st === 'pending' && it.notes?.some((n) => n.startsWith('AI는 이미 있는 내용')) && (
          <span style={{ fontSize: 12.5, color: '#9a4a00' }}>이미 있다고 판단했지만 문서에서 그 문구를 찾지 못함 · 확인 필요</span>
        )}
        {hasDupOnly && st === 'confirmed' && (
          <span className="exists-line" title={dupQuote}>
            문서에 이미 있음{dupQuote ? ` · “${dupQuote.replace(/\s+/g, ' ').slice(0, 80)}${dupQuote.length > 80 ? '…' : ''}”` : ''}
          </span>
        )}
        {it.conflictNote && <span style={{ fontSize: 12.5, color: '#9a4a00' }}>{it.conflictNote}</span>}
        {st === 'rereview' && it.rereviewReason && <span style={{ fontSize: 12.5, color: 'var(--red)' }}>{it.rereviewReason}</span>}
      </button>
      {selected && (
        <div className="card-actions">
          {st === 'pending' && hasDupOnly && <button className="btn primary sm" onClick={() => act('confirmDup')}>이미 존재로 표시</button>}
          {st === 'rereview' && stale && <button className="btn primary sm" onClick={() => run(window.api.regenerate(it.id), () => window.api.regenerate(it.id))}>변경안 다시 계산</button>}
          {st === 'approved' && <button className="btn primary sm" onClick={() => run(window.api.applyItems([it.id]))}>반영</button>}
          {st === 'applied' && <button className="btn sm" onClick={() => act('undo')}>되돌리기</button>}
          {st === 'confirmed' && <button className="btn sm" onClick={() => act('restore')}>이미 존재 취소 · 다시 검토</button>}
          {st === 'excluded' && <button className="btn sm" onClick={() => act('include')}>검토 대상에 포함</button>}
          <span className="grow" />
          <span className="muted small">
            {st === 'approved'
              ? `채택한 파일 ${rc.adopted}개를 수정합니다`
              : st === 'applied'
                ? '파일에 저장됨 · 언제든 되돌릴 수 있음'
                : (st === 'pending' || st === 'rereview') && !hasDupOnly && rc.total > 0
                  ? '오른쪽에서 파일마다 기존 유지 · 제안 채택 · 보류를 고르세요'
                  : st === 'rejected'
                    ? '모든 파일 기존 유지 · 결정은 오른쪽에서 바꿀 수 있음'
                    : st === 'held'
                      ? '보류한 파일이 있음 · 결정은 오른쪽에서 바꿀 수 있음'
                      : st === 'excluded'
                        ? '회의에서 결정되지 않은 내용이라 기본으로 반영하지 않음'
                        : st === 'confirmed'
                          ? '문서에 이미 있어 변경하지 않음'
                          : ''}
          </span>
        </div>
      )}
    </div>
  )
}

export default function ChatPanel({ st, selectedId, onSelectItem, onOpenSource, onClearConversation, run }: Props) {
  const [draft, setDraft] = useState('')
  const [atts, setAtts] = useState<{ name: string; text: string }[]>([])
  const endRef = useRef<HTMLDivElement>(null)
  const selected = st.items.find((i) => i.id === selectedId) ?? null
  const approved = st.items.filter((i) => i.status === 'approved').length

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [st.messages.length, st.processing])

  const send = async () => {
    if (st.processing || (!draft.trim() && !atts.length)) return
    const input = { text: draft, attachments: atts, selectedItemId: selectedId }
    setDraft('')
    setAtts([])
    const r = await run(window.api.send(input), () => window.api.send(input))
    if (!r.ok && r.message !== 'need-key' && r.message) {
      setDraft(input.text)
      setAtts(input.attachments)
    }
  }

  return (
    <section className="pane-center">
      <div className="center-scroll">
        <div className="col" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="label">대화</span>
            <span className="grow" />
            <button className="btn ghost danger sm" disabled={st.processing || (!st.messages.length && !st.sources.length && !st.items.length)} onClick={onClearConversation}>
              대화 전체 지우기
            </button>
          </div>
          {!st.messages.length && (
            <div className="note info" style={{ lineHeight: '21px' }}>
              {st.testMode ? '테스트 모드에서는 API 요금 없이 예시 변경안을 만듭니다. 샘플 프로젝트를 열고 아래 예시 자료를 보내면 전체 흐름을 체험할 수 있습니다.' : `기획안·회의록을 붙여넣거나 Markdown·텍스트 파일을 첨부하세요. 반영 범위(${st.scope.length ? st.scope.join(', ') : '프로젝트 전체'})의 문서와 비교해 항목과 변경안을 만듭니다.`}
              <br />
              {st.testMode ? <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setDraft(SAMPLE_TEXT)}>예시 회의록 입력</button> : '짧은 요청도 보낼 수 있습니다. 예: “인증 문서를 docs/security/로 옮겨줘”, “#2는 1시간으로 바꿔줘”'}
            </div>
          )}
          {st.messages.map((m) => (
            <div key={m.id} className="msg">
              <span className="avatar" style={m.role === 'ai' ? { background: '#e7f3f8', color: '#1f5f99' } : { background: '#f1f1ef', color: '#55534e' }}>
                {m.role === 'ai' ? 'AI' : '나'}
              </span>
              <div className="col" style={{ gap: 6, minWidth: 0 }}>
                <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>{m.role === 'ai' ? (m.mock ? '테스트 응답' : 'AI') : '나'}</span>
                <span className={`msg-text${m.error ? ' error' : ''}`}>{m.text}</span>
                {m.detail && (
                  <details className="err-detail">
                    <summary>자세히 (오류 원문)</summary>
                    <pre>{m.detail}</pre>
                    <button className="btn ghost sm" onClick={() => navigator.clipboard.writeText(m.detail ?? '')}>복사</button>
                  </details>
                )}
                {m.attachments?.map((a) => (
                  <button key={a.sourceId} className="att" style={{ alignSelf: 'flex-start' }} onClick={() => onOpenSource(a.sourceId)}>
                    <IClip /> {a.name} <span className="muted">· 원문 보기</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {st.processing && (
            <div className="working">
              <span className="pulse" />
              <span>{st.processingLabel || 'AI 처리 중'}</span>
              <span className="grow" />
              <button className="btn sm" onClick={() => window.api.stop()}>중지</button>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="section-head">
          <h2>추출 항목</h2>
          <span className="muted" style={{ fontSize: 13 }}>{st.items.length}</span>
          <span className="grow" />
          <button className="btn sm" disabled={selected?.status !== 'approved'} onClick={() => selected && run(window.api.applyItems([selected.id]))}>선택 항목 반영</button>
          <button className="btn primary sm" disabled={!approved} onClick={() => run(window.api.applyAllApproved())}>반영 대기 항목 모두 반영 · {approved}</button>
        </div>
        <div className="col" style={{ gap: 8, paddingBottom: 12 }}>
          {!st.items.length && <span className="muted" style={{ fontSize: 13 }}>아직 추출된 항목이 없습니다.</span>}
          {st.items.map((it) => (
            <ItemCard key={it.id} it={it} selected={it.id === selectedId} onSelect={() => onSelectItem(it.id)} run={run} />
          ))}
        </div>
      </div>

      <div className="composer">
        {atts.length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {atts.map((a, i) => (
              <span key={i} className="pending-att">
                <IClip /> {a.name}
                <button className="icon-btn" style={{ width: 20, height: 20 }} aria-label="첨부 제거" onClick={() => setAtts(atts.filter((_, k) => k !== i))}>
                  <IClose />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-box">
          <textarea
            rows={3}
            value={draft}
            placeholder="자료를 붙여넣거나 요청을 입력하세요 (Ctrl+Enter로 보내기)"
            aria-label="메시지 입력"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="row" style={{ gap: 6 }}>
            <button className="icon-btn" title="텍스트·Markdown 파일 첨부" aria-label="파일 첨부" onClick={async () => setAtts([...atts, ...(await window.api.pickAttachments())])}>
              <IClip />
            </button>
            <span className="muted small">
              {st.testMode ? '예시 결과 · API 호출 없음' : !st.key ? 'API 키를 입력해야 AI 요청을 보낼 수 있습니다' : selected ? `선택한 #${selected.no} 항목 맥락과 함께 전달` : '새 자료는 기존 항목과 합쳐 분석'}
            </span>
            <span className="grow" />
            <button className="btn primary sm" onClick={send} disabled={st.processing || (!draft.trim() && !atts.length)}>보내기</button>
          </div>
        </div>
      </div>
    </section>
  )
}
