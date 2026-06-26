// shopby-index.mjs — 샵바이 OpenAPI 스펙 로더 + 검색 코어
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { SPEC_DIR as CACHE_SPEC_DIR, BUNDLED_SPEC_DIR } from "./cache-paths.mjs";

// 캐시(~/.cache/shopby-mcp/spec)를 우선 읽고, 비어 있으면 패키지 동봉본으로 폴백.
function resolveSpecDir() {
  if (existsSync(CACHE_SPEC_DIR) && readdirSync(CACHE_SPEC_DIR).some((f) => f.endsWith(".yml")))
    return CACHE_SPEC_DIR;
  return BUNDLED_SPEC_DIR;
}

// ── 1. 모든 yml 로드 + 평탄화 ───────────────────────────────
let SPECS = {};      // { filename: parsedSpec }  ($ref 해석용 원본 보관
let INDEX = [];      // 오퍼레이션 1개 = 레코드 1개

function loadAll() {
  SPECS = {};
  INDEX = [];
  const dir = resolveSpecDir();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yml")) : [];
  for (const file of files) {
    let spec;
    try {
      spec = YAML.parse(readFileSync(join(dir, file), "utf-8"));
    } catch (e) {
      console.error(`[skip] ${file}: ${e.message}`);
      continue;
    }
    SPECS[file] = spec;
    const base = spec?.servers?.[0]?.url ?? "";
    const tagDesc = Object.fromEntries(
      (spec?.tags ?? []).map((t) => [t.name, t.description ?? ""])
    );
    for (const [path, methods] of Object.entries(spec?.paths ?? {})) {
      for (const [method, op] of Object.entries(methods)) {
        if (!["get", "post", "put", "delete", "patch"].includes(method)) continue;
        const params = (op.parameters ?? []).map((p) => ({
          name: p.name,
          in: p.in,
          required: !!p.required,
          type: p.schema?.type ?? null,
          enum: p.schema?.enum ?? null,
          description: (p.description ?? "").trim(),
        }));
        INDEX.push({
          source: file,
          base,
          method: method.toUpperCase(),
          path,
          fullUrl: base + path,
          operationId: op.operationId ?? "",
          tags: op.tags ?? [],
          tagDescriptions: (op.tags ?? []).map((t) => tagDesc[t]).filter(Boolean),
          summary: (op.summary ?? "").trim(),
          description: (op.description ?? "").trim(),
          params,
          schemaFields: schemaFieldText(spec, op), // 응답+요청 바디 필드명·설명 (검색 색인용)
          _op: op, // 상세조회/ref해석용
        });
      }
    }
  }
  return { files: files.length, operations: INDEX.length };
}

// ── 2. 키워드 검색 (한국어 summary/description 기반) ─────────
// 도메인 동의어(한↔영). 필드명/경로는 영어, 질의는 한국어인 미스매치를 메운다. 보수적으로 유지.
const SYNONYMS = {
  적립금: ["reserve", "accumulation", "point"], 적립: ["reserve", "accumulation"], 포인트: ["point", "reserve"],
  등급: ["grade"], 회원: ["member"], 회원가입: ["join", "signup", "register"], 가입: ["join", "signup"],
  탈퇴: ["withdraw", "leave", "expel"], 휴면: ["dormant"],
  배송: ["delivery", "shipping"], 배송지: ["address", "delivery"], 주소: ["address"],
  주문: ["order"], 장바구니: ["cart"], 상품: ["product", "goods"], 재고: ["stock", "inventory"], 브랜드: ["brand"],
  쿠폰: ["coupon"], 결제: ["payment", "pay"], 취소: ["cancel"], 환불: ["refund"],
  반품: ["return", "claim"], 교환: ["exchange", "claim"], 클레임: ["claim"],
  카테고리: ["category"], 목록: ["list"], 리스트: ["list"], 조회: ["get", "inquiry"], 검색: ["search"],
  문의: ["inquiry", "qna"], 찜: ["like", "wish"], 좋아요: ["like"], 배너: ["banner"], 이벤트: ["event"],
  프로모션: ["promotion"], 할인: ["discount", "sale"], 옵션: ["option"], 리뷰: ["review"], 후기: ["review"],
  인증: ["auth", "authentication"], 로그인: ["login", "signin", "auth"], 정산: ["settlement"],
};
const SYN_ENTRIES = Object.entries(SYNONYMS);

