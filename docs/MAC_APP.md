# macOS 앱 사용법

## 다운로드하고 실행하기

1. [CodexOffice.app.zip](CodexOffice.app.zip)을 다운로드합니다. GitHub 파일 화면에서는 **Download raw file**을 사용합니다. 저장소가 비공개이므로 접근 권한이 있는 계정으로 로그인해야 합니다.
2. ZIP을 압축 해제하고 **CodexOffice.app**을 응용 프로그램 폴더 또는 사용자 응용 프로그램 폴더에 옮깁니다.
3. 앱을 더블클릭합니다. Node 서버가 자동으로 시작되고, 준비가 끝나면 전용 오피스 창이 열립니다. 터미널이나 별도 브라우저는 필요 없습니다.
4. Claude Code와 Codex를 평소처럼 사용합니다. 같은 작업 폴더에서 일하면 같은 층에 표시됩니다. 마지막 활동 기준 최근 7일만 표시하며, 그보다 오래된 세션과 비어 있는 층은 화면에서만 제외합니다. 원본 기록은 보존하고, 세션을 이어서 사용하면 다시 표시합니다.
5. **창의 빨간 닫기 버튼**, **⌘W**, **⌘Q**로 닫으면 앱이 실행한 서버도 함께 종료됩니다.

![macOS 전용 앱 화면](mac-app-preview.png)

이미지는 가짜 작업 기록으로 검증한 실제 앱 화면입니다.

## 필요한 환경

