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
function tokenize(q) {
  return q.toLowerCase().split(/[\s,/]+/).filter(Boolean);
}

export function search(query, { category, limit = 10 } = {}) {
  const tokens = tokenize(query);
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

    let score = 0;
    for (const tok of tokens) {
      for (const h of haystacks) if (h.t.includes(tok)) score += h.w;
    }
    if (score > 0) scored.push({ score, r });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ score, r }) => ({
    score,
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
  const rb = op?.requestBody?.content?.["application/json"]?.schema;
  if (rb) collectSchemaFields(spec, rb, 0, new Set(), out);
  for (const res of Object.values(op?.responses ?? {})) {
    const s = res?.content?.["application/json"]?.schema;
    if (s) collectSchemaFields(spec, s, 0, new Set(), out);
  }
  return [...new Set(out)].join(" ");
}

// ── 4. 상세 조회 ───────────────────────────────────────────
export function getApi({ operationId, source, path, method }) {
  const r = INDEX.find(
    (x) =>
      (operationId && x.operationId === operationId) ||
      (source && path && method && x.source === source && x.path === path && x.method === method.toUpperCase())
  );
  if (!r) return null;
  const spec = SPECS[r.source];
  const op = r._op;

  let requestBody = null;
  const rbSchema = op.requestBody?.content?.["application/json"]?.schema;
  if (rbSchema) requestBody = expand(spec, rbSchema);

  const responses = {};
  for (const [code, res] of Object.entries(op.responses ?? {})) {
    const s = res.content?.["application/json"]?.schema;
    responses[code] = { description: res.description ?? "", schema: s ? expand(spec, s) : null };
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