// 질의를 가중치 있는 검색어로 확장: 원어(1.0) + camelCase 분해(0.6) + 동의어 양방향(0.6)
function expandQuery(q) {
  const best = new Map(); // term -> weight
  const add = (term, w) => {
    term = String(term).toLowerCase();
    if (term.length < 2) return;
    if ((best.get(term) ?? 0) < w) best.set(term, w);
  };
  for (const word of q.split(/[\s,/]+/).filter(Boolean)) {
    add(word, 1);
    const parts = word
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Za-z])(\d)/g, "$1 $2")
      .split(/[\s_-]+/)
      .filter(Boolean);
    if (parts.length > 1) for (const p of parts) add(p, 0.6); // camelCase/숫자 경계 분해
    const lw = word.toLowerCase();
    if (SYNONYMS[lw]) for (const s of SYNONYMS[lw]) add(s, 0.6);
    for (const [k, vs] of SYN_ENTRIES)
      if (k === lw || vs.includes(lw)) { add(k, 0.6); for (const s of vs) add(s, 0.6); } // 양방향
  }
  return [...best.entries()].map(([term, w]) => ({ term, w }));
}

export function search(query, { category, limit = 10 } = {}) {
  const terms = expandQuery(query);
  const scored = [];
  for (const r of INDEX) {
    if (category && !r.source.includes(category)) continue;
    // 검색 대상 텍스트 (가중치를 위해 분리)
    const haystacks = [
      { w: 5, t: r.summary },
      { w: 5, t: r.tagDescriptions.join(" ") },
      { w: 4, t: r.operationId },
      { w: 3, t: r.path },
      { w: 3, t: r.tags.join(" ") },
      { w: 2, t: r.description },
      { w: 2, t: r.schemaFields }, // 응답/요청 바디 필드명·설명
      { w: 1, t: r.params.map((p) => `${p.name} ${p.description}`).join(" ") },
    ].map((h) => ({ w: h.w, t: (h.t || "").toLowerCase() }));

    // 정규화: 각 검색어는 "가장 강하게 걸린 필드" 점수만 합산 → 한 단어가 여러 필드에 있다고 과대평가 안 함.
    // 결과적으로 서로 다른 검색어를 더 많이 충족(coverage)하는 API가 상위로 온다.
    let score = 0;
    for (const { term, w } of terms) {
      let best = 0;
      for (const h of haystacks) if (h.t.includes(term)) best = Math.max(best, h.w * w);
      score += best;
    }
    if (score > 0) scored.push({ score, r });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ score, r }) => ({
    score: Math.round(score * 10) / 10,
    source: r.source,
    method: r.method,
    path: r.path,
    operationId: r.operationId,
    tags: r.tags,
    summary: r.summary,
    filterCount: r.params.filter((p) => p.in === "query").length,
  }));
}

// ── 3. $ref 해석 ───────────────────────────────────────────
function resolveRef(spec, ref) {
  // "#/components/schemas/Xxx" → 객체
  const parts = ref.replace(/^#\//, "").split("/");
  let cur = spec;
  for (const p of parts) cur = cur?.[p];
  return cur;
}

function expand(spec, schema, depth = 0, seen = new Set()) {
  if (!schema || depth > 4) return schema;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return { $ref: schema.$ref, _circular: true };
    seen = new Set(seen).add(schema.$ref);
    return expand(spec, resolveRef(spec, schema.$ref), depth, seen);
  }
  if (schema.type === "array" && schema.items)
    return { type: "array", items: expand(spec, schema.items, depth + 1, seen) };
  if (schema.properties) {
    const props = {};
    for (const [k, v] of Object.entries(schema.properties))
      props[k] = expand(spec, v, depth + 1, seen);
    return { type: "object", properties: props, ...(schema.description ? { description: schema.description } : {}) };
  }
  return schema;
}

