import { useEffect, useRef, useState } from 'react'
import type { KeyInfo, Provider, ActionResult } from '@shared/types'

export interface PromptSpec {
  title: string
  label: string
  initial: string
  ok: string
  onSubmit: (value: string) => void
}

export function PromptDialog({ spec, onClose }: { spec: PromptSpec; onClose: () => void }) {
  const [v, setV] = useState(spec.initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const submit = () => {
    if (!v.trim()) return
    spec.onSubmit(v.trim())
    onClose()
  }
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={spec.title}>
        <h2>{spec.title}</h2>
        <label className="col" style={{ gap: 6 }}>
          <span className="label">{spec.label}</span>
          <span className="field">
            <input ref={ref} className="mono" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </span>
        </label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" onClick={submit}>{spec.ok}</button>
        </div>
      </div>
    </div>
  )
}

export function KeyDialog({ info, needed, saved, persist, onClose, onSaved }: {
  info: KeyInfo | null
  needed: boolean
  saved: { provider: Provider; tail: string }[]
  persist: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [provider, setProvider] = useState<Provider>(info?.provider ?? 'Anthropic')
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setErr('')
    const r: ActionResult = await window.api.setKey(provider, key)
    setBusy(false)
    if (!r.ok) return setErr(r.message ?? '키를 확인할 수 없습니다.')
    setKey('')
    onSaved()
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="AI API 키">
        <div className="col" style={{ gap: 4 }}>
          <h2>AI API 키</h2>
          <span className="muted" style={{ fontSize: 13 }}>항목 추출과 변경안 생성에 내 API 키를 사용합니다.</span>
        </div>
        {needed && <div className="note err">AI 요청을 보내려면 API 키가 필요합니다. 저장하면 요청을 이어서 보냅니다.</div>}
        <div className="col" style={{ gap: 6 }}>
          <span className="label">제공자</span>
          <div className="seg">
            {(['Anthropic', 'OpenAI', 'Gemini', 'Groq', 'OpenRouter'] as Provider[]).map((p) => (
              <button key={p} className={p === provider ? 'on' : ''} onClick={() => { setProvider(p); setErr('') }}>{p}</button>
            ))}
          </div>
        </div>
        <label className="col" style={{ gap: 6 }}>
          <span className="label">API 키</span>
          <span className={`field${err ? ' error' : ''}`}>
            <input
              className="mono"
              type={show ? 'text' : 'password'}
              value={key}
              autoComplete="off"
              spellCheck={false}
              placeholder={{ Anthropic: 'sk-ant-...', OpenAI: 'sk-...', Gemini: 'AIza...', Groq: 'gsk_...', OpenRouter: 'sk-or-...' }[provider]}
              onChange={(e) => { setKey(e.target.value); setErr('') }}
              onKeyDown={(e) => e.key === 'Enter' && !busy && save()}
            />
            <button type="button" className="btn ghost sm" onClick={() => setShow(!show)}>{show ? '숨기기' : '보기'}</button>
          </span>
        </label>
        {(() => {
          const sk = saved.find((x) => x.provider === provider)
          if (!sk || (info && info.provider === provider)) return null
          return (
            <div className="row" style={{ marginTop: -4 }}>
              <span className="muted small">이 PC에 저장된 {provider} 키 ••••{sk.tail}</span>
              <button
                className="btn sm"
                disabled={busy}
                onClick={async () => {
                  const r = await window.api.useSavedKey(provider)
                  if (!r.ok) return setErr(r.message ?? '저장된 키를 불러올 수 없습니다.')
                  onSaved()
                }}
              >
                저장된 키 사용
              </button>
            </div>
          )
        })()}
        {err && <span style={{ fontSize: 12.5, color: 'var(--red)', marginTop: -6, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 140, overflow: 'auto' }}>{err}</span>}
        {info && (
          <label className="col" style={{ gap: 6 }}>
            <span className="label">모델 · {info.provider} ••••{info.tail}</span>
            <span className="field">
              <select
                value={info.model}
                disabled={busy}
                onChange={async (e) => {
                  setBusy(true)
                  setErr('')
                  const r = await window.api.setModel(e.target.value)
                  setBusy(false)
                  if (!r.ok) setErr(r.message ?? '이 모델은 사용할 수 없습니다.')
                }}
              >
                {info.models.map((m) => <option key={m} value={m}>{m.endsWith(':free') ? `${m}  · 무료` : m}</option>)}
              </select>
            </span>
          </label>
        )}
        <div className="note info col" style={{ gap: 4, fontSize: 12.5, lineHeight: '19px' }}>
          <span>
            {persist
              ? '· 키는 이 PC에 OS 보안 저장소(Windows 자격 증명 보호)로 암호화해서 저장되어, 앱을 다시 켜도 유지됩니다. "키 삭제"를 누르면 지워집니다.'
              : '· 이 PC에서는 키 암호화 저장을 쓸 수 없어, 키는 앱 실행 중에만 보관되고 종료하면 삭제됩니다.'}
          </span>
          <span>· AI 요청 시 입력 자료와 필요한 문서 내용이 선택한 제공자의 API로 전송됩니다.</span>
          <span>· 사용 요금은 입력한 키의 계정으로 청구됩니다.</span>
          {(provider === 'Groq' || provider === 'OpenRouter') && (
            <span>
              · {provider} 무료 모델은 분당 처리량이 작고 응답 형식이 덜 정확할 수 있어, 반영 범위를 좁게 두고 짧은 자료로 테스트하는 것이 좋습니다.
              {provider === 'OpenRouter' && ' 무료 모델은 제공사에 따라 입력이 기록·학습에 쓰일 수 있으니 샘플 문서로 테스트하세요.'}
            </span>
          )}
        </div>
        <div className="row">
          {info && <button className="btn ghost danger sm" onClick={async () => { await window.api.clearKey(); onClose() }}>키 삭제</button>}
          <span className="grow" />
          <button className="btn" onClick={onClose} disabled={busy}>{info ? '닫기' : '취소'}</button>
          <button className="btn primary" onClick={save} disabled={busy || !key.trim()}>{busy ? '확인 중…' : info ? '키 변경' : '확인 후 저장'}</button>
        </div>
      </div>
    </div>
  )
}
