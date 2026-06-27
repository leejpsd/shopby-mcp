#!/usr/bin/env node
// download-specs.mjs — 샵바이 스펙 캐시 매니저 (인덱스 + yml 자동 최신화)
//
// 핵심: (0) 원격 config.json(인덱스)을 조건부로 갱신 → (1) 그 최신 인덱스 기준으로 yml 을 조건부로 갱신.
//        인덱스를 함께 갱신하므로 "새 모듈(새 yml 파일) 추가"도 자동 발견된다.
//
//  - 스크립트 직접 실행: `node download-specs.mjs [--refresh]`  (--refresh 는 ETag 무시 전체 재다운로드)
//  - 모듈 import:        `import { refreshAll } from "./download-specs.mjs"`
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CACHE_DIR, SPEC_DIR, INDEX_FILE, ETAGS_FILE,
  INDEX_URL, HOST_BY_CATEGORY, BUNDLED_INDEX,
} from "./cache-paths.mjs";

const PER_REQUEST_TIMEOUT_MS = Number(process.env.SHOPBY_REQUEST_TIMEOUT_MS ?? 8000);
const INDEX_KEY = "__index__";

// ── ETag/Last-Modified 저장소 ──────────────────────────────
function loadEtags() {
  try {
    const m = JSON.parse(readFileSync(ETAGS_FILE, "utf-8"));
    return { lastRefresh: m.lastRefresh ?? null, entries: m.entries ?? {} };
  } catch {
    return { lastRefresh: null, entries: {} };
  }
}
function saveEtags(store) {
  writeFileSync(ETAGS_FILE, JSON.stringify(store, null, 2));
}

