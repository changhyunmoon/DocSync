# DocSync

기획안·회의록의 내용을 프로젝트의 Markdown 문서에 항목별로 검토하고 반영하는 데스크톱 앱과 공개 웹 데모입니다.

- 데스크톱 앱 소스와 개발·빌드 방법: [desktop/README.md](desktop/README.md)
- 공개 웹 데모와 Windows 설치 파일: `dist/`
- 웹 데모 생성·검증·미리보기 스크립트: `scripts/`
- 개인 명의 Windows 코드 서명 준비·발급·배포: [docs/windows-code-signing.md](docs/windows-code-signing.md)

현재 데스크톱 앱은 **준비 중**으로 표시하며 설치 파일 다운로드를 제공하지 않습니다. 웹 배포에서는 설치 파일과 다운로드 스크립트를 제외합니다. 기존 데스크톱 소스와 서명 도구는 저장소에 보관합니다.

## VM 자동 배포

- 웹 주소: http://10.1.19.178:8088
- `main`에 push하면 GitHub Actions가 웹을 빌드·검증하고 VM에 자동 배포합니다.
- 배포 상태: [Deploy DocSync web](https://github.com/changhyunmoon/DocSync/actions/workflows/deploy-web.yml)
- 서버 분리, 파일 보관, 복구 및 관리 방법: [deploy/README.md](deploy/README.md)

웹만 다시 빌드하려면 Node.js 22에서 아래를 실행합니다. 결과는 `.web-build/site/`에 생성되며 기존 `dist/`는 수정하지 않습니다.

```powershell
$env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'
npm ci --prefix desktop --no-audit --no-fund
node scripts/build-web.mjs
```

## 공개 웹 데모

DocSync 데스크톱 앱의 MarketFlow 테스트 모드를 브라우저에서 체험하는 정적 사이트입니다. 화면은 데스크톱 앱의 렌더러 빌드를 사용하고, `dist/app/web-api.js`가 테스트 모드의 IPC 동작을 브라우저 메모리에서 제공합니다. 예시 회의록과 10개 Markdown 문서는 데스크톱 앱의 `src/shared/demo.ts`, `src/main/mock.ts`에서 생성합니다.

```powershell
node scripts/generate-data.mjs
```

`dist/`를 정적 호스팅합니다. 웹 데모의 반영 결과는 현재 페이지 메모리에만 남습니다. 예시 회의록 외의 입력은 데스크톱 테스트 모드처럼 간단한 예시 변경안으로 처리하며, AI API를 호출하지 않습니다. `node scripts/check-web-api.mjs`로 항목 생성, 여러 구간 반영, 되돌리기, 샘플 초기화를 검증할 수 있습니다.

Windows 설치 파일은 20 MiB 단위로 나누어 정적 자산으로 제공합니다. 다운로드 버튼이 조각을 합쳐 `.exe`로 저장합니다. 새 설치 파일은 코드 서명 가이드의 `npm run dist:win:signed`로 빌드·검증·분할합니다. 현재 배포된 0.1.0 설치 파일은 인증서 발급 대기 중인 서명 없는 기존 파일입니다. 코드 서명 준비만으로 기존 파일의 Windows 경고가 해소되지는 않습니다.

## 폴더 구조

- `dist/` — 정적 호스팅할 웹 데모 (설치 파일 조각 포함)
- `scripts/` — 앱 화면 갱신(`build-app.mjs`), 데모 데이터 생성, 설치 파일 분할, 로컬 미리보기(`node scripts/serve.mjs` → http://127.0.0.1:8081)
- `desktop/` — 데스크톱 앱 소스. 데모 데이터나 설치 파일을 다시 만들 때 사용

데모 데이터를 다시 만들려면 먼저 `desktop/`에서 `npm ci`를 실행합니다. 설치 파일 배포는 위 코드 서명 가이드를 따릅니다.

화면(렌더러)을 고쳤다면 `desktop/`에서 `npm run build` 후 `node scripts/build-app.mjs`로 `dist/app`을 갱신합니다. `web-api.js`와 `web.css`는 그대로 두고 연결만 다시 합니다.
