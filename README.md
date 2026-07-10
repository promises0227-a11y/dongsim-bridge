# dongsim-bridge

마전 월스트리트(`majeon-ws-2026`)와 동심 팩토리 백업(`dongsim-backup`) Firebase 프로젝트 사이의 **잔액 이체 브릿지 API**입니다.

Render 무료 플랜 배포를 기준으로 합니다.

## Firestore 구조 (코드 기준 확인됨)

| 데이터 | 경로 | 필드 |
|--------|------|------|
| 학생 잔액 | `app/state` | `students[]` 배열, `id`(number), `balance`(number) |
| 법인 잔액 | `dongsim_settings/corp` | `accountBalance`(number) |
| 이체 기록 | `bridge_transfers/{idempotencyKey}` | 양쪽 프로젝트 모두 저장 |

학번은 **숫자** (`1`, `5`, `9` 등). API body에서는 문자열 `"9"`도 허용합니다.

## API

모든 POST 요청에 헤더 필요:

```
x-bridge-secret: {BRIDGE_SECRET}
Content-Type: application/json
```

### `GET /health`

Render 헬스체크 / 슬립 방지용.

### `POST /transfer/main-to-backup`

마전 월스트리트 학생 → 백업 학생 입금.

```json
{
  "studentId": "1",
  "amount": 1000000,
  "idempotencyKey": "uuid-v4-here"
}
```

### `POST /transfer/backup-to-main`

백업 학생 → 마전 월스트리트 학생 회수.

### `POST /transfer/corp-to-main`

백업 법인 → 마전 월스트리트 법인 (5번·9번만).

## 로컬 실행

```bash
cp .env.example .env
# .env 값 입력 후
npm install
npm run dev
```

빌드:

```bash
npm run build
npm start
```

## Firebase Admin SDK 키 발급

**각 Firebase 프로젝트**에서:

1. [Firebase Console](https://console.firebase.google.com/) → 프로젝트 설정 → **서비스 계정**
2. **새 비공개 키 생성** → JSON 다운로드
3. JSON의 `project_id`, `client_email`, `private_key`를 `.env`에 입력

| .env 키 | JSON 필드 |
|---------|-----------|
| `MAIN_PROJECT_ID` | `project_id` (majeon-ws-2026) |
| `MAIN_CLIENT_EMAIL` | `client_email` |
| `MAIN_PRIVATE_KEY` | `private_key` |
| `BACKUP_*` | dongsim-backup 프로젝트 동일 |

`private_key`는 Render 환경변수에 넣을 때 **앞뒤 따옴표(`"`) 없이** 넣거나, multiline 입력을 사용하세요.

**Render에서 `DECODER routines::unsupported` 오류가 나면** (가장 흔한 원인: 따옴표 포함·줄바꿈 깨짐):

1. `node scripts/encode-key-for-render.mjs path/to/service-account.json` 실행
2. 출력된 `PRIVATE_KEY_B64` 값을 Render에 `MAIN_PRIVATE_KEY_B64` / `BACKUP_PRIVATE_KEY_B64` 로 등록
3. 기존 `MAIN_PRIVATE_KEY` / `BACKUP_PRIVATE_KEY` 는 **삭제**하거나 비워 두기 (B64가 우선)

`BRIDGE_SECRET`는 충분히 긴 랜덤 문자열로 설정하고, 클라이언트 앱(마전·백업)에서 동일 값을 헤더로 전송합니다.

## Render 배포

1. 이 폴더를 **별도 GitHub 레포**로 푸시
2. [Render](https://render.com) → New Web Service → GitHub 레포 연결
3. `render.yaml` Blueprint 사용 또는 수동 설정:
   - Build: `npm install && npm run build`
   - Start: `node dist/index.js`
4. Environment Variables에 `.env.example` 항목 모두 입력
5. 배포 후 `https://{your-service}.onrender.com/health` 확인

## 실패·롤백

- 차감 성공 후 입금 실패 시 **차감을 원복**하고 `bridge_transfers`에 `failed` 기록
- 동일 `idempotencyKey`로 이미 `completed`면 **중복 처리 없이** 이전 결과 반환

## 다음 단계 (클라이언트)

- 마전 월스트리트: 「동심 팩토리(백업)로 출금」 UI → `/transfer/main-to-backup`
- 백업 앱: 「마전 월스트리트로 회수」→ `/transfer/backup-to-main`
- 백업 앱 (대표): 「마전 월스트리트 법인으로 출금」→ `/transfer/corp-to-main`

브릿지 URL과 `BRIDGE_SECRET`는 클라이언트 env(`VITE_BRIDGE_URL`, `VITE_BRIDGE_SECRET`)로 주입하는 것을 권장합니다.
