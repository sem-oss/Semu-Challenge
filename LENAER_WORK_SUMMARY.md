# Lenaer (Linear ↔ Slack 봇) 작업 정리

> 위치: `/Users/sem/Desktop/AI challenge/14_Lenaer`

## 1) 개요
- **목표:** Slack에서 Linear 이슈를 빠르게 만들고(/이슈!), 내 이슈를 조회(/이슈목록)하며, Slack 스레드 ↔ Linear 코멘트를 **양방향 동기화**.
- **기술 스택:**
  - Node.js + TypeScript
  - Slack Bolt (`@slack/bolt`) + Socket Mode
  - Linear SDK (`@linear/sdk`)
  - ExpressReceiver + Webhook 엔드포인트
  - dotenv

## 2) 프로젝트 구조
- `src/index.ts`: 메인 애플리케이션 로직(슬랙 커맨드/액션/메시지 핸들러 + Linear 웹훅)
- `dist/index.js`: 빌드 산출물
- `package.json`
  - scripts
    - `dev`: `ts-node src/index.ts`
    - `build`: `tsc`
    - `start`: `node dist/index.js`

## 3) 환경변수(.env) 구성
> 실제 값은 절대 커밋하지 않고, Railway/로컬에서만 주입.

### 권장 규칙(헷갈림 방지)
- **실행 시 로딩 파일은 기본적으로 `.env` 1개**(코드에서 `dotenv.config()` 사용)로 통일.
- `.env` 안에서 섹션을 나눠 관리:
  - `# Slack` / `# Linear` / `# Runtime` 주석으로 블록 구분
- 별도 파일로 분리하고 싶으면(선택): `.env.slack`, `.env.linear` 처럼 분리한 뒤,
  - 실행 시 `export $(cat .env.slack .env.linear | xargs)`로 주입하거나,
  - 코드에서 `dotenv.config({ path: ... })`를 여러 번 호출하는 방식으로 확장(추후 작업)

`.env.example` 기준:
- Slack
  - `SLACK_BOT_TOKEN` (xoxb…)
  - `SLACK_APP_TOKEN` (xapp…; Socket Mode)
  - `SLACK_SIGNING_SECRET`
- Linear
  - `LINEAR_API_KEY` (lin_api…)
  - `LINEAR_TEAM_ID` (팀 UUID 또는 짧은 identifier)
- 기타
  - `PORT` (기본 3000)
  - `LOG_LEVEL`

현재 `.gitignore`에 `.env` 포함되어 있어 저장소에 올라가지 않도록 처리됨.

## 4) 구현 기능 상세

### A. Slack → Linear 코멘트 동기화 (스레드 답글)
- Slack에서 **스레드(reply)** 로 달린 메시지를 감지.
- 스레드의 **루트 메시지** 텍스트에서 이슈 식별자 추출:
  - 예: `[1SW-123] ...` → `1SW-123`
- Linear에서 해당 이슈를 찾은 뒤, 스레드 답글을 Linear **Comment**로 생성.
- 코멘트 본문에 "(from Slack by …)" 형태로 출처 표시.

### B. Linear → Slack 동기화 (Webhook)
- Webhook 엔드포인트: `POST /linear/webhook`
- 처리 대상:
  - Issue update (상태 변경 / 담당자 변경)
  - Comment create
- 루프 방지:
  - Linear 코멘트 본문에 `(from Slack by ...)` 포함된 경우 무시
- Slack 쪽에서는 `search.messages`로 `issueIdentifier`를 검색해 스레드를 찾아서 해당 스레드에 업데이트 메시지 게시.

### C. Slack Slash Command: `/이슈!`
- 입력: `/이슈! <이슈제목>`
- 동작:
  1) Slack 유저 이메일 조회
  2) Linear 사용자 이메일 매칭
  3) Linear 팀/사이클 조회(활성 사이클 없으면 예정 사이클 fallback)
  4) Linear 이슈 생성(기본 assignee = 요청자)
  5) Slack 채널에 루트 메시지 게시:
     - 이슈 링크
     - 담당자/빌드/상태 정보
     - "리니어에서 확인하기" 버튼
     - 담당자 변경(나에게/팀원 선택) UI
     - 완료 처리 버튼
  6) 관리용 메시지를 스레드로 분리 게시(루트 메시지 깔끔하게 유지)

### D. Slack Slash Command: `/이슈목록`
- 기본: 요청자의 Slack 이메일 → Linear 사용자 매칭 후,
  - 요청자(기본) 또는 지정한 사용자에게 할당된 **진행 중(완료/취소 제외)** 이슈를 조회.
  - 기본 출력은 **상태(state)별 그룹핑**.
  - 각 항목은 **이슈 제목 + 담당자**를 함께 출력(표시에서 [ID]는 제외, 링크로만 접근).
