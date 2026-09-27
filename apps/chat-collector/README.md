# chat-collector

Fastify API로 스트리머별 수집을 관리하고 `soop-chat`의 모든 프로토콜 이벤트를 SQLite에 저장합니다. Node.js **24.10 이상**이 필요합니다.

이 프로젝트는 OpenAI Codex로 만들어졌습니다.

## 실행

앱 디렉토리에서 `.env.example`을 `.env`로 복사하고 두 키를 설정합니다. 각각 다음 명령으로 생성할 수 있습니다.

```sh
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('hex'))"
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64'))"
```

첫 번째 결과를 `COLLECTOR_API_KEY`, 두 번째 결과를 `COLLECTOR_SECRET_KEY`에 넣습니다.

| 환경 변수 | 설명 |
| --- | --- |
| `COLLECTOR_API_KEY` | 모든 API의 Bearer 인증 키, 필수 |
| `COLLECTOR_SECRET_KEY` | SOOP 계정 비밀번호 암호화용 Base64 32바이트 키, 필수 |
| `COLLECTOR_CORS_ORIGINS` | 브라우저 직접 호출을 허용할 출처 목록. 쉼표로 구분하며 미설정 시 CORS 비활성화 |
| `HOST` | 기본 `0.0.0.0` |
| `PORT` | 기본 `3000` |

저장된 계정을 복호화하려면 재시작할 때도 같은 암호화 키를 사용해야 합니다. 키는 DB와 별도로 보관합니다.

저장소 루트에서 실행합니다.

```sh
pnpm --filter chat-collector dev

pnpm --filter chat-collector start

pnpm --filter chat-collector typecheck
pnpm --filter chat-collector test
pnpm --filter chat-collector exec biome check src test package.json tsconfig.json
```

개발 실행은 Node 내장 TypeScript 실행과 `--watch`를 사용합니다. 데이터 경로는 실행 디렉토리에 관계없이 앱의 `data/`입니다. 동일 데이터 디렉토리에 대한 수집기는 한 프로세스로 운영합니다.

## Docker 실행

앱 디렉토리의 `docker-compose.yaml`은 공식 `node:24-bookworm-slim` 이미지를 그대로 사용합니다. Dockerfile, 이미지 빌드, 별도 배포 폴더와 앱 빌드가 필요하지 않습니다. 컨테이너에서 pnpm 12.6.0과 잠금 파일에 지정된 워커의 운영 의존성을 설치한 뒤 `node src/index.ts`로 실행합니다.

`apps/chat-collector/.env`가 없다면 `.env.example`을 복사하고 필수 키 두 개를 설정합니다. `apps/chat-collector` 디렉토리에서 다음 명령을 실행합니다.

```sh
docker compose up -d
docker compose logs -f chat-collector
docker compose down
```

소스는 읽기 전용으로 마운트하고 Linux용 의존성은 별도 Docker 볼륨에 저장합니다. 호스트의 `node_modules`와 공유하지 않습니다. 컨테이너를 시작할 때 설치 명령을 실행하므로 npm 레지스트리에 접근할 수 있어야 합니다. 소스 변경 후에는 `docker compose restart chat-collector`로 적용합니다.

DB는 로컬 `apps/chat-collector/data/`를 컨테이너의 앱 `data/`에 직접 연결해 저장합니다.

API는 호스트의 3000번 포트로 공개합니다. Docker에서는 `HOST=0.0.0.0`, `PORT=3000`을 사용하며 호스트 포트를 바꾸려면 Compose의 `ports` 왼쪽 값을 수정합니다. 환경 변수나 Compose 설정을 변경했으면 `docker compose up -d --force-recreate`로 적용합니다.

Node의 내장 TypeScript 실행은 타입을 제거하고 실행하며 타입 검사를 수행하지 않습니다. 이 워커는 지원되는 문법과 `.ts` 확장자 import를 사용하므로 직접 실행할 수 있습니다. 코드 변경 검증에는 별도로 `pnpm --filter chat-collector typecheck`를 사용합니다.

## 수집 동작

