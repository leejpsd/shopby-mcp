# shopby-mcp — 샵바이 API 문서 검색 MCP

샵바이(Shopby) 공식 문서는 검색 기능이 없어서 "이 API 어디 있지?", "이 필터 적용돼?"를
매번 직접 찾아야 한다. 이 도구는 샵바이의 **OpenAPI(YAML) 스펙을 통째로 인덱싱**해서
**Claude에게 자연어로 물어보면** 찾아주게 한다.

- **검색은 안 되지만 데이터는 완벽히 구조화돼 있다** (OpenAPI 3.0). LLM을 새로 만들 필요 없이
  스펙을 파싱해서 인덱싱하면 끝.
- 쓰는 방법 두 가지: ① **MCP 서버**로 Claude(Code/Desktop)에 붙이기, ② 터미널 CLI.
- 원격 인덱스(`config.json`)+yml을 조건부로 점검해 **자동 최신화**한다. 단 스펙은 월 단위로 바뀌므로 기본 **하루 1회만** 점검(아래 참고).

> ⚠️ **비공식(Unofficial) 도구.** NHN커머스/샵바이 공식 제품이 아니다.
> 공식 클라이언트 SDK는 [`@shopby/shop-sdk`](https://www.npmjs.com/package/@shopby/shop-sdk)(API **호출**용)이고,
> 이 패키지는 그와 별개로 **문서 검색/탐색**을 돕는다 — 둘은 역할이 다르며 함께 쓰면 좋다.

## 구성

```
shopby-api-bot/
├─ cache-paths.mjs      # 캐시 경로·호스트 매핑 (공유)
├─ specs-index.json     # 동봉되는 폴백 인덱스(파일 목록). 원격 config.json 을 못 받을 때만 사용
├─ download-specs.mjs   # 인덱스+yml 조건부 최신화 (refreshAll) + CLI 진입점
├─ shopby-index.mjs     # 핵심: yml 로드 + 평탄화 + 검색 + $ref 해석
├─ shopby-cli.mjs       # 터미널 검색/상세조회
├─ shopby-mcp.mjs       # MCP 서버 (Claude 연동, 시작 시 자동 최신화)
├─ spec/                # (gitignore·미배포) 로컬에서 받은 yml 임시본. 실제 런타임은 아래 캐시를 읽음
└─ (런타임) ~/.cache/shopby-mcp/{spec/*.yml, specs-index.json, .etags.json}  ← yml 은 첫 실행 때 여기로 받음(네트워크 필요)
```

> ⚠️ **yml 스펙은 npm 패키지에 동봉되지 않는다.** 첫 실행 때 원격에서 `~/.cache/shopby-mcp/`로 받는다(=네트워크 필요).
> 동봉되는 건 `specs-index.json`(파일 목록) 하나뿐 — 원격 `config.json` 을 못 받을 때의 폴백 인덱스다.

## 설치 — Claude Code (권장: npx, 클론 불필요)

```bash
claude mcp add shopby-docs -- npx -y shopby-mcp
```

끝. `npx`가 패키지를 받아 실행하고, 서버가 **첫 실행 시 스펙을 `~/.cache/shopby-mcp/`로 자동 다운로드**한다.
이후 Claude에게 그냥 물어보면 된다:

- "샵바이 장바구니 리스트 api 찾아줘"
- "브랜드 리스트 api에 필터 뭐 있어?"
- "주문 취소 관련 api 다 보여줘"

Claude가 `search_apis` → `get_api_detail` 툴을 알아서 호출해서 답한다.

> 팀 공유: 저장소 루트에 `.mcp.json`을 두면 팀원이 클론만 해도 동일 설정이 잡힌다.
> ```json
> { "mcpServers": { "shopby-docs": { "command": "npx", "args": ["-y", "shopby-mcp"] } } }
> ```

## 설치 — Claude Desktop

`claude_desktop_config.json`의 `mcpServers`에 추가:

```json
{
  "mcpServers": {
    "shopby-docs": { "command": "npx", "args": ["-y", "shopby-mcp"] }
  }
}
```

## CLI로도 쓰기 (Claude 없이 터미널에서)

```bash
npx -p shopby-mcp shopby-cli "장바구니 리스트"     # API 검색
npx -p shopby-mcp shopby-cli --detail get-cart    # 특정 API 상세

# 자주 쓰면 전역 설치:
npm i -g shopby-mcp
shopby-cli "브랜드 목록 필터"
```

상세조회(`--detail <operationId>`)는 필터(쿼리 파라미터)의 **이름·타입·필수여부·enum·설명**까지 보여준다.
(첫 실행 시 캐시가 비어 있으면 스펙을 자동으로 받아온다.)

## 로컬 개발 (소스에서 직접)

```bash
npm install
node shopby-cli.mjs "장바구니 리스트"
claude mcp add shopby-docs-dev -- node "$(pwd)/shopby-mcp.mjs"
```

### Claude Desktop 연동
`claude_desktop_config.json`의 `mcpServers`에 위 JSON과 동일하게 추가.

## 노출되는 MCP 툴

| 툴 | 설명 |
|----|------|
| `search_apis(query, category?, limit?)` | 자연어로 API 검색. 설명·태그·경로·파라미터에 더해 **응답·요청 바디 필드명**까지 검색. category로 shop/server 좁히기 가능 |
| `list_apis(tag?, category?, limit?)` | **도메인 브라우징.** 인자 없이 호출하면 태그 목록(+개수), tag를 주면 그 도메인 엔드포인트를 한 줄씩 나열. 키워드를 모를 때 목록으로 훑기 |
| `get_api_detail(operationId, source?, section?)` | 특정 API의 필터·요청바디(미디어타입)·응답 스키마. `section`으로 범위 선택(`filters`=파라미터만·최경량 / `request` / `response` / `all`). 동일 id가 양쪽에 있으면 `source`로 구분 |
| `index_stats()` | 로드된 스펙 수 / 총 API 개수 |

> **검색 vs 브라우징**: 키워드가 떠오르면 `search_apis`, "그 도메인에 뭐 있지?" 식으로 훑으려면 `list_apis`. 둘 다 가벼운 목록만 주고, 상세 스키마는 필요할 때 `get_api_detail`로.

### 필드 기반 검색
응답/요청 바디의 필드명·필드설명까지 색인하므로 **"특정 필드가 들어있는 API 찾기"**가 된다:

- "회원 등급(couponAutoSupplying/적립률) 정보 들어있는 API" → 회원등급 API를 잡아냄
- "슬러그 필드 쓰는 응답 어디야" → 필드명으로 후보가 좁혀짐

정밀하게는 실제 필드명(camelCase)으로, 막연하면 한국어 필드설명으로 검색하면 된다.

검색 결과엔 **"근거"**(요약/필드명/경로 등 어디서 매칭됐는지)가 붙어, **왜 이 API가 떴는지** 바로 알 수 있다.
필드명 때문에 떴는지, 요약 때문인지가 보이므로 `get_api_detail`을 덜 헤매고 호출한다.

## 동작 원리 (요약)

1. `spec/*.yml` 을 전부 파싱 → 오퍼레이션 1개 = 레코드 1개로 평탄화.
   각 레코드에 method·path·operationId·tags·summary·description·**parameters(필터)**·**응답/요청 필드명** 포함.
2. 검색은 한국어 summary/태그설명/operationId/path/파라미터/**스키마 필드명**을 가중치로 스코어링하는 키워드 매칭.
   샵바이 스펙의 summary·description이 한국어라서 "장바구니" 같은 한국어 질의가 그대로 먹힌다.
   (가중치: summary·태그설명 5 > operationId 4 > path·태그 3 > description·**필드명** 2 > 파라미터 1)
   **recall 보강**: 한↔영 도메인 동의어(적립금↔reserve, 등급↔grade…)와 camelCase 분해(brandNo→brand/no)로
   한국어 질의가 영어 필드명·경로에도 닿는다. 각 검색어는 가장 강하게 걸린 필드 점수만 합산(정규화)해 더 많은 단어를 충족하는 API가 상위로 온다.
3. 검색·상세조회 모두 `$ref`(`#/components/schemas/...`)를 재귀적으로 해석한다.
   상세조회는 응답 구조까지 펼쳐 보여주고, 색인은 필드명을 평탄화해 담는다.

## 자동 최신화 (스펙 갱신 대응)

샵바이는 매달/상시로 API를 업데이트한다. 인덱스(`config.json`)와 yml URL은 **항상 최신본**을 서빙하고
서버가 ETag/Last-Modified를 주므로, MCP 서버는 **시작할 때 자동으로 최신 여부를 점검**한다.

시작 시퀀스:
1. **인덱스 갱신** — `https://docs.shopby.co.kr/config.json` 을 조건부로 받아 최신 파일 목록 확보
2. **yml 갱신** — 그 최신 인덱스 기준으로 각 yml 을 조건부로 점검 → **바뀐 파일만** 받음
3. 캐시의 yml 로 검색 인덱스 빌드 → MCP 서버 기동

- MCP는 세션마다 새로 켜지므로, **새 Claude 세션을 열면 자동 반영**된다(실행 중 세션 도중엔 안 바뀜).
- **새 모듈(새 yml 파일) 추가도 자동 발견**된다 — 인덱스를 함께 갱신하므로 새 파일명이 생기면 그 yml까지 자동으로 받는다.
- 대부분 304라 빠르다. 변경/신규/실패 내역은 stderr에 로그된다.
- 오프라인/장애 시엔 **이미 받아둔 캐시**로 조용히 폴백한다. 인덱스(config.json)는 동봉 `specs-index.json` 으로 폴백.
- **단, 캐시도 없는 첫 실행이 오프라인이면 0건이 된다**(동봉 yml seed 없음). 차단 환경이면 yml을 `~/.cache/shopby-mcp/spec/` 에 직접 넣으면 된다.

**점검 주기(TTL):** 샵바이 스펙은 보통 **몇 주~한 달** 간격으로 바뀌므로, 세션마다 네트워크 점검하는 건 낭비다.
그래서 기본 TTL이 **24시간**이다 — 마지막 점검이 24h 안이면 **네트워크 0회로 즉시 시작**하고, 24h이 지났을 때만 한 번 조건부 점검한다.
"지금 당장 최신"이 필요하면 `--refresh`(또는 `SHOPBY_MCP_MAX_AGE=0`)로 강제, 더 늦춰도 되면 `SHOPBY_MCP_MAX_AGE=604800`(7일) 식으로 키우면 된다.

**캐시 위치**: `~/.cache/shopby-mcp/` (`spec/*.yml`, `specs-index.json`, ETag 저장 `.etags.json`).
패키지 디렉터리가 아니라 사용자 캐시에 두어 npx/전역 설치(읽기전용)에서도 동작한다.

플래그 / 환경변수:

| 플래그·변수 | 기본값 | 설명 |
|------|--------|------|
| `--refresh` | — | ETag 무시하고 인덱스+yml 전체 강제 재다운로드 (`node shopby-mcp.mjs --refresh`, `npm run download -- --refresh`) |
| `SHOPBY_MCP_NO_REFRESH` | `0` | `1`이면 시작 시 점검 끔(캐시만 사용) |
| `SHOPBY_MCP_MAX_AGE` | `86400` (24h) | 초 단위. 마지막 점검이 이 시간 안이면 네트워크 점검 생략. `0`이면 매 세션 점검 |
| `SHOPBY_MCP_CACHE_DIR` | `~/.cache/shopby-mcp` | 캐시 디렉터리 위치 |
| `SHOPBY_MCP_INDEX_URL` | `docs.shopby.co.kr/config.json` | 인덱스 URL(샵바이 도메인 변경 시) |
| `SHOPBY_REQUEST_TIMEOUT_MS` | `8000` | 파일당 요청 타임아웃(병렬이라 전체 소요도 사실상 이 한도) |

수동 갱신도 가능: `npm run download` (인덱스+yml 조건부 점검).

> ℹ️ admin/internal 영역은 **의도적으로 제외**한다(관리자/내부용이라 봇 대상이 아님).
> 인덱스에는 들어 있어도 `cache-paths.mjs` 의 `HOST_BY_CATEGORY` 에 호스트가 없어 받지 않는다. 즉 shop+server만 인덱싱.

## 확장 아이디어

- **의미 검색**: 키워드로 부족하면 각 오퍼레이션 요약을 임베딩해 벡터검색 추가(코퍼스가 작아 굳이 없어도 잘 된다).
- **사내 슬랙봇**: `shopby-index.mjs`의 `search`/`getApi`를 그대로 import 해서 슬랙 슬래시커맨드로 노출.
