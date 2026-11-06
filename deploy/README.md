# DocSync 웹 배포 운영

웹 주소: **http://10.1.19.178:8088** (사내 10.0.0.0/8 네트워크에서 접근)

## main push → 자동 배포

`.github/workflows/deploy-web.yml`이 모든 `main` push와 수동 실행을 처리합니다. 동시 배포는 직렬화하며 진행 중인 배포를 취소하지 않습니다.

1. GitHub-hosted Ubuntu / Node.js 22에서 잠금 파일로 의존성을 설치합니다. Electron 바이너리는 다운로드하지 않습니다.
2. 타입 검사, 기존 37개 테스트, 웹 빌드, 브라우저 API 테스트, 정적 자산·설치 파일 SHA-256 검사, 배포·롤백 통합 테스트를 실행합니다.
3. React 렌더러와 데모 데이터만 새로 생성합니다. 기존 Windows 다운로드 파일은 정적 파일로 포함하지만 데스크톱 실행 파일을 빌드하거나 VM에서 실행하지 않습니다.
4. VM의 저장소 전용 runner가 웹 압축 파일만 받고 SHA-256을 확인합니다. VM에서는 checkout, npm 설치, 소스 빌드를 하지 않습니다.
5. 압축 파일의 경로·심볼릭 링크·크기를 검사하고 staging에 풉니다. `current` 링크를 원자적으로 교체한 뒤 실제 HTTP 응답의 커밋 ID와 핵심 페이지를 확인합니다.
6. 검증 실패 시 직전 배포본으로 링크를 복구하고 실패한 배포본을 삭제합니다. 검증 통과 시 현재·직전 배포본 2개만 보관합니다.

진행 상태: https://github.com/changhyunmoon/DocSync/actions/workflows/deploy-web.yml

배포 성공 여부는 workflow의 `deploy` 작업과 `/health.txt`의 커밋 ID로 확인합니다. `production` 환경은 `main`만 허용하며 PR 이벤트는 배포 runner를 실행하지 않습니다. runner는 `changhyunmoon/DocSync`에만 등록되어 있습니다.

## 기존 서비스와 분리

| 용도 | 설정 |
| --- | --- |
| 웹 서비스 | `docsync-web.service`, Caddy 2.11.9, TCP 8088 |
| 웹 실행 계정 | `docsync-web` (로그인·sudo 권한 없음) |
| 배포 runner | `docsync-runner.service`, `docsync-runner` 계정 (로그인·sudo 권한 없음) |
| 웹 파일 | `/srv/docsync/releases/`, `/srv/docsync/current` |
| 배포 임시 디렉터리 | `/srv/docsync/staging/` |
| runner 및 설치 파일 | `/opt/docsync/runner/`, `/opt/docsync/bin/caddy` |
| 서버 설정·배포 도구 | `/etc/docsync/Caddyfile`, `/opt/docsync/deploy-release.py`, `/opt/docsync/cleanup.py` |
| 웹 로그 | `/var/log/docsync/` |
| 서비스 로그 | 별도 journald namespace `docsync` |

기존 Tomcat admin/cmp/user 포트 20190/20290/20590과 GitLab Runner는 재설정·재시작하지 않습니다. UFW에는 사내 10.0.0.0/8 → 8088 규칙만 추가했습니다. 80/443을 사용하거나 기존 reverse proxy를 수정하지 않습니다.

웹 서비스는 메모리 256 MiB / CPU 1코어, runner는 메모리 1 GiB / CPU 1코어로 제한합니다. 서비스의 파일 시스템 권한을 분리하고 runner에는 sudo·Docker 접근 권한을 주지 않습니다. 웹은 HTTP로 제공하므로 사내망에서 사용하며, 향후 외부 공개에는 도메인과 HTTPS 구성이 필요합니다.

## 파일 정리 정책

- 배포본: 현재 + 직전 **2개**. VM에 소스 저장소·node_modules·npm 캐시는 만들지 않습니다.
- 전송 압축 파일: workflow `always()` 정리 + runner 작업 종료 hook으로 삭제합니다.
- runner checkout 작업 디렉터리·다운로드한 Actions: 작업 종료 hook에서 삭제합니다.
- 중단된 staging·전송 파일: 24시간이 지나면 전용 hourly timer가 정리합니다.
- runner 진단 로그: 7일 / 최근 20개를 기준으로 정리하며 진행 중인 최신 로그는 보존합니다. runner 업데이트의 오래된 bin/externals 복사본도 활성 버전과 최신 두 버전을 제외하고 정리합니다.
- Caddy access/runtime 로그: 파일당 10 MiB, 각각 회전 로그 최대 3개, 7일.
- 전용 journald: 디스크 최대 40 MiB, 런타임 최대 20 MiB, 7일.
- GitHub 전송 artifact: 배포 작업 종료 후 삭제합니다. 정리가 중단되어도 1일 뒤 만료됩니다.
- 설치에 쓴 다운로드 압축 파일·provisioning 파일·테스트 파일은 작업 직후 삭제합니다.

정리 대상은 DocSync 전용 경로뿐입니다. 공유 `/tmp`, Docker 이미지, 시스템 로그, 다른 앱의 배포본을 일괄 정리하지 않습니다.

## 운영 명령 (SSH 접속 후)

```bash
sudo systemctl status docsync-web docsync-runner --no-pager
curl -fsS http://127.0.0.1:8088/health.txt
sudo journalctl --namespace=docsync -u docsync-runner -n 60 --no-pager
sudo tail -n 30 /var/log/docsync/runtime.json
sudo systemctl list-timers docsync-cleanup.timer
sudo systemctl start docsync-cleanup.service
sudo du -sh /srv/docsync /opt/docsync/runner /var/log/docsync
```

애플리케이션 문제로 과거 버전으로 돌아가려면 Git에서 문제 커밋을 revert하고 `main`에 push합니다. 새 배포의 HTTP 검증 실패는 자동으로 롤백합니다.

`deploy/`의 root 소유 서비스·설정·도구 변경은 웹 파일 배포와 별개입니다. 관리자 SSH로 이 디렉터리를 복사하고 `sudo bash install-vm.sh`를 실행한 뒤 해당 서비스를 재시작해 적용합니다. 설치 스크립트는 확인한 공식 바이너리 버전과 SHA-256을 고정하며 runner 자체 업데이트는 활성화되어 있습니다.

GitHub runner 등록 토큰은 초기 설정 때만 사용합니다. 개인 SSH 키나 GitHub 개인 토큰은 저장소·배포 artifact·VM에 저장하지 않습니다. runner가 발급받는 저장소 연결 자격 증명은 전용 계정만 읽을 수 있는 runner 디렉터리에 보관합니다.
