// cache-paths.mjs — shopby-mcp 캐시 경로 (공유)
// npx / 전역 설치에서도 쓰기 가능하도록 패키지 디렉터리가 아니라 사용자 캐시(~/.cache)에 둔다.
// yml 스펙은 패키지에 동봉하지 않고 첫 실행 때 원격에서 캐시로 받는다(=네트워크 필요).
// 패키지에 동봉되는 건 specs-index.json(파일 목록) 하나뿐 — config.json 을 못 받을 때의 폴백 인덱스.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// 패키지 동봉 폴백 인덱스(파일 목록). 원격 config.json 을 못 받을 때만 사용. yml seed 는 동봉하지 않는다.
export const PKG_DIR = HERE;
export const BUNDLED_INDEX = join(PKG_DIR, "specs-index.json");

// 런타임 캐시 위치 (쓰기 가능). 테스트/특수 환경에서 SHOPBY_MCP_CACHE_DIR 로 덮어쓸 수 있다.
export const CACHE_DIR =
  process.env.SHOPBY_MCP_CACHE_DIR || join(homedir(), ".cache", "shopby-mcp");
export const SPEC_DIR = join(CACHE_DIR, "spec");
export const INDEX_FILE = join(CACHE_DIR, "specs-index.json"); // 원격 config.json 캐시본
export const ETAGS_FILE = join(CACHE_DIR, ".etags.json"); // { lastRefresh, entries: { key: {etag,lastModified} } }

// 인덱스(config.json)가 서빙되는 URL. shop/server 둘 다 동일 내용이라 하나만 받으면 됨.
// 샵바이가 도메인을 바꾸거나 테스트할 때 SHOPBY_MCP_INDEX_URL 로 덮어쓸 수 있다.
export const INDEX_URL = process.env.SHOPBY_MCP_INDEX_URL || "https://docs.shopby.co.kr/config.json";

// 카테고리별 yml 호스트.
//  - shop   : 프론트 호출용 → docs.shopby.co.kr
//  - server : 서버 연동용   → server-docs.shopby.co.kr
//  - admin/internal : **의도적 제외** (관리자/내부용이라 봇 대상 아님). 인덱스엔 있어도 받지 않는다.
export const HOST_BY_CATEGORY = {
  shop: "https://docs.shopby.co.kr/spec/",
  server: "https://server-docs.shopby.co.kr/spec/",
};