- 영문·숫자 6~12자 ID로 등록하며 대소문자가 다른 같은 ID는 동일 대상으로 취급합니다. 등록만 하면 수집은 중지 상태입니다.
- 시작 즉시 방송을 확인하고 미연결 상태에서만 10초 간격으로 재시도합니다. 연결 중에는 별도 방송 조회를 하지 않습니다.
- 방 비밀번호 오류와 접근 제한(성인 인증·구독플러스·로그인 필요 등)이 확인되면 해당 방송에는 접속을 재시도하지 않습니다. 10초마다 공개 방송 번호만 확인하며, 다른 번호의 새 방송이 시작하면 최신 설정으로 접속합니다. 조회 실패나 방송 종료만으로는 제한을 해제하지 않습니다.
- 방송 종료 후 다음 방송을 감시하고, 시작 상태는 재시작 후 자동 재개됩니다. 전체 시작은 현재 등록된 대상에만 적용됩니다.
- 일반 채팅, 이모티콘, 후원, 입퇴장, 시스템 이벤트와 `unknown`을 저장합니다. 원본 패킷이 있는 디코딩 오류는 `protocolError`로 저장합니다.
- 이벤트마다 방송 통계와 함께 즉시 커밋합니다. 저장 실패는 연결을 종료하고 `STORAGE_ERROR` 상태를 유지하며 시작 API로 재시도합니다.
- 방 비밀번호와 SOOP 계정 정보의 변경·해제는 현재 연결을 유지하고 다음 연결부터 반영됩니다. 자동 재시도, 중지 후 시작, 프로세스 재시작 시 최신 설정을 사용합니다.
- 설정 변경만으로는 제한된 방송을 재시도하지 않습니다. 제한 기록은 현재 수집 세션에서만 유지하며, 수집을 중지했다가 시작하거나 프로세스를 재시작하면 같은 방송에도 최신 설정으로 다시 접속을 시도합니다. 제한 기록은 DB에 저장하지 않습니다.
- 등록 해제는 기록을 보존합니다. 재등록하면 같은 파일을 사용합니다. 수집 중인 방송을 삭제하려면 먼저 해당 스트리머를 중지합니다.

## 채팅 보존 기간

스트리머별 `retentionDays`로 보존 일수를 설정합니다. 기본값 `0`은 무제한 보존이며 자동 삭제를 하지 않습니다. 신규 등록할 때 지정하거나 기존 스트리머를 수정할 수 있습니다.

```json
{ "streamerId": "streamer123", "retentionDays": 30 }
```

`PATCH /api/streamers/streamer123`으로 보존 기간을 변경합니다. 자동 삭제를 해제하려면 `retentionDays`를 `0`으로 설정합니다.

```json
{ "retentionDays": 30 }
```

- 일수는 0 이상의 정수이며, 밀리초 환산이 JavaScript 안전 정수 범위를 넘는 값은 허용하지 않습니다. `null`, 음수, 소수, 문자열도 허용하지 않습니다.
- 기준은 방송의 최초 채팅 수집 시각인 `first_collected_at`입니다. 1일은 24시간이며, 이 시각으로부터 지정한 기간이 지난 방송을 `broadcast_no` 단위로 관련 이벤트까지 전부 삭제합니다. 최근 채팅 시각과 방송 종료 시각은 기준에 영향을 주지 않습니다.
- 프로세스 시작 시 수집 자동 재개를 시작한 뒤 정리를 한 번 실행하고, 정리가 끝나면 24시간 뒤 다음 정리를 실행합니다. 별도 NAS 예약 작업은 필요하지 않습니다.
- 현재 수집·재접속 중인 방송은 보호합니다. 방송 번호를 확인 중이거나 재접속을 위해 연결을 정리 중인 대상도 삭제를 보류하고 다음 정리 때 다시 확인합니다.
- 중지한 스트리머도 정리 대상입니다. 등록 해제한 스트리머는 자동 삭제에서 제외하며 보존 설정은 유지합니다. 재등록 시 일수를 생략하면 이전 설정을 재사용하고, 지정하면 덮어씁니다.
- 설정 변경은 다음 정리 또는 프로세스 재시작 시 적용됩니다. 보존 일수만 수정하면 채팅 연결을 재시작하지 않습니다. 정리 중 일부 대상의 삭제가 실패하면 로그에 남기고 다른 대상과 다음 정리는 계속 처리합니다.

