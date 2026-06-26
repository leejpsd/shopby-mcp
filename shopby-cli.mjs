#!/usr/bin/env node
// shopby-cli.mjs — Claude 없이 터미널에서 바로 검색/조회
//   node shopby-cli.mjs "장바구니 리스트"
//   node shopby-cli.mjs --detail get-cart
import { search, getApi, stats, loadAll } from "./shopby-index.mjs";

// 캐시가 비어 있으면(예: 전역 설치 후 첫 실행) 스펙을 받아온 뒤 다시 로드한다.
if (stats().operations === 0) {
  console.error("[shopby-cli] 캐시가 비어 있어 스펙을 받아옵니다…");
  try {
    const { refreshAll } = await import("./download-specs.mjs");
    await refreshAll({});
    loadAll();
  } catch (e) {
    console.error(`[shopby-cli] 스펙 다운로드 실패: ${e.message}`);
  }
}

const args = process.argv.slice(2);

if (args[0] === "--detail" || args[0] === "-d") {
  const d = getApi({ operationId: args[1] });
  if (!d) { console.log(`'${args[1]}' 못 찾음`); process.exit(1); }
  console.log(`\n${d.method} ${d.fullUrl}`);
  console.log(`${d.operationId}  [${d.tags.join(", ")}]  (${d.source})`);
  console.log(`📝 ${d.summary}`);
  if (d.description) console.log(`   ${d.description}`);
  const filters = d.filters.filter((p) => p.in === "query");
  if (filters.length) {
    console.log(`\n🔍 필터 (쿼리 파라미터) ${filters.length}개:`);
    for (const f of filters) {
      const req = f.required ? " *필수" : "";
      const en = f.enum ? `\n      enum: ${JSON.stringify(f.enum)}` : "";
      console.log(`  • ${f.name} (${f.type})${req}  ${f.description}${en}`);
    }
  }
  const paths = d.filters.filter((p) => p.in === "path");
  if (paths.length) {
    console.log(`\n🧭 경로 파라미터:`);
    for (const f of paths) console.log(`  • ${f.name} (${f.type})  ${f.description}`);
  }
  if (d.requestBody) console.log(`\n📦 요청 바디:\n${JSON.stringify(d.requestBody, null, 2).slice(0, 1500)}`);
  console.log();
} else if (args.length) {
  const q = args.join(" ");
  const hits = search(q, { limit: 10 });
  console.log(`\n'${q}' 검색결과 ${hits.length}건 (전체 ${stats().operations}개 중)\n`);
  for (const h of hits) {
    console.log(`  [${String(h.score).padStart(2)}] ${h.method.padEnd(6)} ${h.path}`);
    console.log(`       ${h.summary}  → ${h.operationId} (필터 ${h.filterCount}개, ${h.source})`);
    if (h.matched?.length) console.log(`       근거: ${h.matched.join(", ")} 매칭`);
  }
  console.log(`\n상세보기: node shopby-cli.mjs --detail <operationId>\n`);
} else {
  console.log(`사용법:
  node shopby-cli.mjs "검색어"           예) "장바구니 리스트", "브랜드 필터"
  node shopby-cli.mjs --detail <opId>    예) --detail search-inquiries
현재 인덱스: ${JSON.stringify(stats())}`);
}
