#!/usr/bin/env node
// shopby-mcp.mjs — 샵바이 API 문서 검색 MCP 서버 (stdio)
// Claude Code / Claude Desktop 에서 "장바구니 api 찾아줘" 등에 응답
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { refreshAll } from "./download-specs.mjs";
import { ETAGS_FILE, SPEC_DIR } from "./cache-paths.mjs";

// ── 시작 시 자동 최신화 ────────────────────────────────────────
// MCP는 세션마다 새로 켜지므로, 여기서 한 번 점검하면 새 Claude 세션마다 자동 반영된다.
//  - (0) 원격 config.json(인덱스) 조건부 갱신 → (1) 최신 인덱스 기준 yml 조건부 갱신 → 새 모듈도 자동 발견
//  - 304가 대부분이라 빠름. 오프라인/장애 시엔 받아둔 캐시로 조용히 폴백(인덱스는 동봉 specs-index.json)
//  - 플래그: --refresh(전체 강제) / SHOPBY_MCP_NO_REFRESH=1(점검 끔) / SHOPBY_MCP_MAX_AGE=<초>(그 안엔 점검 생략)
//  - 샵바이 스펙은 몇 주~한 달 주기로 바뀌므로 기본 TTL을 24h로 둔다 → 평상시 세션 시작은 네트워크 0회.
//    "지금 당장 최신"이 필요하면 --refresh 또는 SHOPBY_MCP_MAX_AGE=0.
const FORCE = process.argv.includes("--refresh");
const NO_REFRESH = process.env.SHOPBY_MCP_NO_REFRESH === "1";
const MAX_AGE_SEC = Number(process.env.SHOPBY_MCP_MAX_AGE ?? 86400); // 기본 24h. 0 = 매 기동 점검

function secondsSinceLastRefresh() {
  try {
    const { lastRefresh } = JSON.parse(readFileSync(ETAGS_FILE, "utf-8"));
    if (!lastRefresh) return Infinity;
    return (Date.now() - new Date(lastRefresh).getTime()) / 1000;
  } catch {
    return Infinity;
  }
}

function hasCachedSpecs() {
  try {
    return existsSync(SPEC_DIR) && readdirSync(SPEC_DIR).some((f) => f.endsWith(".yml"));
  } catch {
    return false;
  }
}

async function startupRefresh() {
  if (NO_REFRESH && !FORCE) {
    console.error("[shopby-mcp] refresh off (SHOPBY_MCP_NO_REFRESH=1) — using cache");
    return;
  }
  // TTL 게이트는 "캐시에 스펙이 있을 때만" 적용. 비었으면(오프라인 첫 실행 실패 등) lastRefresh 스탬프가
  // 찍혀 있어도 무조건 재시도 → 사내망/프록시 차단 후 24h 락아웃 방지.
  if (!FORCE && MAX_AGE_SEC > 0 && hasCachedSpecs()) {
    const age = secondsSinceLastRefresh();
    if (age < MAX_AGE_SEC) {
      console.error(
        `[shopby-mcp] cache fresh (${(age / 3600).toFixed(1)}h, TTL ${(MAX_AGE_SEC / 3600).toFixed(0)}h) — skip refresh (no network)`
      );
      return;
    }
  }
  console.error(`[shopby-mcp] checking updates${FORCE ? " (--refresh: force)" : ""}…`);
  try {
    const s = await refreshAll({ force: FORCE }); // 각 요청 타임아웃 캡 → 전체도 사실상 캡
    if (s.indexChanged) console.error("[shopby-mcp] index (config.json) updated");
    if (s.firstRun && s.new.length) console.error(`[shopby-mcp] initial download: ${s.new.length} spec(s)`);
    else if (s.new.length) console.error(`[shopby-mcp] NEW module(s) discovered: ${s.new.join(", ")}`);
    if (s.updated.length) console.error(`[shopby-mcp] updated ${s.updated.length}: ${s.updated.join(", ")}`);
    if (s.pruned?.length) console.error(`[shopby-mcp] removed ${s.pruned.length} stale spec(s): ${s.pruned.join(", ")}`);
    if (!s.new.length && !s.updated.length && !s.pruned?.length) console.error("[shopby-mcp] no spec changes");
    if (s.failed.length) console.error(`[shopby-mcp] ${s.failed.length} fetch failed — using cached for those`);
  } catch (e) {
    console.error(`[shopby-mcp] refresh skipped (${e.message}) — using cached specs`);
  }
}

