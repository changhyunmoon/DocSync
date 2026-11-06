# 개인 개발자용 Windows 코드 서명

## 현재 완료된 것과 남은 것

서명용 빌드 설정, 서명·게시자·타임스탬프 검증, 다운로드 파일 생성, GitHub Actions 검증 단계를 준비했습니다. **인증서가 아직 없으므로 현재 배포된 0.1.0 파일은 여전히 서명되지 않았고 SmartScreen 경고도 그대로일 수 있습니다.** 인증서 발급 전에는 새 서명 파일을 만들 수 없습니다.

코드 서명은 배포하는 EXE의 제작자를 인증합니다. 개인 VM이나 개인 노트북 사용에 회사 인증서가 필요한 것은 아닙니다. 웹사이트 HTTPS 인증서와 Windows 코드 서명 인증서는 서로 다른 용도입니다.

## 1. 개인 명의 인증서 신청 — 사용자가 진행

예를 들어 Certum은 **Standard Code Signing**의 개인 명의 발급을 안내합니다. 현재 프로젝트는 `UNLICENSED`이므로 저렴한 Open Source 상품의 자격이 있다고 가정하지 않습니다.

- 상품·지원 방식: https://www.certum.eu/en/code-signing-certificates/
- 본인 확인에 필요한 서류: https://support.certum.eu/en/code-signing-required-documents/
- SimplySign 발급·활성화: https://support.certum.eu/en/how-to-activate-code-signing-simplysign/

결제 전에 판매처에 **한국 거주 개인의 발급 가능 여부**, 지원 신분증, 최종 비용·갱신 비용, Windows SignTool 연동 방식을 확인하세요. 이 저장소에서는 구매·가입·신분증 제출을 진행하지 않았습니다.

이 구현은 Windows 인증서 저장소에서 인증서 지문으로 선택해 서명하는 방식입니다. 인증기관의 하드웨어 토큰 또는 SimplySign 같은 클라이언트가 Windows에 인증서·키 공급자를 연결해야 합니다. 모든 클라우드 상품이 이 방식 또는 무인 CI를 지원하는 것은 아닙니다. 구매 전 호환성을 확인해야 합니다.

개인키·PFX 파일·PIN·OTP·신분증을 GitHub, 채팅 또는 이 VM에 올리지 않습니다. 인증기관의 공식 화면과 클라이언트에서 직접 처리합니다. 서명할 때 토큰 연결이나 모바일 승인이 필요할 수 있습니다.

## 2. 인증서 발급 후 Windows에 연결

인증기관의 공식 클라이언트를 설치하고 인증서를 활성화한 후, Windows PowerShell에서 확인합니다.

```powershell
Get-ChildItem Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert |
  Select-Object Subject, Thumbprint, NotAfter, HasPrivateKey
```

개인 명의 코드 서명 인증서의 `Thumbprint`(40자리)를 사용합니다. 지문은 공개 식별자이며, SHA-1 지문으로 인증서를 선택하는 것이 EXE를 SHA-1로 서명한다는 뜻은 아닙니다. 파일 서명은 SHA-256을 사용합니다.

GitHub 저장소 Settings → Secrets and variables → Actions → **Variables**에 다음을 등록합니다.

| 이름 | 값 |
| --- | --- |
| `WINDOWS_SIGNER_THUMBPRINT` | 발급받은 인증서의 40자리 Thumbprint |

이 값은 실제 서명자가 승인된 제작자인지 CI에서 독립적으로 확인하는 기준입니다. 갱신으로 인증서 지문이 바뀌면 이 값도 갱신합니다. 인증서가 없는 지금은 빈 값이나 가짜 값을 등록하지 않습니다.

## 3. 서명된 앱·설치 파일 만들기

Windows에서 Node.js 22와 개발 의존성을 준비합니다. Electron 설치 파일을 빌드해야 하므로 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`을 사용하지 않습니다.

```powershell
Set-Location C:\workspace\ai-idea\DocSync
Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue
npm ci --prefix desktop --no-audit --no-fund
# 이전에 Electron 다운로드를 건너뛴 node_modules를 재사용하면 먼저 아래를 실행합니다.
# node desktop/node_modules/electron/install.js
$env:DOCSYNC_SIGN_CERT_SHA1='발급받은 인증서의 40자리 Thumbprint'
npm run dist:win:signed --prefix desktop
```

빌드는 아래를 수행합니다.

1. 사용할 수 있는 지정 인증서와 개인키 연결이 있는지 확인합니다.
2. 앱을 빌드하고 `forceCodeSigning: true`로 서명을 강제합니다. 무서명으로 대체하지 않습니다.
3. `desktop/release-signed/win-unpacked/DocSync.exe`와 Setup EXE의 Authenticode 유효성, 예상 지문, 타임스탬프, 코드 서명 용도를 검사합니다.
4. 모두 통과한 Setup만 `dist/download/`로 분할하고 SHA-256·서명 메타데이터를 기록합니다. 줄어든 배포 조각은 정리합니다.

서명 인증서 미설정, 토큰 잠금, 잘못된 지문, 미서명 파일, 유효하지 않은 서명 또는 타임스탬프 없음은 모두 실패로 처리합니다. 실패 원인이 인증기관의 인증·승인 절차라면 공식 클라이언트에서 처리한 후 다시 실행합니다.

## 4. 검토 후 기존 main 배포 사용

```powershell
node scripts/check-web-site.mjs
git diff --stat
git add dist/download
git commit -m "Publish signed Windows installer"
git push origin main
```

`Deploy DocSync web`은 웹 빌드·테스트 후, 서명 메타데이터가 있는 설치 파일을 **GitHub-hosted Windows**에서 재조립하고 실제 서명을 검증합니다. `WINDOWS_SIGNER_THUMBPRINT`가 없거나 서명자·해시·타임스탬프 검증에 실패하면 VM 배포를 실행하지 않습니다. 서명용 개인키는 이 검증 작업에 필요하지 않습니다.

현재 무서명 0.1.0은 기존에 게시한 SHA-256 `755a8a21f0eb2bb5611c48b85b847e64eb212360b9a231dc25f571b809214011`만 한시적으로 허용합니다. 다른 해시의 새 무서명 파일은 거부합니다. 서명 메타데이터만 위조해도 실제 Windows 서명 검증을 통과하지 못합니다.

첫 서명 배포가 완료되면 `scripts/lib/installer-policy.mjs`의 기존 무서명 해시 허용 분기도 제거해 서명된 파일만 허용하도록 전환합니다.

Windows 검증용 임시 EXE는 `finally`에서 삭제됩니다. VM에는 서명 클라이언트나 개인키를 설치하지 않고, 기존 2개 배포본·전송 artifact·로그 정리 정책을 유지합니다. 로컬 `release-signed/`는 Git에서 제외되며 개발자가 결과를 보관·정리합니다.

## 경고가 사라지는 시점

유효한 서명은 게시자 확인과 파일 무결성 검증을 제공합니다. 새로 발급받은 인증서로 서명해도 SmartScreen 평판이 쌓이기 전에는 경고가 남을 수 있으며, EV도 즉시 경고 제거를 보장하지 않습니다. 자체 서명 인증서로 일반 사용자 PC의 신뢰를 대신할 수 없습니다.

- Microsoft 안내: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- 이 프로젝트의 electron-builder v26 서명 옵션: https://www.electron.build/v26/docs/features/code-signing/code-signing-win/
