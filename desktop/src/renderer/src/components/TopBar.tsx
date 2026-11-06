import type { PublicState } from '@shared/types'

export default function TopBar({ st, onOpen, onDemo, onMode, onKey }: { st: PublicState; onOpen: () => void; onDemo: () => void; onMode: (enabled: boolean) => void; onKey: () => void }) {
  const c = (f: (s: string) => boolean) => st.items.filter((i) => f(i.status)).length
  const pending = c((s) => s === 'pending' || s === 'rereview')
  const approved = c((s) => s === 'approved')
  const applied = c((s) => s === 'applied')
  const exists = c((s) => s === 'confirmed')
  return (
    <header className="topbar">
      <div className="row">
        <span className="logo">D</span>
        <span style={{ fontWeight: 600 }}>DocSync</span>
        <span className="muted">/</span>
        {st.testMode
          ? <span className="badge" title={st.root ?? ''}>샘플 프로젝트</span>
          : <button className="btn ghost sm" onClick={onOpen} title={st.root ?? ''}>{st.root ? st.rootName : '프로젝트 열기'}</button>}
      </div>
      {st.root && (
        <span className="badge" style={{ background: '#f1f1ef', color: '#55534e' }} title="파일 트리의 ◎ 버튼으로 변경">
          반영 범위 · {st.scope.length ? st.scope.map((s) => s + '/').join(', ') : '프로젝트 전체'}
        </span>
      )}
      <span className="grow" />
      <button className={`mode-switch${st.testMode ? ' on' : ''}`} role="switch" aria-checked={st.testMode} aria-label="샘플 프로젝트 전환" disabled={st.processing} onClick={() => onMode(!st.testMode)} title={st.testMode ? '끄면 실제 작업 프로젝트로 돌아갑니다' : '켜면 샘플 프로젝트로 전환합니다'}>
        <span className="mode-track"><span /></span>
        테스트 {st.testMode ? 'ON' : 'OFF'}
      </button>
      {st.testMode && <button className="btn sm" onClick={onDemo}>새 샘플 시작</button>}
      {st.processing && (
        <span className="row" style={{ gap: 6, fontSize: 12.5, color: 'var(--accent-ink)' }}>
          <span className="pulse" />
          {st.testMode ? '예시 처리 중' : 'AI 처리 중'}
        </span>
      )}
      <span className="counts">
        <span><b style={{ color: '#b9382f' }}>{pending}</b> 검토 대기</span>
        <span><b style={{ color: '#1f6fc5' }}>{approved}</b> 반영 대기</span>
        <span><b>{applied}</b> 반영 완료</span>
        {exists > 0 && <span><b style={{ color: '#0f7b6c' }}>{exists}</b> 이미 존재</span>}
      </span>
      {!st.testMode && <button className="btn" onClick={onKey} aria-label="API 키 설정">
        <span style={{ width: 7, height: 7, borderRadius: 4, background: st.key ? '#2b6b45' : '#b9382f' }} />
        {st.key ? `${st.key.provider} ••••${st.key.tail}` : 'API 키 없음'}
      </button>}
    </header>
  )
}
