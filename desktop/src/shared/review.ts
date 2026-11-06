// 파일(매핑) 단위 결정: 기존 유지 · 제안 채택 · 보류. main과 renderer가 함께 쓴다.
// 매핑된 파일을 모두 결정하고 채택한 파일이 있으면 항목을 반영할 수 있다. 반영은 채택한 파일만 쓴다.
import type { Item, ItemStatus, Mapping } from './types'

/** 실제 파일 변경을 만드는 매핑인가 */
export function isChange(m: Mapping): boolean {
  if (!m.file) return false
  if (m.relation === '중복' || m.relation === '판단 필요') return false
  if (m.moveTo) return true
  return m.oldText !== m.newText
}

/** 아직 반영 후보인 파일 변경 (기존 유지·보류한 파일은 뺀다) */
export const isActiveChange = (m: Mapping): boolean => isChange(m) && !m.rejected && !m.held

/** 채택 당시 내용과 비교하기 위한 서명 */
export const mappingSig = (m: Mapping): string => JSON.stringify([m.file, m.moveTo ?? null, m.oldText, m.newText])

/** adopted: 제안 채택 · kept: 기존 유지 · held: 보류 · pending: 아직 결정 안 함 */
export type FileReview = 'adopted' | 'kept' | 'held' | 'pending'

export function fileReview(m: Mapping): FileReview {
  if (m.rejected) return 'kept'
  if (m.held) return 'held'
  return m.approvedSig === mappingSig(m) ? 'adopted' : 'pending'
}

/** 파일별 결정을 바꿀 수 있는 항목 상태 (반영 전이면 언제든 바꿀 수 있다) */
export const FILE_REVIEWABLE: ItemStatus[] = ['pending', 'approved', 'rereview', 'rejected', 'held']

/** 파일별 결정 집계 */
export function reviewCounts(it: Item): Record<FileReview, number> & { total: number } {
  const r = it.mappings.filter(isChange).map(fileReview)
  const n = (k: FileReview) => r.filter((x) => x === k).length
  return { total: r.length, adopted: n('adopted'), kept: n('kept'), held: n('held'), pending: n('pending') }
}

/**
 * 파일별 결정에 맞춰 항목 상태를 정한다.
 * - 결정 안 한 파일이 남음 → 검토 대기 (재검토 필요는 그대로)
 * - 모두 결정 · 채택 있음 → 반영 대기 (반영 버튼이 켜진다)
 * - 모두 결정 · 채택 없음 · 보류 있음 → 보류
 * - 모두 기존 유지 → 기존 유지 (status: rejected)
 */
export function syncItemStatus(it: Item): string | undefined {
  const c = reviewCounts(it)
  const was = it.status
  if (c.pending > 0) {
    if (was !== 'rereview') it.status = 'pending'
    return was === 'approved' ? '검토 전 파일이 생겨 반영 대기가 풀렸습니다.' : undefined
  }
  it.rereviewReason = undefined
  if (c.adopted > 0) {
    it.status = 'approved'
    return was === 'approved' ? undefined : `모든 파일을 검토했습니다. 반영하면 채택한 파일 ${c.adopted}개가 수정됩니다.`
  }
  it.status = c.held > 0 ? 'held' : 'rejected'
  return c.held > 0 ? '채택한 파일 없이 보류한 파일이 있어 항목을 보류했습니다.' : '모든 파일을 기존 유지로 결정해 이 항목은 반영하지 않습니다.'
}