await startupRefresh();

// 최신화 후에 인덱스를 로드해야 변경분이 반영된다 (shopby-index 는 import 시점에 spec 을 읽음)
const { search, getApi, stats, listTags, listApis } = await import("./shopby-index.mjs");

// 첫 실행이 오프라인이면 캐시가 비어 0건이 될 수 있다 — 동봉 yml seed 가 없으므로 정직하게 안내한다.
// (캐시가 비면 TTL을 무시하므로 다음 세션마다 자동 재시도된다 — 락아웃 없음)
if (stats().operations === 0)
  console.error(
    "[shopby-mcp] ⚠ 스펙 0건 — 첫 실행엔 네트워크가 필요합니다(원격에서 다운로드). " +
      "네트워크가 되면 다음 세션에서 자동 재시도하며, 지금 강제하려면 --refresh. " +
      "차단 환경이면 yml을 직접 ~/.cache/shopby-mcp/spec/ 에 넣으세요."
  );

const server = new McpServer({ name: "shopby-api-docs", version: "1.0.0" });

server.registerTool(
  "search_apis",
  {
    title: "샵바이 API 검색",
    description:
      "샵바이(Shopby) API를 자연어로 검색한다. 한국어 설명/태그/operationId/경로와 응답·요청 바디의 필드명까지 검색한다. " +
      "'특정 필드가 들어있는 API 찾기'(예: 등급/슬러그/적립률 필드를 쓰는 API)도 가능. " +
      "예: '장바구니 리스트', '브랜드 목록', '주문 취소', '적립금 조회'. " +
      "결과로 method/path/operationId/요약/필터개수를 반환한다. " +
      "상세(필터 목록·요청바디·응답)는 반환된 operationId로 get_api_detail을 호출할 것.",
    inputSchema: {
      query: z.string().describe("검색어 (한국어 가능)"),
      category: z
        .enum(["shop", "server"])
        .optional()
        .describe("스펙 영역 필터. shop=프론트 호출용, server=서버 연동용 (admin/internal은 미수집이라 선택지에 없음)"),
      limit: z.number().int().min(1).max(30).default(10).optional(),
    },
  },
  async ({ query, category, limit }) => {
    const hits = search(query, { category, limit: limit ?? 10 });
    if (!hits.length)
      return { content: [{ type: "text", text: `'${query}' 검색결과 없음. 더 일반적인 키워드로 재시도해보세요.` }] };
    const lines = hits.map(
      (h) =>
        `${h.method} ${h.path}\n  operationId: ${h.operationId}\n  요약: ${h.summary}\n  태그: ${h.tags.join(", ")} | 필터 ${h.filterCount}개 | 출처: ${h.source}` +
        (h.matched?.length ? `\n  근거: ${h.matched.join(", ")} 매칭` : "")
    );
    return { content: [{ type: "text", text: `'${query}' 검색결과 ${hits.length}건:\n\n${lines.join("\n\n")}` }] };
  }
);