이 버전은 새 `_settings.db` 스키마를 전제로 합니다. 기존 DB에 `retention_days`를 추가하는 마이그레이션이나 기존 DB 자동 삭제는 수행하지 않습니다.

## API

모든 요청에 `Authorization: Bearer <COLLECTOR_API_KEY>`를 지정합니다. JSON 요청은 `Content-Type: application/json`을 사용합니다.

어드민 웹페이지에서 직접 연결하려면 `COLLECTOR_CORS_ORIGINS=http://localhost:5173,http://localhost:4173`처럼 정확한 출처를 지정하고 서버를 재시작합니다. 출처에는 경로나 마지막 `/`를 넣지 않습니다. 와일드카드는 허용하지 않습니다. CORS OPTIONS 사전 요청은 인증 없이 처리하지만 실제 API 요청에는 Bearer 인증이 필요합니다. 허용한 출처에서 오류 응답도 읽을 수 있습니다. 출처 허용은 인증을 대체하지 않습니다.

| 메서드 | 경로 | 요청·동작 |
| --- | --- | --- |
| POST | `/api/streamers` | `{ "streamerId": "streamer123", "roomPassword": "optional", "retentionDays": 30 }`, 비밀번호·보존 일수는 선택, 등록 후 201 |
| GET | `/api/streamers` | 등록된 전체 대상과 상태 |
| PATCH | `/api/streamers/:streamerId` | `roomPassword`, `retentionDays` 중 하나 이상 수정, 생략한 값은 유지, 방 비밀번호는 `null`이면 해제 |
| DELETE | `/api/streamers/:streamerId` | 중지·등록 해제, 기록 보존, 204 |
| POST | `/api/collection/start/:streamerId` | 개별 시작 |
| POST | `/api/collection/stop/:streamerId` | 개별 중지 |
| POST | `/api/collection/start` | 현재 등록된 전체 대상 시작 |
| POST | `/api/collection/stop` | 전체 중지 |
| GET | `/api/settings` | `username`, `passwordConfigured` |
| PATCH | `/api/settings` | `{ "username": "account", "password": "secret" }`, 둘 다 `null`이면 해제 |
| GET | `/api/broadcasts` | 등록 해제된 대상까지 포함한 전체 방송 |
| GET | `/api/broadcasts/:streamerId` | 해당 스트리머의 전체 방송 |
| DELETE | `/api/broadcasts/:broadcastNo` | 방송·관련 이벤트 삭제, 204 |
| GET | `/api/broadcasts/:broadcastNo/download?format=sqlite` | 특정 방송의 독립 SQLite 파일 |
| GET | `/api/broadcasts/:broadcastNo/download?format=csv` | 특정 방송의 CSV |
| POST | `/api/query/:streamerId` | `{ "sql": "SELECT ..." }` |

시작·중지는 반복 호출해도 안전합니다. 대상 목록의 `state`는 `stopped`, `waiting`, `connecting`, `collecting`, `error`이며, `enabled`는 저장된 시작 여부입니다. 목록·등록·수정·수집 제어 응답에 `retentionDays`와 평문 방 비밀번호 `roomPassword`를 포함합니다. 방 비밀번호가 없으면 `null`입니다. SOOP 계정 비밀번호는 반환하지 않습니다.

방송 목록은 **페이지네이션 없이 배열 전체**를 반환하며 `first_collected_at` 내림차순, 스트리머 ID·방송 번호 오름차순으로 정렬합니다. DB 컬럼에 `collecting`을 추가해 반환합니다.

입력·SQL 오류는 400, API 인증 실패는 401, 없는 대상·방송은 404입니다. 중복 등록·여러 DB에 존재하는 동일 방송 번호·수집 중 방송 삭제는 409입니다. 오류 응답은 `{ "message": "..." }`입니다.

### SELECT 조회

```json
{
  "sql": "SELECT type, COUNT(*) AS count FROM events WHERE broadcast_no = '123456' GROUP BY type"
}
```

```json
[
  { "type": "chatMessage", "count": 1200 },
  { "type": "ogqEmoticon", "count": 30 }
]
```

