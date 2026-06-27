// 스모크 테스트 — 네트워크 의존 없이(hermetic) 핵심 동작 검증.
// tmpdir 에 작은 픽스처 스펙을 만들고 SHOPBY_MCP_CACHE_DIR 로 가리킨 뒤 인덱스를 로드한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";

const cache = mkdtempSync(join(tmpdir(), "shopby-mcp-test-"));
mkdirSync(join(cache, "spec"), { recursive: true });

const shopSpec = {
  openapi: "3.0.0",
  info: { title: "fixture-shop", version: "1" },
  servers: [{ url: "https://shop-api.example.com" }],
  tags: [
    { name: "Cart", description: "장바구니 관련" },
    { name: "Brand", description: "브랜드" },
    { name: "Member", description: "회원" },
  ],
  paths: {
    "/cart": {
      get: {
        operationId: "get-cart",
        tags: ["Cart"],
        summary: "장바구니 가져오기",
        parameters: [{ name: "memberNo", in: "query", required: false, schema: { type: "number" }, description: "회원 번호" }],
        responses: {
          "200": {
            description: "ok",
            // charset 붙은 content-type — prefix 매칭이 안 되면 응답 스키마/필드색인이 누락된다
            content: {
              "application/json;charset=UTF-8": {
                schema: {
                  type: "object",
                  properties: {
                    couponApplicable: { type: "boolean", description: "쿠폰 사용 가능 여부" },
                    reserveAmount: { type: "number", description: "적립금" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/brands/{brandNo}": {
      get: {
        operationId: "get-brand",
        tags: ["Brand"],
        summary: "브랜드 상세 조회",
        parameters: [{ name: "brandNo", in: "path", required: true, schema: { type: "number" } }],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { brandName: { type: "string" } } } } } } },
      },
    },
    "/profile": {
      get: { operationId: "get-profile", tags: ["Member"], summary: "회원정보 조회(shop)", responses: { "200": { description: "ok" } } },
    },
  },
};

const serverSpec = {
  openapi: "3.0.0",
  info: { title: "fixture-server", version: "1" },
  servers: [{ url: "https://server-api.example.com" }],
  tags: [{ name: "Member", description: "회원" }],
  paths: {
    "/profile": {
      get: { operationId: "get-profile", tags: ["Member"], summary: "회원 정보 조회(server)", responses: { "200": { description: "ok" } } },
    },
  },
};

writeFileSync(join(cache, "spec", "fixture-shop-public.yml"), YAML.stringify(shopSpec));
writeFileSync(join(cache, "spec", "fixture-server-public.yml"), YAML.stringify(serverSpec));

process.env.SHOPBY_MCP_CACHE_DIR = cache;
process.env.SHOPBY_MCP_NO_REFRESH = "1"; // 네트워크 안 탐

const { search, getApi, stats, listTags, listApis } = await import("../shopby-index.mjs");

test("인덱스 로드 (픽스처 4 ops)", () => {
  assert.equal(stats().operations, 4, JSON.stringify(stats()));
});

test("한국어 요약 검색", () => {
  assert.equal(search("장바구니")[0].operationId, "get-cart");
});

test("응답 필드 색인 — charset 응답의 필드명도 검색됨", () => {
  assert.ok(search("couponApplicable").some((h) => h.operationId === "get-cart"));
});

test("한↔영 동의어 (쿠폰→coupon, 필드 매칭)", () => {
  assert.ok(search("쿠폰").some((h) => h.operationId === "get-cart"));
});

test("불용어 강등 — '가능 여부'만으론 저점수", () => {
  const hits = search("가능 여부");
  if (hits.length) assert.ok(hits[0].score < 3, `score=${hits[0].score}`);
});

test("검색 결과에 매칭 근거", () => {
  const top = search("장바구니")[0];
  assert.ok(Array.isArray(top.matched) && top.matched.length > 0);
});

test("getApi section=filters → 응답·요청 스키마 미포함(경량)", () => {
  const d = getApi({ operationId: "get-cart", section: "filters" });
  assert.ok(d.filters, "filters 있어야");
  assert.equal(d.responses, undefined);
  assert.equal(d.requestBody, undefined);
});

test("getApi — charset 응답 스키마 해석", () => {
  const d = getApi({ operationId: "get-cart", section: "response" });
  assert.ok(d.responses["200"].schema?.properties?.couponApplicable, "charset 응답도 스키마 잡혀야");
});

test("중복 operationId → 모호성 후보 반환", () => {
  const d = getApi({ operationId: "get-profile" });
  assert.equal(d.ambiguous, true);
  assert.equal(d.candidates.length, 2);
});

test("source로 모호성 해소", () => {
  const d = getApi({ operationId: "get-profile", source: "server" });
  assert.ok(!d.ambiguous);
  assert.match(d.source, /server/);
});

test("category 필터 — server만", () => {
  const hits = search("회원", { category: "server" });
  assert.ok(hits.length > 0 && hits.every((h) => /server/.test(h.source)));
});

test("없는 operationId → null", () => {
  assert.equal(getApi({ operationId: "nope" }), null);
});

test("list_apis — 태그 메뉴/도메인 목록", () => {
  assert.ok(listTags().length >= 1);
  assert.ok(listApis({ tag: "Cart" }).total >= 1);
});

test("1글자 한글 토큰 허용 (throw 없이 동작)", () => {
  assert.doesNotThrow(() => search("찜"));
});
