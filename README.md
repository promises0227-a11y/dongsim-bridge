# dongsim-bridge

마전 월스트리트와 동심 팩토리 간 **잔액 이체 브릿지 API** (Supabase 단일 DB).

Render 무료 플랜 배포를 기준으로 합니다.

## Supabase 구조

| 데이터 | 테이블 | 필드 |
|--------|--------|------|
| 마전 학생 잔액 | `students` | `balance` |
| 동심 브릿지 지갑 | `students` | `support_fund.bridgeBalance` (jsonb) |
| 법인 잔액 (동심) | `dongsim_settings` | `doc_id=corp` → `data.accountBalance` |
| 법인 잔액 (마전 틴) | `teen_companies` | `id=dongsim-factory-corp` → `account_balance` |
| 이체 기록 | `bridge_transfers` | `idempotency_key` 기준 |

학번은 **숫자** (`1`, `5`, `9` 등). API body에서는 문자열 `"9"`도 허용합니다.

## API

모든 POST 요청에 헤더 필요:

```
x-bridge-secret: {BRIDGE_SECRET}
Content-Type: application/json
```

### `GET /health`

Supabase 연결 확인.

### `POST /transfer/main-to-backup`

마전 `balance` → 동심 `support_fund.bridgeBalance` 이동.

### `POST /transfer/backup-to-main`

동심 `bridgeBalance` → 마전 `balance` 회수.

### `POST /transfer/corp-to-main`

동심 법인 → 마전 틴프러너 법인 (5번·9번만).

## 로컬 실행

```bash
cp .env.example .env
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BRIDGE_SECRET 입력
npm install
npm run dev
```

빌드:

```bash
npm run build
npm start
```

## Render 배포

`render.yaml` 환경변수:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BRIDGE_SECRET`

Supabase SQL Editor에서 `supabase/migrations/add-bridge-transfers.sql` 실행 후 배포하세요.