// 조건부 GET. 304면 {status:'unchanged'}, 200이면 {status:'fetched', buf, etag, lastModified}, 실패는 {status:'failed'}.
async function conditionalGet(url, prev, { force }) {
  const headers = {};
  if (!force && prev?.etag) headers["If-None-Match"] = prev.etag;
  if (!force && prev?.lastModified) headers["If-Modified-Since"] = prev.lastModified;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (res.status === 304) return { status: "unchanged" };
    if (!res.ok) return { status: "failed", error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: "fetched",
      buf,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    };
  } catch (e) {
    return { status: "failed", error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── (0) 인덱스(config.json) 갱신 → 항상 "사용할 인덱스 객체"를 돌려준다 ──
//   200: 새로 저장 / 304·실패: 캐시본 사용 / 캐시도 없으면 동봉 specs-index.json 으로 폴백
async function refreshIndex(store, { force = false } = {}) {
  let changed = false;
  const r = await conditionalGet(INDEX_URL, store.entries[INDEX_KEY], { force });
  if (r.status === "fetched") {
    // 유효한 JSON 인지 확인 후에만 캐시에 반영
    try {
      JSON.parse(r.buf.toString("utf-8"));
      writeFileSync(INDEX_FILE, r.buf);
      store.entries[INDEX_KEY] = { etag: r.etag ?? null, lastModified: r.lastModified ?? null };
      changed = true;
    } catch {
      // 200인데 JSON 파싱 실패 = INDEX_URL이 HTML/리다이렉트를 주는 등 잘못된 상태.
      // 폴백되어 검색은 되지만 "새 모듈 자동 발견"이 영구히 침묵하므로 가시화한다.
      console.error(
        `[shopby] ⚠ 인덱스 응답이 JSON이 아님 — INDEX_URL(${INDEX_URL})이 잘못됐을 수 있음. ` +
          `폴백 인덱스로 검색은 되지만 '새 모듈 자동 발견'은 동작하지 않음.`
      );
    }
  }

  // 사용할 인덱스 로드: 캐시 → 동봉 specs-index.json 순
  let raw = null;
  if (existsSync(INDEX_FILE)) raw = readFileSync(INDEX_FILE, "utf-8");
  else if (existsSync(BUNDLED_INDEX)) {
    raw = readFileSync(BUNDLED_INDEX, "utf-8");
    writeFileSync(INDEX_FILE, raw); // 동봉 인덱스를 캐시로 복사
  }
  if (!raw) throw new Error("인덱스를 찾을 수 없음 (원격·캐시·동봉 모두 없음)");
  return { index: JSON.parse(raw), changed };
}

// 인덱스 → (호스트, 파일명) 작업목록. shop/server 만 (호스트 매핑이 있는 카테고리).
function buildJobs(index) {
  const jobs = [];
  const seen = new Set();
  for (const [category, arr] of Object.entries(index)) {
    const host = HOST_BY_CATEGORY[category];
    if (!host) continue;
    for (const { url } of arr ?? []) {
      const file = basename(url);
      const key = host + file;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({ host, file });
    }
  }
  return jobs;
}

// ── (1) yml 갱신 (최신 인덱스 기반 → 새 파일 자동 포함) ──
async function refreshSpecs(index, store, { force = false } = {}) {
  const jobs = buildJobs(index);
  const results = await Promise.all(
    jobs.map(async ({ host, file }) => {
      const dest = join(SPEC_DIR, file);
      const isNewFile = !existsSync(dest); // 인덱스엔 있는데 아직 로컬에 없는 = 새로 발견된 파일
      const prev = isNewFile ? null : store.entries[file];
      const r = await conditionalGet(host + file, prev, { force });
      if (r.status === "fetched") {
        writeFileSync(dest, r.buf);
        store.entries[file] = { etag: r.etag ?? null, lastModified: r.lastModified ?? null };
        return { file, status: isNewFile ? "new" : "updated" };
      }
      if (r.status === "unchanged") return { file, status: "unchanged" };
      return { file, status: "failed", error: r.error };
    })
  );
  return results;
}

/**
 * 인덱스 + yml 을 한 번에 최신화한다. 네트워크 실패는 조용히 무시하고 캐시로 진행.
 * 첫 실행은 네트워크 필요(동봉 yml seed 없음). config.json 을 못 받으면 동봉 specs-index.json 으로 폴백.
 * @returns {Promise<{firstRun:boolean, indexChanged:boolean, updated:string[], new:string[],
 *   unchanged:number, failed:{file:string,error:string}[], lastRefresh:string}>}
 */
export async function refreshAll({ force = false } = {}) {
  mkdirSync(SPEC_DIR, { recursive: true });
  const store = loadEtags();
  const firstRun = Object.keys(store.entries).length === 0; // 이전 기록이 전혀 없음 = 최초 실행

  const { index, changed: indexChanged } = await refreshIndex(store, { force });
  const results = await refreshSpecs(index, store, { force });

  store.lastRefresh = new Date().toISOString();
  saveEtags(store);

  return {
    firstRun,
    indexChanged,
    updated: results.filter((r) => r.status === "updated").map((r) => r.file),
    new: results.filter((r) => r.status === "new").map((r) => r.file),
    unchanged: results.filter((r) => r.status === "unchanged").length,
    failed: results.filter((r) => r.status === "failed").map((r) => ({ file: r.file, error: r.error })),
    lastRefresh: store.lastRefresh,
  };
}

// ── 스크립트 직접 실행 ──────────────────────────────────────
async function main() {
  const force = process.argv.includes("--refresh");
  console.log(`샵바이 스펙 최신화${force ? " (--refresh: 전체 강제)" : ""} → ${CACHE_DIR}`);
  const s = await refreshAll({ force });
  console.log(`  인덱스: ${s.indexChanged ? "갱신됨" : "변경 없음"}`);
  if (s.firstRun && s.new.length) console.log(`  ⬇ 최초 다운로드: ${s.new.length}개`);
  else if (s.new.length) console.log(`  ＋ 신규 발견: ${s.new.join(", ")}`);
  if (s.updated.length) console.log(`  ↻ 갱신: ${s.updated.join(", ")}`);
  console.log(
    `\n완료: 신규 ${s.new.length}, 갱신 ${s.updated.length}, 동일 ${s.unchanged}, 실패 ${s.failed.length}`
  );
  if (s.failed.length) console.log(`  실패: ${s.failed.map((f) => `${f.file}(${f.error})`).join(", ")}`);
}

// import 시에는 실행하지 않고, `node download-specs.mjs` 로 직접 실행할 때만 수행
const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
