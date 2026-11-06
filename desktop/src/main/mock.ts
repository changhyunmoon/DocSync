// 테스트 모드 고정 시나리오. 각 결정은 여러 Markdown 문서에 매핑된다.
export { DEMO_FILES, SAMPLE_TEXT } from '@shared/demo'

export interface MockMapping {
  file: string | null
  section: string
  oldText: string
  newText: string
  relation: '신규' | '보완' | '충돌' | '중복' | '판단 필요'
  reason: string
  /** 중복: 문서에 이미 있는 문구 (그대로 복사) */
  existing?: string
}

export interface MockDraft {
  title: string
  detail: string
  quote: string
  confirmed?: boolean
  mappings: MockMapping[]
}

const edit = (file: string, section: string, oldText: string, newText: string, reason: string, relation: MockMapping['relation'] = '충돌'): MockMapping => ({
  file, section, oldText, newText, relation, reason
})

/** 문서에 이미 같은 내용이 있어 바꾸지 않는 매핑 */
const exists = (file: string, section: string, existing: string, reason: string): MockMapping => ({
  file, section, oldText: '', newText: '', relation: '중복', reason, existing
})

const FEATURE_FLAGS_DOC = `# 기능 플래그

## signup_optional_phone
- 목적: 회원가입 전화번호 선택 입력 전환
- 적용 범위: 신규 가입 트래픽 10%에서 시작하고, 24시간 관찰 후 확대 여부를 결정합니다.
- 담당: 제품(김하린), SRE(오세진)
- 롤백: 중단 기준에 걸리면 0%로 되돌립니다. 상세 기준은 [배포 계획](signup-rollout.md)을 따릅니다.
`

