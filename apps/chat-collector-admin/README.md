# chat-collector-admin

SOOP 계정, 스트리머 설정과 수집 시작·중지, 방송 기록, 읽기 전용 SQL 조회를 관리하는 React·Vite 웹페이지입니다. 로컬·내부망에서 사용하며 별도 로그인은 없습니다.

이 프로젝트는 OpenAI Codex로 만들어졌습니다.

## 실행

`apps/chat-collector-admin/.env.example`을 `.env.local`로 복사해 설정합니다.

| 환경변수 | 설명 |
| --- | --- |
| `VITE_COLLECTOR_API_URL` | `/api` 앞까지의 collector 서버 주소. 예: `http://localhost:3000` |
| `VITE_COLLECTOR_API_KEY` | collector의 `COLLECTOR_API_KEY`와 동일한 키 |

브라우저가 API를 직접 호출하므로 **API 키는 빌드된 JavaScript와 요청 헤더에 포함됩니다.** 웹페이지에 접근할 수 있는 사람은 키를 확인할 수 있습니다. 키를 화면이나 localStorage에 별도로 저장하지는 않습니다. [Vite 환경변수 문서](https://vite.dev/guide/env-and-mode)

collector의 `.env`에는 허용할 어드민 출처를 지정합니다. 출처는 프로토콜·호스트·포트이며 경로나 마지막 `/`는 포함하지 않습니다.

```dotenv
COLLECTOR_CORS_ORIGINS=http://localhost:5173,http://localhost:4173
```

내부망에서 다른 PC로 접속하면 실제 주소도 추가합니다. 예: `http://192.168.0.10:5173`. CORS 설정을 변경한 뒤 collector를 재시작합니다. HTTPS 페이지에서는 API도 HTTPS로 연결해야 합니다.

저장소 루트에서 실행합니다.

```sh
pnpm install
pnpm --filter chat-collector run dev
pnpm --filter chat-collector-admin run dev
```

개발 주소는 `http://localhost:5173`입니다. 내부망 접속이 필요하면 `pnpm --filter chat-collector-admin dev --host 0.0.0.0`으로 실행합니다. 사용 중인 포트가 있으면 자동으로 다른 포트를 선택하지 않습니다.

```sh
pnpm --filter chat-collector-admin run build
pnpm --filter chat-collector-admin run preview
```

빌드 결과는 앱의 `dist/`이며 정적 서버로 제공할 수 있습니다. preview 주소는 `http://localhost:4173`입니다. 환경변수 변경은 개발 서버 재시작 또는 재빌드가 필요하며, 이미 빌드된 파일은 preview 실행 시 환경변수를 바꿔도 갱신되지 않습니다.

## 동작

- 스트리머 ID는 영문·숫자 6~12자이며 등록만 하면 수집은 중지 상태입니다. ID는 수정할 수 없고, 방 비밀번호와 보존 기간을 수정할 수 있습니다. 방 비밀번호는 목록과 수정 화면에 그대로 표시되며 수정 화면에서 비우고 저장하면 해제됩니다. 변경·해제는 다음 연결부터 반영됩니다. 보존 기간 `0`은 무제한입니다.
- 스트리머 탭에서는 페이지가 보이는 동안 10초마다 상태를 조회합니다. 등록 해제는 수집을 중지하고 기존 기록을 보존합니다.
- 방송 목록에는 등록 해제된 스트리머도 포함됩니다. 스트리머 선택 목록은 전체 방송 데이터에서 추출하며 선택한 스트리머와 날짜를 함께 필터링할 수 있습니다. 날짜는 브라우저 현지 시간의 하루 전체를 기준으로 최초·최근 수집 기간과 겹치는 방송을 표시합니다. 표시 시각은 실제 방송 시작 시각이 아닌 수집 시각입니다. 삭제하면 방송과 관련 이벤트가 함께 삭제됩니다. 수집 중이면 먼저 중지해야 합니다.
- 방송별 `DB`·`CSV` 버튼으로 해당 방송 기록을 다운로드합니다. DB는 해당 방송의 `broadcasts`·`events`만 담은 독립 SQLite 파일이며 확장자는 `.db`입니다. 수집 중에도 다운로드 시점의 기록을 저장할 수 있습니다. 파일명은 최초 수집 시간을 브라우저 현지 시간으로 나타낸 `YYMMDD_HHmm-스트리머ID-방송번호.db` 또는 `.csv`입니다.
- SQL은 셀렉트에서 선택한 스트리머 DB에서 실행됩니다. 선택 목록은 등록된 스트리머와 전체 방송 기록의 스트리머를 합쳐서 표시하므로 방송 기록이 남아 있는 등록 해제된 ID도 선택할 수 있습니다. 단일 SELECT와 SELECT 기반 CTE 등을 지원하며 쓰기는 서버에서 차단합니다. `WHERE`·`LIMIT`은 직접 지정하고 서버 실행 제한은 10초입니다. 조회 취소는 요청 연결을 닫아 서버 조회를 중단합니다.
- SQL 결과의 `CSV 다운로드`는 마지막 조회 결과 전체를 `YYMMDD_HHmm-스트리머ID-query.csv`로 저장합니다. 파일명의 시간은 다운로드할 때 브라우저 현지 시간 기준의 현재 시간입니다. 현재 페이지에만 제한하지 않으며 SQL을 다시 실행하지 않습니다. 빈 결과에서는 버튼이 비활성화됩니다. CSV는 UTF-8 BOM과 CRLF를 사용하고 쉼표·따옴표·줄바꿈을 보존합니다. SQL 결과의 수식처럼 시작하는 문자열에는 스프레드시트에서 텍스트로 열리도록 작은따옴표를 붙입니다. 파일은 브라우저 메모리에 받은 뒤 저장하므로 큰 방송을 내려받을 때에는 파일 크기만큼의 여유 메모리가 필요합니다.
- 저장 쿼리는 `chat-collector-admin.saved-queries.v1` localStorage에 이름과 SQL만 보관합니다. 불러오면 현재 스트리머는 유지되고 실행 버튼을 눌러야 조회합니다. 저장 공간은 페이지 출처별로 구분되므로 개발·preview·배포 주소 간에 자동 공유되지 않습니다.
- SOOP 계정을 저장하려면 아이디와 비밀번호를 함께 입력합니다. 둘 다 비우고 저장하면 계정이 해제됩니다. 기존 비밀번호는 조회할 수 없으며 계정 변경·해제는 다음 연결부터 반영되고 현재 수집 중인 연결은 유지됩니다.

## 검증

```sh
pnpm --filter chat-collector-admin run typecheck
pnpm --filter chat-collector-admin run test
pnpm --filter chat-collector-admin run build
pnpm --filter chat-collector-admin run check
```