- macOS **13 이상**.
- Node.js **18 이상**. 앱이 설치된 Node를 사용하며 Node 자체는 ZIP에 포함하지 않습니다. [Node.js 공식 다운로드](https://nodejs.org/en/download).
- Apple Silicon과 Intel용 실행 파일을 함께 포함한 Universal 앱입니다. 실제 GUI 실행 검증은 Apple Silicon Mac에서 했습니다.
- Xcode는 앱을 다시 빌드하는 개발자에게만 필요합니다. 만들어진 앱을 사용하는 데는 필요 없습니다.

이 ZIP은 개인 사용을 위한 **로컬 ad-hoc 서명 빌드**입니다. Developer ID 서명 및 Apple 공증을 받은 배포본은 아닙니다. 인터넷에서 다운로드한 앱의 실행 허용 여부는 macOS 보안 정책을 따릅니다. 앱이나 빌드 스크립트가 Gatekeeper·격리 설정을 해제하지 않습니다. 공증 배포에는 별도 Developer ID 서명 절차가 필요합니다.

## 앱 실행과 서버 관리

- 앱 전용 빈 포트를 자동 배정하므로 터미널 버전의 `localhost:4777`과 충돌하지 않습니다.
- 앱을 다시 더블클릭하면 실행 중인 창을 앞으로 가져오며 서버를 중복 실행하지 않습니다.
- 창이 닫히면 IPC로 서버 종료를 요청하고, 종료가 지연되면 앱이 소유한 자식 프로세스만 정리합니다.
- 앱을 강제 종료해도 서버는 부모 연결 단절을 감지해 종료합니다. 이 동작은 자동 테스트와 실제 앱 프로세스 강제 종료로 검증했습니다.
- 별도로 실행한 CLI 서버나 Claude/Codex 프로세스는 종료하지 않습니다.
- 기존 `오피스 실행.command`와 `npm start`는 수동 터미널 실행 방식으로 계속 사용할 수 있습니다. 앱 방식과 실행·종료 절차가 다릅니다.

## 저장되는 설정

앱 전용 설정 폴더:

```text
~/Library/Application Support/CodexOffice/
  office.json             건물 이름·대표 이름
  view-preferences.json   층 정리·테마·밤 모드·가리기
  launcher.json           선택 사항: Node·기록 경로
  server-state.json       실행 중인 앱·서버 PID와 주소
```

앱을 재실행해 포트가 바뀌어도 층 정리와 화면 설정을 복원합니다. 일반 브라우저에서 저장했던 localStorage는 앱으로 자동 이전하지 않습니다. 앱에서 한 번 다시 설정하면 이후에는 유지됩니다. 서버 PID 정보는 종료 시 정리됩니다.

앱은 Claude/Codex 설정·인증 파일을 읽거나 수정하지 않습니다. 양쪽 대화 기록은 읽기 전용으로 열고, 기록의 명령을 실행하거나 모델을 호출하지 않습니다.

## Node 또는 기록 경로를 직접 지정하기

앱은 `/usr/local/bin/node`, `/opt/homebrew/bin/node` 등에서 Node를 찾습니다. 다른 경로를 사용하거나 Finder 실행에 환경 변수가 전달되지 않는 경우, 앱을 닫은 상태에서 앱 전용 설정 폴더의 `launcher.json`을 만듭니다.

```json
{
  "nodePath": "/usr/local/bin/node",
  "codexSessionsDir": "/절대경로/.codex/sessions",
  "claudeProjectsDir": "/절대경로/.claude/projects"
}
```

필요한 키만 넣으면 됩니다. 경로는 절대 경로로 지정하며 `~`를 쓰지 않습니다. Node 경로를 지정하지 않아도 표준 위치에서 찾을 수 있으면 실행됩니다. 기본 기록 위치는 `~/.codex/sessions`, `~/.claude/projects`입니다.

`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_SESSIONS_DIR`, `CLAUDE_PROJECTS_DIR` 환경 변수가 앱 프로세스에 전달된 경우에도 해당 값을 사용합니다. 쉘 시작 파일을 실행하거나 양쪽 도구의 설정 파일을 열어 환경을 복원하지는 않습니다.

## 업데이트

1. 실행 중인 앱 창을 닫습니다.
2. 새 ZIP을 다운로드하고 압축 해제합니다.
3. 응용 프로그램 폴더의 기존 앱을 새 앱으로 교체합니다.

v1.3부터 상단 사용량 칸은 기록 연결 상태와 사용 한도 제공 여부를 따로 표시합니다. Claude 사용 한도는 Claude Code의 `/usage`에서 확인하세요([사용 가이드](../USAGE.md#사용-한도와-비용)).

설정은 앱 밖에 저장하므로 앱을 교체해도 유지됩니다. GitHub 소스가 갱신되어도 이미 설치한 앱은 자동 갱신되지 않습니다. 새 앱 ZIP을 사용하거나 다시 빌드해야 합니다.

## 개발자가 다시 빌드하기

Node.js와 Xcode 또는 Command Line Tools가 있는 Mac에서:

```sh
npm test
npm run build:mac
npm run verify:mac
```

빌드는 Swift AppKit/WKWebView 실행 파일을 arm64와 x86_64로 각각 컴파일하고 Universal 앱으로 묶습니다. 브라우저 엔진이나 Node를 추가 다운로드하지 않습니다.

완성된 ZIP은 `docs/CodexOffice.app.zip`에 생성됩니다. 서명할 앱 번들은 동기화 폴더의 Finder 메타데이터 영향을 피하도록 시스템 임시 폴더에서 생성합니다. 마지막 빌드 앱 경로는 `build/app-path.txt`에 기록됩니다. `build/`는 Git에 포함하지 않습니다.

빌드에 포함하는 파일은 서버·화면·해석기·라이선스 등으로 제한합니다. 실제 기록, 인증, 사용자 설정, node_modules는 포함하지 않습니다. 검증 스크립트는 ZIP을 새 임시 폴더에 압축 해제하여 코드 서명, CPU 아키텍처, 소스 일치 여부와 개인 파일 제외를 확인합니다.

원작과 MIT 고지는 앱 내부 `Contents/Resources/office/LICENSE`, `THIRD_PARTY_NOTICES.md`에도 포함됩니다.

일상 사용·동시 작업·문제 해결은 [통합 사용 가이드](../USAGE.md)를 참고하세요.
