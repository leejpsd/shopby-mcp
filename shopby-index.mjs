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
// 한글 합성어 분해용 도메인 어휘. 동의어 사전 키 중 구조어(리스트/목록/조회/검색)는 너무 흔해
// 노이즈가 되므로 합성어 분해에서 제외한다 — "장바구니리스트"에서는 도메인어 '장바구니'만 뽑는다.
// (구조어는 사용자가 별도 단어로 쳤을 때의 일반 동의어 확장 경로에서는 여전히 동작한다)
const KO_GENERIC = new Set(["목록", "리스트", "조회", "검색"]);
const KO_KEYS = Object.keys(SYNONYMS).filter((k) => !KO_GENERIC.has(k));

// 질의를 가중치 있는 검색어로 확장: 원어(1.0) + camelCase 분해(0.6) + 동의어 양방향(0.6) + 한글 합성어 분해(0.6)
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
    // 한글 합성어: 도메인 어휘가 부분문자열로 들어있으면 그것만 뽑고 영어 동의어도 같이 붙인다(접미사는 제외)
    if (/[가-힣]/.test(word) && word.length >= 4) {
      for (const term of KO_KEYS) {
        if (term.length >= 2 && term !== word && word.includes(term)) {
          add(term, 0.6);
          for (const s of SYNONYMS[term]) add(s, 0.5);
        }
      }
    }
  }
  return [...best.entries()].map(([term, w]) => ({ term, w }));
}

export function search(query, { category, limit = 10 } = {}) {
  const terms = expandQuery(query);
  const scored = [];
  for (const r of INDEX) {
    if (category && !r.source.includes(category)) continue;
    // 검색 대상 텍스트 (가중치 + 라벨로 분리; 라벨은 '왜 매칭됐는지' 근거 표시용)
    const haystacks = [
      { w: 5, label: "요약", t: r.summary },
      { w: 5, label: "태그설명", t: r.tagDescriptions.join(" ") },
      { w: 4, label: "operationId", t: r.operationId },
      { w: 3, label: "경로", t: r.path },
      { w: 3, label: "태그", t: r.tags.join(" ") },
      { w: 2, label: "설명", t: r.description },
      { w: 2, label: "필드명", t: r.schemaFields }, // 응답/요청 바디 필드명·설명
      { w: 1, label: "파라미터", t: r.params.map((p) => `${p.name} ${p.description}`).join(" ") },
    ].map((h) => ({ ...h, t: (h.t || "").toLowerCase() }));

    // 정규화: 각 검색어는 "가장 강하게 걸린 필드" 점수만 합산 → 한 단어가 여러 필드에 있다고 과대평가 안 함.
    // 결과적으로 서로 다른 검색어를 더 많이 충족(coverage)하는 API가 상위로 온다.
    let score = 0;
    const hit = new Set();
    for (const { term, w } of terms) {
      let best = 0;
      for (const h of haystacks) if (h.t.includes(term)) { best = Math.max(best, h.w * w); hit.add(h.label); }
      score += best;
    }
    // 근거는 가중치 높은 순 상위 3개만 (동의어가 여러 필드에 걸려도 노이즈/토큰 통제)
    if (score > 0) scored.push({ score, r, matched: haystacks.filter((h) => hit.has(h.label)).map((h) => h.label).slice(0, 3) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ score, r, matched }) => ({
    score: Math.round(score * 10) / 10,
    source: r.source,
    method: r.method,
    path: r.path,
    operationId: r.operationId,
    tags: r.tags,
    summary: r.summary,
    filterCount: r.params.filter((p) => p.in === "query").length,
    matched, // 어느 필드에서 걸렸는지 (요약/필드명/경로 …) — 가중치 높은 순
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

// ctx.cap = 펼칠 총 필드 수 상한(너비가 큰 주문/클레임 응답이 토큰을 폭주시키는 것 방지).
function expand(spec, schema, depth = 0, seen = new Set(), ctx = { n: 0, cap: Infinity }) {
  if (!schema || depth > 4) return schema;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return { $ref: schema.$ref, _circular: true };
    seen = new Set(seen).add(schema.$ref);
    return expand(spec, resolveRef(spec, schema.$ref), depth, seen, ctx);
  }
  if (schema.type === "array" && schema.items)
    return { type: "array", items: expand(spec, schema.items, depth + 1, seen, ctx) };
  if (schema.properties) {
    const props = {};
    const entries = Object.entries(schema.properties);
    for (let i = 0; i < entries.length; i++) {
      if (ctx.n >= ctx.cap) {
        props._truncated = `…(+${entries.length - i}개 필드 생략 — 응답이 큼. 특정 필드는 search_apis로 검색)`;
        break;
      }
      ctx.n++;
      const [k, v] = entries[i];
      props[k] = expand(spec, v, depth + 1, seen, ctx);
    }
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
export function getApi({ operationId, source, path, method, section = "all" } = {}) {
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
  const PROP_CAP = 120; // 응답/요청 바디당 펼칠 필드 상한 (토큰 폭주 방지)

  // 헤더는 항상 가볍게. section 으로 무거운 부분(요청/응답 스키마)만 선택적으로 펼친다.
  const out = {
    source: r.source,
    method: r.method,
    fullUrl: r.fullUrl,
    operationId: r.operationId,
    tags: r.tags,
    summary: r.summary,
    description: r.description,
    section,
  };
  const want = (s) => section === "all" || section === s;

  if (want("filters")) out.filters = r.params; // 쿼리/경로 파라미터 (가볍다)

  if (want("request")) {
    const rb = pickContent(op.requestBody?.content);
    out.requestBody = rb.schema
      ? { mediaType: rb.mediaType, schema: expand(spec, rb.schema, 0, new Set(), { n: 0, cap: PROP_CAP }) }
      : null;
  }

  if (want("response")) {
    const responses = {};
    for (const [code, res] of Object.entries(op.responses ?? {})) {
      const c = pickContent(res.content);
      responses[code] = {
        description: res.description ?? "",
        mediaType: c.mediaType,
        schema: c.schema ? expand(spec, c.schema, 0, new Set(), { n: 0, cap: PROP_CAP }) : null,
      };
    }
    out.responses = responses;
  }

  return out;
}

export function stats() {
  return { specs: Object.keys(SPECS).length, operations: INDEX.length };
}

// ── 5. 브라우징 (태그/카테고리로 둘러보기) ─────────────────
// 인자 없이 listTags → 도메인 메뉴. listApis(tag/category) → 그 도메인 엔드포인트 목록.
export function listTags({ category } = {}) {
  const counts = new Map();
  for (const r of INDEX) {
    if (category && !r.source.includes(category)) continue;
    for (const t of (r.tags.length ? r.tags : ["(no tag)"])) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
}

export function listApis({ tag, category, limit = 50 } = {}) {
  let rows = INDEX;
  if (category) rows = rows.filter((r) => r.source.includes(category));
  if (tag) {
    const lt = tag.toLowerCase();
    rows = rows.filter((r) => r.tags.some((t) => t.toLowerCase().includes(lt)));
  }
  const total = rows.length;
  const items = rows.slice(0, limit).map((r) => ({
    method: r.method,
    path: r.path,
    operationId: r.operationId,
    summary: r.summary,
    source: r.source,
    tags: r.tags,
    filterCount: r.params.filter((p) => p.in === "query").length,
  }));
  return { total, returned: items.length, items };
}

export { loadAll };
loadAll();