// content-type 키가 "application/json;charset=UTF-8" 처럼 suffix가 붙을 수 있어 정확 일치로는 놓친다.
// application/json 계열을 prefix로 우선 찾고, 없으면(multipart/text 등) 첫 타입을 쓴다.
function pickContent(content) {
  if (!content || typeof content !== "object") return { mediaType: null, schema: null };
  const keys = Object.keys(content);
  const jsonKey = keys.find((k) => k.toLowerCase().startsWith("application/json"));
  const key = jsonKey ?? keys[0] ?? null;
  return { mediaType: key, schema: key ? content[key]?.schema ?? null : null };
}

// ── 3b. 검색 색인용 필드명 수집 ($ref 재귀 해석) ───────────
// 응답/요청 바디 스키마를 펼쳐 필드명과 필드설명을 평탄한 토큰 배열로 모은다.
function collectSchemaFields(spec, schema, depth = 0, seen = new Set(), out = []) {
  if (!schema || depth > 6) return out;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return out;
    seen = new Set(seen).add(schema.$ref);
    return collectSchemaFields(spec, resolveRef(spec, schema.$ref), depth, seen, out);
  }
  if (schema.type === "array" && schema.items)
    return collectSchemaFields(spec, schema.items, depth + 1, seen, out);
  if (schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      out.push(k); // 필드명
      const d = v && typeof v === "object" ? v.description : null;
      if (d) out.push(String(d)); // 필드 설명(한국어)
      collectSchemaFields(spec, v, depth + 1, seen, out);
    }
  }
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    if (Array.isArray(schema[key])) for (const s of schema[key]) collectSchemaFields(spec, s, depth + 1, seen, out);
  }
  return out;
}

// 한 오퍼레이션의 요청바디 + 모든 응답 스키마 필드를 하나의 검색 문자열로 (중복 제거)
function schemaFieldText(spec, op) {
  const out = [];
  const rb = pickContent(op?.requestBody?.content).schema;
  if (rb) collectSchemaFields(spec, rb, 0, new Set(), out);
  for (const res of Object.values(op?.responses ?? {})) {
    const s = pickContent(res?.content).schema;
    if (s) collectSchemaFields(spec, s, 0, new Set(), out);
  }
  return [...new Set(out)].join(" ");
}

// ── 4. 상세 조회 ───────────────────────────────────────────
export function getApi({ operationId, source, path, method }) {
  // operationId 우선. 동일 id가 shop/server 양쪽에 있을 수 있어 후보가 여러 개일 수 있다.
  let matches = operationId ? INDEX.filter((x) => x.operationId === operationId) : [];
  // operationId 매치가 없으면 source+path+method 로 조회
  if (!matches.length && source && path && method)
    matches = INDEX.filter((x) => x.source === source && x.path === path && x.method === method.toUpperCase());
  // source 힌트("shop"/"server"/파일명 일부)가 있으면 더 좁힌다
  if (source && matches.length > 1) {
    const narrowed = matches.filter((x) => x.source.includes(source));
    if (narrowed.length) matches = narrowed;
  }
  if (!matches.length) return null;
  // 여전히 모호하면 후보 목록을 돌려 호출측이 source로 구분하게 한다 (엉뚱한 스펙 반환 방지)
  if (matches.length > 1) {
    return {
      ambiguous: true,
      operationId,
      candidates: matches.map((m) => ({ method: m.method, path: m.path, source: m.source, summary: m.summary })),
    };
  }

  const r = matches[0];
  const spec = SPECS[r.source];
  const op = r._op;

  let requestBody = null;
  const rb = pickContent(op.requestBody?.content);
  if (rb.schema) requestBody = { mediaType: rb.mediaType, schema: expand(spec, rb.schema) };

  const responses = {};
  for (const [code, res] of Object.entries(op.responses ?? {})) {
    const c = pickContent(res.content);
    responses[code] = {
      description: res.description ?? "",
      mediaType: c.mediaType,
      schema: c.schema ? expand(spec, c.schema) : null,
    };
  }

  return {
    source: r.source,
    method: r.method,
    fullUrl: r.fullUrl,
    operationId: r.operationId,
    tags: r.tags,
    summary: r.summary,
    description: r.description,
    filters: r.params, // 필터(쿼리 파라미터) 포함 전체 파라미터
    requestBody,
    responses,
  };
}

export function stats() {
  return { specs: Object.keys(SPECS).length, operations: INDEX.length };
}

export { loadAll };
loadAll();