- 사용 예:
  - `/이슈목록` (내 이슈, 상태별)
  - `/이슈목록 태그` (내 이슈, 태그별)
  - `/이슈목록 태그 QA` (내 이슈, 특정 태그 필터)
  - `/이슈목록 @jun` (jun에게 할당된 이슈, 상태별 — **@handle은 권한(users:read) 없으면 매칭 실패할 수 있음**. 가능하면 멘션 자동완성으로 `<@U...>` 형태로 입력 권장)
  - `/이슈목록 @jun 태그` / `/이슈목록 @jun 태그 QA`
  - `/이슈목록 @jun,@sean 태그` / `/이슈목록 @jun,@sean 태그 QA` (복수 assignee 동시 조회)

### D-2. Slack Slash Command: `/태그목록`
- `/이슈목록 태그 ...`의 별칭(태그별 보기).
- 이슈 제목 맨 앞에 연속된 `[태그]`만 태그로 인식(복수 태그 지원).
- **복수 태그면 모든 태그 그룹에 중복 포함**.
- 태그가 없으면 `NoTag` 그룹으로 분류.
- (옵션) `/태그목록 <태그명>` 으로 해당 태그만 필터링 가능

### E. Interactive Actions
- `assign_to_me_btn`: 루트 카드의 담당자를 “나”로 변경
- `assign_to_user`: 드롭다운으로 특정 팀원에게 할당
- `mark_done`: 완료 상태(“Done/Completed/완료” 우선, 없으면 completed type)로 변경 + Slack 메시지 UI 업데이트



## 5) 운영/배포

### 로컬 실행
```bash
cd /Users/sem/Desktop/AI\ challenge/Lenaer
npm install
npm run dev
# 또는
npm run build && npm start
```

### Railway 연동 (현재)
- 프로젝트: `intelligent-mercy` (workspace: `sem-oss's Projects`)
- 서비스 이름: **Semu-Challenge**
- 환경: `production`
- 배포 소스(Source Repo): **GitHub `sem-oss/Semu-Challenge`**
- Variables(서비스 변수) 등록됨(예):
  - `LINEAR_API_KEY`, `LINEAR_TEAM_ID`
  - `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
  - `LOG_LEVEL`, `PORT`

#### 배포 방식(요약)
- 코드 수정 → `git commit` → `git push origin main`
- Railway가 GitHub 변경을 감지해 자동 배포(설정에 따라 수동 deploy일 수 있음)

### (TODO) Railway 대신 서버 연동/운영
- 목표: Railway 의존도를 줄이고 내부 서버(또는 사내 인프라)에서 상시 운영.
- 권장 운영 방식(요약):
  1) PM2/systemd로 `npm run start`(dist) 상시 실행
  2) 환경변수는 서버 Secret 관리(파일 커밋 금지)
  3) Slack Socket Mode는 outbound WS이므로 방화벽 정책만 충족하면 운영 가능
  4) Linear webhook(`POST /linear/webhook`)은 외부에서 서버로 들어오므로 도메인/HTTPS/리버스프록시 필요(Nginx 등)
- 체크리스트:
  - [ ] 서버 도메인/SSL 준비
  - [ ] Linear Webhook URL 변경
  - [ ] 모니터링/로그 정책
  - [ ] (권장) thread_map.json 저장소를 서버 디스크/DB로 안정화

링크(참고용):
- Service:
  - https://railway.com/project/976229c9-fb3f-4e0d-91df-8a4080691c38/service/e8f206cd-3eeb-4277-a8b2-8aca14e4c9cd?environmentId=5354d1c6-1967-421a-89b9-884bee334002
- Dashboard:
  - https://railway.com/dashboard

> 중요: 변수 값(토큰/키)은 문서에 기록하지 않았고, 이름만 정리했습니다.

## 6) 확인된 커밋 히스토리(최근)
- `fix: restore issueIdentifier definition and fix Linear filtering`
- `feat: list issues in a threaded response for /이슈목록`
- `feat: add /이슈목록 command to list assigned issues grouped by state`
- `feat: move linear CTA to thread and add completion feedback in thread`
- `feat: match premium report style from screenshot and fix field indices`

## 7) 보안 체크리스트
- [x] `.env`는 `.gitignore`에 포함 (커밋 방지)
- [x] Slack/Linear 토큰은 코드 하드코딩 금지(환경변수 사용)
- [ ] Railway 로그에 토큰이 출력되지 않도록 주의(디버그 로그에 env 출력 금지)
- [ ] Slack `search.messages`는 권한 범위/워크스페이스 정책에 따라 제한될 수 있어 운영 환경에서 권한 확인 필요
- [ ] Slash command가 `channel_not_found`로 실패하면: **봇이 해당 채널에 초대되지 않은 것**일 수 있음 → 채널에서 `/invite @봇이름(Lenaer)` 후 재시도

---

원하면 다음도 추가로 문서화 가능:
- Slack App 설정 화면(필요 권한 scopes, slash command 등록, interactivity, event subscriptions)
- Linear webhook 설정(이벤트 타입, 시크릿 검증 여부)
- Railway 배포 설정(빌드/스타트 커맨드, healthcheck, 도메인/포트)
