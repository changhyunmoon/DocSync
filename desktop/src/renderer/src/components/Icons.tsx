const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const IChevron = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" style={{ flex: '0 0 12px', color: 'var(--faint)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .1s' }}>
    <path d="M4.5 3l3 3-3 3" {...s} strokeWidth={1.4} />
  </svg>
)
export const IFile = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" style={{ flex: '0 0 14px', color: 'var(--faint)' }}>
    <path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3" {...s} />
  </svg>
)
export const INewFile = () => (
  <svg width="14" height="14" viewBox="0 0 16 16"><path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3 M8 8v4 M6 10h4" {...s} /></svg>
)
export const INewFolder = () => (
  <svg width="14" height="14" viewBox="0 0 16 16"><path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z M8 7.5v4 M6 9.5h4" {...s} /></svg>
)
export const IRename = () => (
  <svg width="13" height="13" viewBox="0 0 16 16"><path d="M10.5 2.5l3 3-8 8h-3v-3z" {...s} /></svg>
)
export const ITrash = () => (
  <svg width="13" height="13" viewBox="0 0 16 16"><path d="M2.5 4h11 M6 4V2.5h4V4 M4 4l.7 9.5h6.6L12 4" {...s} /></svg>
)
export const ITarget = () => (
  <svg width="13" height="13" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" {...s} /><circle cx="8" cy="8" r="2" {...s} /></svg>
)
export const ISearch = () => (
  <svg width="13" height="13" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" {...s} /><path d="M10.5 10.5l3.5 3.5" {...s} /></svg>
)
export const IClip = () => (
  <svg width="14" height="14" viewBox="0 0 16 16"><path d="M10.5 4.5l-5 5a1.5 1.5 0 002 2l5.5-5.5a3 3 0 00-4.2-4.2L3.3 7.3a4.5 4.5 0 006.4 6.4l4-4" {...s} /></svg>
)
export const ICheck = () => (
  <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.2l2.3 2.3 4.7-5" {...s} strokeWidth={1.6} /></svg>
)
export const IClose = () => (
  <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" {...s} /></svg>
)
