import type { ItemStatus, Relation } from '@shared/types'

export const STATUS: Record<ItemStatus, { label: string; fg: string; bg: string }> = {
  pending: { label: '검토 대기', fg: '#b9382f', bg: '#fbe4e4' },
  rereview: { label: '재검토 필요', fg: '#b9382f', bg: '#fbe4e4' },
  approved: { label: '반영 대기', fg: '#1f6fc5', bg: '#e7f3f8' },
  applied: { label: '반영 완료', fg: '#1f6fc5', bg: '#e7f3f8' },
  confirmed: { label: '이미 존재', fg: '#0f7b6c', bg: '#ddf1ec' },
  rejected: { label: '기존 유지', fg: '#6b6a66', bg: '#f1f1ef' },
  held: { label: '보류', fg: '#6b6a66', bg: '#f1f1ef' },
  excluded: { label: '미확정', fg: '#6b6a66', bg: '#f1f1ef' }
}

export const REL: Record<Relation, { fg: string; bg: string }> = {
  신규: { fg: '#2b6b45', bg: '#e6f4ea' },
  보완: { fg: '#1f5f99', bg: '#e7f3f8' },
  충돌: { fg: '#9a4a00', bg: '#fdf0e6' },
  중복: { fg: '#0f7b6c', bg: '#ddf1ec' },
  '판단 필요': { fg: '#7a5a00', bg: '#fbf3db' },
  이동: { fg: '#5b4a99', bg: '#efebfa' },
  '링크 수정': { fg: '#5b4a99', bg: '#efebfa' }
}

export const basename = (p: string | null | undefined): string => (p ? p.split('/').pop() ?? p : '대상 없음')

/** 관계 표시 이름 (중복 = 문서에 이미 있음) */
export const relLabel = (r: Relation): string => (r === '중복' ? '이미 존재' : r)