export function sampleDrafts(): MockDraft[] {
  return [
    {
      title: '전화번호 선택 입력 전환',
      detail: '가입 정책, API 요청 계약, 화면 검증, DB 제약과 QA 기대값을 같은 결정에 맞춰 변경합니다. 기존 회원 값은 유지합니다.',
      quote: '전화번호는 회원가입 필수값에서 선택값으로 변경한다. 전화번호를 보내지 않거나 null로 보내도 가입을 완료한다. 값이 있으면 기존 형식 검증은 유지하고, 기존 회원의 전화번호는 변경하지 않는다.',
      mappings: [
        edit('docs/product/signup-rules.md', '입력 항목', '- 이메일과 비밀번호, 전화번호를 필수로 받습니다.', '- 이메일과 비밀번호는 필수입니다. 전화번호는 선택 입력이며 생략해도 가입할 수 있습니다.', '필수값 정의가 새 결정과 다릅니다.'),
        edit('docs/api/signup.md', 'POST /v1/members', 'Content-Type: application/json. 요청 필드: email(string, required), password(string, required), phone(string, required).\nphone을 생략하거나 null로 보내면 400 PHONE_REQUIRED를 반환합니다.', 'Content-Type: application/json. 요청 필드: email(string, required), password(string, required), phone(string, optional, nullable).\nphone을 생략하거나 null로 보내도 가입을 처리합니다. 값이 있으면 기존 형식 검증을 적용합니다.', '요청 스키마와 오류 계약을 함께 수정합니다.'),
        edit('docs/frontend/signup-form.md', '입력과 제출', '이메일, 비밀번호, 전화번호 세 필드를 모두 필수로 표시합니다.\n전화번호가 비어 있으면 가입 버튼을 비활성화합니다.', '이메일과 비밀번호는 필수, 전화번호는 선택으로 표시합니다.\n전화번호가 비어 있어도 다른 필수값이 유효하면 가입 버튼을 사용할 수 있습니다.', '필수 표시와 버튼 제약을 새 정책에 맞춥니다.'),
        edit('docs/data/member-schema.md', 'members.phone', '| phone | varchar(30) | NOT NULL | 가입 시 수집한 전화번호 |', '| phone | varchar(30) | NULL | 선택 입력한 전화번호. 기존 회원 값은 유지 |', 'API 변경 전에 nullable 마이그레이션이 필요합니다.'),
        edit('docs/qa/signup-tests.md', '전화번호', '- 전화번호를 생략하면 400 PHONE_REQUIRED를 반환하고 회원은 생성되지 않습니다.', '- 전화번호를 생략하거나 null로 보내도 201을 반환하고 회원이 생성됩니다.\n- 전화번호를 입력한 경우 기존 형식 검증을 유지합니다.', '기존 실패 기대값이 새 정책과 충돌합니다.')
      ]
    },
    {
      title: '이메일 인증 시간과 재발송 제한',
      detail: '코드 유효 시간 10분, 재발송 간격 60초, 계정당 하루 5회를 제품·API·화면·QA 문서에 반영합니다.',
      quote: '인증 코드는 발급 후 10분 동안 유효하다. 재발송은 마지막 발송 후 60초가 지나야 가능하며 계정당 하루 5회로 제한한다.',
      mappings: [
        edit('docs/product/signup-rules.md', '이메일 인증', '- 인증 코드는 발급 시점부터 15분 동안 유효합니다.\n- 재발송은 마지막 발송 30초 후 가능하며 하루 횟수 제한은 없습니다.', '- 인증 코드는 발급 시점부터 10분 동안 유효합니다.\n- 재발송은 마지막 발송 60초 후 가능하며 계정당 하루 5회까지 허용합니다.', '시간과 횟수가 결정과 다릅니다.'),
        edit('docs/api/signup.md', 'POST /v1/members/email-verifications', '재발송 요청은 30초 이내면 429 RESEND_TOO_SOON을 반환합니다. 일일 발송 제한은 없습니다.', '재발송 요청은 마지막 발송 후 60초 이내면 429 RESEND_TOO_SOON을 반환합니다. 계정당 하루 5회를 초과하면 429 RESEND_DAILY_LIMIT을 반환합니다. 응답에는 retryAfterSeconds를 포함합니다.', '제한 시간과 일일 횟수 오류 계약을 정의합니다.'),
        edit('docs/frontend/signup-form.md', '이메일 인증 화면', '인증 코드 입력 화면에 15분 만료 안내를 표시합니다.\n재발송 버튼은 발송 후 30초 동안 비활성화합니다. 일일 횟수 안내는 표시하지 않습니다.', '인증 코드 입력 화면에 10분 만료 안내를 표시합니다.\n재발송 버튼은 발송 후 60초 동안 비활성화합니다. 제한 응답을 받으면 남은 대기 시간과 다시 시도 가능한 시각을 안내합니다.', '사용자가 새 제한을 이해할 수 있게 합니다.'),
        edit('docs/qa/signup-tests.md', '이메일 인증', '- 발급 후 15분이 지난 인증 코드는 CODE_EXPIRED를 반환합니다.\n- 30초 이내 재발송은 RESEND_TOO_SOON을 반환합니다.', '- 발급 후 10분이 지난 인증 코드는 CODE_EXPIRED를 반환합니다.\n- 60초 이내 재발송은 RESEND_TOO_SOON과 retryAfterSeconds를 반환합니다.\n- 계정당 하루 6번째 재발송은 RESEND_DAILY_LIMIT을 반환합니다.', '경계값과 새 오류 코드를 회귀 시험에 추가합니다.')
      ]
    },
    {
      title: '가입 요청 제한과 감사 로그 최소화',
      detail: 'IP당 10분에 5회 제한, 429 오류 코드, 마스킹 로그와 30일 보관을 보안·API·QA·운영에 반영합니다.',
      quote: '가입 요청은 IP당 10분에 5회로 제한한다. 초과하면 HTTP 429와 SIGNUP_RATE_LIMITED를 반환한다. 보안 감사 로그에는 requestId, 결과 코드, 마스킹한 이메일만 남기고 30일 보관한다.',
      mappings: [
        edit('docs/security/signup-abuse.md', '요청 제한', '가입 생성 요청은 IP당 10분에 10회까지 허용합니다. 초과 요청은 HTTP 429로 거절합니다.', '가입 생성 요청은 IP당 10분에 5회까지 허용합니다. 초과 요청은 HTTP 429와 SIGNUP_RATE_LIMITED로 거절합니다.', '허용 횟수와 오류 코드를 맞춥니다.'),
        edit('docs/security/signup-abuse.md', '감사 로그', '가입 감사 로그에는 requestId, 결과 코드, 이메일 원문, 발급한 인증 코드를 기록합니다. 로그는 90일 보관합니다.', '가입 감사 로그에는 requestId, 결과 코드, 마스킹한 이메일만 기록합니다. 이메일 원문과 인증 코드는 기록하지 않으며 로그는 30일 보관합니다.', '민감정보 기록과 보관 기간을 바꿉니다.'),
        edit('docs/api/signup.md', '요청 제한과 공통 오류', '가입 요청은 IP당 10분에 10회까지 허용합니다. 초과 시 429 TOO_MANY_REQUESTS를 반환합니다.', '가입 요청은 IP당 10분에 5회까지 허용합니다. 초과 시 429 SIGNUP_RATE_LIMITED를 반환합니다.', '클라이언트가 처리할 오류 코드를 명시합니다.'),
        edit('docs/qa/signup-tests.md', '요청 제한과 배포', '- 동일 IP의 11번째 가입 요청은 429 TOO_MANY_REQUESTS를 반환합니다.', '- 동일 IP의 6번째 가입 요청은 429 SIGNUP_RATE_LIMITED를 반환합니다.\n- 감사 로그에는 마스킹한 이메일만 있는지 확인합니다.', '제한 경계와 로그 노출을 검증합니다.'),
        edit('docs/operations/signup-runbook.md', '요청 제한 이슈', '429가 증가하면 IP 분포와 게이트웨이 헤더 설정을 확인합니다. 제한 완화는 보안 담당자에게 요청합니다.', '429 SIGNUP_RATE_LIMITED가 증가하면 IP 분포와 게이트웨이 헤더 설정을 확인합니다. 감사 로그에는 마스킹한 이메일과 requestId만 사용합니다. 제한 완화는 보안 담당자에게 요청합니다.', '운영 절차에 개인정보 최소 기록 원칙을 덧붙입니다.', '보완'),
        { file: null, section: '감사 로그 보관 기간', oldText: '', newText: '', relation: '판단 필요', reason: '감사 로그 30일 보관 기준을 적을 개인정보·데이터 보관 문서를 찾지 못했습니다. 기존 문서를 지정하거나 새 문서 경로를 입력하세요.' }
      ]
    },
    {
      title: '기능 플래그 기반 10% 단계 배포',
      detail: '24시간 관찰, 완료율·5xx 임계치, 플래그 0% 롤백을 배포·지표·운영 문서에 반영합니다.',
      quote: 'signup_optional_phone 기능 플래그를 신규 가입 트래픽 10%에 먼저 적용한다. 24시간 동안 가입 완료율, 4xx 비율, 인증 메일 발송 실패율을 관찰한다.',
      mappings: [
        edit('docs/delivery/signup-rollout.md', '순서', '3. signup_optional_phone 기능 플래그를 전체 신규 가입 트래픽에 즉시 적용합니다.', '3. signup_optional_phone 기능 플래그를 신규 가입 트래픽 10%에 적용합니다. 24시간 관찰 후 제품·QA·SRE가 확대 여부를 결정합니다.', '즉시 전체 적용을 단계 배포로 바꿉니다.'),
        edit('docs/delivery/signup-rollout.md', '승인 기준', '배포 직후 1시간 동안 오류율을 확인합니다. 장애가 없으면 배포를 완료합니다.', '24시간 동안 가입 완료율, 4xx 비율, 인증 메일 발송 실패율과 5xx 비율을 관찰합니다. 완료율이 기존 대비 2%p 이상 낮거나 5xx 비율이 0.5%를 넘으면 확대를 중단합니다.', '관찰 기간과 중단 기준을 정의합니다.'),
        edit('docs/delivery/signup-rollout.md', '롤백', '문제가 발생하면 이전 앱 버전을 다시 배포합니다. 플래그만 되돌리는 절차는 없습니다.', '중단 기준에 걸리면 온콜 담당자가 signup_optional_phone 플래그를 0%로 되돌립니다. 지표가 회복되지 않으면 이전 앱 버전 재배포를 검토합니다.', '빠른 플래그 롤백을 1차 대응으로 명시합니다.'),
        edit('docs/observability/signup-metrics.md', '배포 확인', '배포 전후 요청량과 전체 오류율을 1시간 단위로 비교합니다. 완료율의 기준선은 아직 정의하지 않았습니다.', '플래그 적용·미적용 집단의 가입 완료율, 4xx·5xx 비율, 인증 메일 발송 실패율을 24시간 비교합니다. 완료율이 기존 대비 2%p 이상 낮거나 5xx 비율이 0.5%를 넘으면 온콜에 경보를 보냅니다.', '중단 판단에 필요한 집단별 지표를 정의합니다.'),
        edit('docs/operations/signup-runbook.md', '배포 장애', '5xx가 증가하면 온콜 담당자가 이전 앱 버전을 재배포합니다. 배포 담당자와 QA에 결과를 공유합니다.', '완료율이 기존 대비 2%p 이상 낮거나 5xx 비율이 0.5%를 넘으면 온콜 담당자가 signup_optional_phone 플래그를 0%로 되돌립니다. 회복되지 않으면 이전 앱 버전을 재배포하고 배포 담당자와 QA에 공유합니다.', '운영자가 실행할 롤백 순서를 구체화합니다.'),
        edit('docs/observability/signup-metrics.md', '현재 대시보드', '- email_delivery_failures_total: 인증 메일 발송 실패 수', '- email_delivery_failures_total: 인증 메일 발송 실패 수\n- signup_completion_rate: 플래그 적용·미적용 집단별 가입 완료율\n- signup_5xx_ratio: 가입 API 5xx 응답 비율', '중단 기준에 쓰는 지표가 대시보드 목록에 없어 덧붙입니다.', '보완'),
        edit('docs/delivery/feature-flags.md', '새 문서', '', FEATURE_FLAGS_DOC, '기능 플래그를 정리한 문서가 없어 배포 문서 옆에 새로 만듭니다.', '신규'),
        edit('docs/README.md', '회원가입 관련 문서', '- [운영 절차](operations/signup-runbook.md): 장애 대응과 롤백', '- [운영 절차](operations/signup-runbook.md): 장애 대응과 롤백\n- [기능 플래그](delivery/feature-flags.md): 플래그별 적용 범위와 롤백', '새 기능 플래그 문서를 목차에 연결합니다.', '보완')
      ]
    },
    {
      title: '기존 회원 전화번호 유지',
      detail: '기존 회원 정보를 바꾸지 않는다는 원칙이 제품 정책과 데이터 문서에 이미 있습니다.',
      quote: '기존 회원의 전화번호는 변경하지 않는다',
      mappings: [
        exists('docs/product/signup-rules.md', '배경과 적용 범위', '기존 회원 정보는 별도 변경 요청이 없는 한 유지합니다.', '기존 회원 정보를 유지한다는 원칙이 이미 있습니다.'),
        exists('docs/data/member-schema.md', '변경 관리', '데이터 백필이나 기존 회원 값 변경은 별도 작업으로 관리합니다.', '기존 회원 값을 바꾸지 않는다는 규칙이 이미 있습니다.')
      ]
    },
    {
      title: '마케팅 동의 문구는 법무 검토 대기',
      detail: '문구와 기본 선택 상태가 미확정이므로 이번 배포 변경안에서 제외합니다.',
      quote: '마케팅 수신 동의 문구와 기본 선택 상태는 법무 검토 후 확정한다. 이번 배포 범위와 변경안에서는 제외한다.',
      confirmed: false,
      mappings: [{ file: null, section: '법무 검토 대기', oldText: '', newText: '', relation: '판단 필요', reason: '결정되지 않아 파일을 수정하지 않습니다.' }]
    }
  ]
}