조회 대상은 지정한 스트리머 DB이며 등록 해제된 대상도 조회할 수 있습니다. `_settings.db`는 조회할 수 없습니다. 단일 SELECT, SELECT 기반 CTE·JOIN·집계를 지원합니다. 쓰기·DDL·복수 문장·PRAGMA·ATTACH·DETACH·확장 로딩은 읽기 전용 연결과 SQLite authorizer로 차단합니다.

결과는 객체 배열이며 중복 컬럼명은 별칭을 지정해야 합니다. BLOB은 Base64 문자열, 안전 정수 범위를 넘는 INTEGER는 십진 문자열, 빈 결과는 `[]`로 반환합니다. 자동 행 제한은 없으므로 필요한 범위는 직접 `WHERE`·`LIMIT`으로 지정합니다.

조회는 별도 **Node 자식 프로세스**에서 실행합니다. SQLite의 동기 네이티브 실행은 `worker_threads.terminate()`로 즉시 중단되지 않으므로, 10초 제한과 실제 실행 중단을 보장하기 위해 프로세스 격리를 사용합니다. 시간 초과는 504이며 클라이언트 연결 종료·서버 종료 시에도 조회 프로세스를 종료합니다.

### 다운로드

수집 중에도 다운로드할 수 있습니다. SQLite에는 해당 방송의 `broadcasts` 한 행과 관련 `events`만 포함합니다. 커밋된 WAL 데이터까지 읽고 단일 파일로 제공하며 완료·취소·실패 후 임시 파일을 정리합니다.

CSV 헤더는 `events` 컬럼명과 순서 그대로입니다.

```text
id,broadcast_no,type,opcode,received_at,data,raw_flags,raw_payload
```

이벤트 ID 순서로 출력하며 UTF-8 BOM·CRLF·CSV 이스케이프를 적용합니다. `data`는 JSON 문자열이고 `raw_payload`는 Base64 문자열입니다. CSV 읽기는 시작 시점의 스냅샷을 유지합니다.

SQLite 파일 생성은 동기 복사이므로 매우 큰 방송을 내보내면 잠시 API·채팅 처리가 지연될 수 있습니다.

## 데이터 스키마

`data/_settings.db`:

- `settings`: 단일 `id=1`, `soop_username`, `soop_password_ciphertext`, `soop_password_iv`, `soop_password_tag`, `updated_at`.
- `streamers`: `streamer_id`(대소문자 무시 PK), `room_password`, `retention_days`(INTEGER, NOT NULL, 기본값 0, 0 이상), `registered`, `enabled`, `created_at`, `updated_at`.

`data/<streamerId>.db`:

- `broadcasts`: `broadcast_no`(PK), `streamer_id`, `first_collected_at`, `last_collected_at`, `ended_at`, `event_count`.
- `events`: `id`(PK), `broadcast_no`(외래 키·연관 삭제), `type`, `opcode`, `received_at`, `data`(유효 JSON), `raw_flags`, `raw_payload`(BLOB).
- 인덱스: 방송 수집 시각과 방송별 이벤트 ID. 모든 테이블은 `STRICT`입니다.

시각은 UTC Unix epoch 밀리초, 방송 번호는 TEXT입니다. `ended_at`은 실제 종료 확인 시각으로 수동 중지·일시적 연결 끊김에는 설정하지 않습니다. 최초·최근 수집 시각은 이벤트 수신 시각이며 실제 방송 시작 시각과 다릅니다.

계정 비밀번호만 AES-256-GCM으로 암호화합니다. 계정 ID·방 비밀번호는 평문, 인증 티켓은 메모리에만 보관합니다. `raw_flags`는 헤더의 두 자리 플래그이며 사용자 권한 플래그와는 다릅니다. `raw_payload`는 헤더를 제외한 본문의 원본 바이트로 다시 해석할 때 사용합니다.

운영 DB에는 `auto_vacuum=FULL`, `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`, `wal_autocheckpoint=1000`을 적용합니다. 삭제 후 체크포인트는 활성 읽기를 기다리지 않고 시도하며, 지연된 공간은 읽기가 끝난 후 재사용·회수됩니다. 자동 삭제는 스트리머별 보존 일수에 따르며 용량에 따른 자동 삭제는 없습니다. 방송 하나의 동기 SQLite 삭제가 실행되는 동안에는 API·채팅 처리가 잠시 지연될 수 있습니다.
