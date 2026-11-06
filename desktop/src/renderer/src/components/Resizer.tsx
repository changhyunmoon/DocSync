import { useRef } from 'react'

/** 두 패널 사이의 세로 막대. 끌어서 너비를 바꾸고, 두 번 누르면 기본값으로 */
export default function Resizer({ onResize, onReset, label }: { onResize: (dx: number, phase: 'start' | 'move' | 'end') => void; onReset: () => void; label: string }) {
  const startX = useRef(0)
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="끌어서 너비 조절 · 두 번 누르면 기본값"
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        e.preventDefault()
        startX.current = e.clientX
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        document.body.classList.add('resizing')
        onResize(0, 'start')
      }}
      onPointerMove={(e) => {
        if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return
        onResize(e.clientX - startX.current, 'move')
      }}
      onPointerUp={(e) => {
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
        document.body.classList.remove('resizing')
        onResize(e.clientX - startX.current, 'end')
      }}
    />
  )
}