server.registerTool(
  "get_api_detail",
  {
    title: "샵바이 API 상세조회",
    description:
      "operationId로 특정 API의 명세를 조회한다. 필터(쿼리/경로 파라미터)·요청 바디(미디어타입 포함)·응답 스키마. " +
      "'이 API에 무슨 필터 있어?'면 section:'filters'(가장 가벼움), 응답 구조가 필요할 때만 section:'response'. " +
      "주문/클레임 상세는 응답이 매우 크니(최대 ~2만 토큰) 먼저 filters로 보는 것을 권장. " +
      "동일 operationId가 shop/server 양쪽에 있으면 후보 목록을 돌려주니 source로 다시 호출할 것.",
    inputSchema: {
      operationId: z.string().describe("search_apis 결과의 operationId"),
      source: z
        .string()
        .optional()
        .describe("동일 operationId가 여러 스펙에 있을 때 구분용. 예: 'shop', 'server', 또는 출처 파일명 일부"),
      section: z
        .enum(["all", "filters", "request", "response"])
        .default("all")
        .optional()
        .describe("반환 범위. filters=파라미터만(최경량), request=요청바디, response=응답스키마, all=전체(기본)"),
    },
  },
  async ({ operationId, source, section }) => {
    const d = getApi({ operationId, source, section });
    if (!d) return { content: [{ type: "text", text: `operationId '${operationId}' 못 찾음.` }] };
    if (d.ambiguous) {
      const lines = d.candidates.map((c) => `- ${c.method} ${c.path}  | 출처: ${c.source}  | ${c.summary}`);
      return {
        content: [
          {
            type: "text",
            text:
              `operationId '${operationId}' 가 여러 스펙에 존재합니다. source 인자로 구분해 다시 호출하세요 ` +
              `(예: source:"shop" 또는 "server").\n\n${lines.join("\n")}`,
          },
        ],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
  }
);

server.registerTool(
  "list_apis",
  {
    title: "샵바이 API 목록/브라우징",
    description:
      "태그(도메인) 또는 category로 API를 둘러본다. 인자 없이 호출하면 태그 목록(+개수)을 돌려주니 " +
      "'주문 도메인에 뭐 있어?' '회원으로 뭘 할 수 있어?' 같은 탐색에 사용. tag를 주면 그 도메인의 엔드포인트를 " +
      "한 줄씩 나열한다(스키마는 안 줌 — 상세는 get_api_detail). 키워드를 모를 때 검색 대신 목록으로 훑는 용도.",
    inputSchema: {
      tag: z.string().optional().describe("도메인 태그(부분일치). 예: Order, Member, Brand, Coupon"),
      category: z.enum(["shop", "server"]).optional().describe("스펙 영역. shop=프론트호출용, server=서버연동"),
      limit: z.number().int().min(1).max(200).default(50).optional(),
    },
  },
  async ({ tag, category, limit }) => {
    if (!tag && !category) {
      const tags = listTags();
      const lines = tags.map((t) => `${t.tag} (${t.count})`);
      return { content: [{ type: "text", text: `태그(도메인) ${tags.length}개. tag 인자로 도메인을 지정해 목록을 보세요:\n\n${lines.join("\n")}` }] };
    }
    const { total, returned, items } = listApis({ tag, category, limit: limit ?? 50 });
    if (!total) return { content: [{ type: "text", text: `'${tag ?? category}' 에 해당하는 API 없음.` }] };
    const lines = items.map((h) => `${h.method} ${h.path}  → ${h.operationId} | ${h.summary} (필터 ${h.filterCount}, ${h.source})`);
    const more = total > returned ? `\n\n…외 ${total - returned}개 더 있음 (limit 올려 재호출).` : "";
    return { content: [{ type: "text", text: `'${tag ?? category}' ${total}건${total > returned ? ` (상위 ${returned})` : ""}:\n\n${lines.join("\n")}${more}` }] };
  }
);

server.registerTool(
  "index_stats",
  { title: "인덱스 현황", description: "로드된 스펙 파일 수와 총 API 개수를 반환한다.", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: JSON.stringify(stats()) }] })
);

await server.connect(new StdioServerTransport());
console.error("[shopby-mcp] started:", JSON.stringify(stats()));
