#!/usr/bin/env node
// スケール検証（S/M/L）の成果物一式を生成する。
// 企画: ksql-flow/docs/internal/scale_verification_plan.md R2 §3
//
//   node dev/scale/generate.mjs --tier S --as-of 2026-08-23
//
// 生成物（dev/scale/out/<tier>/ 配下・.gitignore 対象）:
//   customers.csv        顧客管理へ IMPORT する会社一覧（KSQL-FLOW-TEST-C<i>）
//   deals.csv            案件管理へ IMPORT する案件（会社 i × 案件 j、売上 = i*1000+j）
//   touch.sql            書込大ジョブ: テスト案件全件の UPDATE（会社名 IN をバッチ分割）
//   cleanup_1.sql ...    テストデータ完全削除（案件 → 顧客の順・IN バッチ分割・複数ファイル）
//   verify.sql           突合ジョブ: 検算リテラル ASSERT + 会社別不一致/欠落/余剰の検出
//   manifest.json        期待値・件数・分割数などの記録（scale-notes 転記用）
//
// 期待値の式: 会社 i(1..N) の案件 j(1..10) の売上 = i*1000 + j
//   会社 i の合計 = 10*i*1000 + 55 / 総売上 = 10000*N*(N+1)/2 + 55*N

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TIERS = { SMOKE: 1, S: 20, M: 200, L: 2000 }; // 会社数（案件は各 10 件）
const DEALS_PER_COMPANY = 10;
const IN_BATCH = 250; // IN 句 1 文あたりの会社数
const MAX_STATEMENTS = 18; // エンジン上限 20 文に対する安全マージン

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1]] : [])).filter(x => x.length)
);
const tier = (args.tier ?? "S").toUpperCase();
const asOf = args["as-of"];
if (!TIERS[tier]) { console.error("--tier は SMOKE / S / M / L"); process.exit(1); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf ?? "")) { console.error("--as-of YYYY-MM-DD が必須（検証全体の固定 as-of の暦日）"); process.exit(1); }

const N = TIERS[tier];
const [yy, mm] = asOf.split("-").map(Number);
const day = j => String(((j - 1) % 28) + 1).padStart(2, "0"); // 当月 1〜28 日に分散
const month = `${yy}-${String(mm).padStart(2, "0")}`;
const company = i => `KSQL-FLOW-TEST-C${i}`;

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "out", tier);
fs.mkdirSync(outDir, { recursive: true });
const write = (name, text) => { fs.writeFileSync(path.join(outDir, name), text); return name; };

// ---- CSV ----
const customers = ["会社名"];
for (let i = 1; i <= N; i++) customers.push(company(i));
write("customers.csv", customers.join("\n") + "\n");

const deals = ["会社名,案件名,売上,受注予定日"];
for (let i = 1; i <= N; i++)
  for (let j = 1; j <= DEALS_PER_COMPANY; j++)
    deals.push(`${company(i)},KSQL-FLOW-TEST-D${i}-${j},${i * 1000 + j},${month}-${day(j)}`);
write("deals.csv", deals.join("\n") + "\n");

// ---- 期待値 ----
const totalDeals = N * DEALS_PER_COMPANY;
const totalSales = 10000 * (N * (N + 1) / 2) + 55 * N;

// ---- IN バッチ ----
const batches = [];
for (let i = 1; i <= N; i += IN_BATCH) {
  const names = [];
  for (let k = i; k < Math.min(i + IN_BATCH, N + 1); k++) names.push(`'${company(k)}'`);
  batches.push(names.join(", "));
}

// ---- touch.sql（書込大ジョブ: 全テスト案件を UPDATE。冪等） ----
{
  const head = [
    "-- @ksql name: scale_touch_update_" + tier.toLowerCase(),
    "-- @ksql timeout: 3600",
    "-- @ksql dialect: 1",
    "",
    `-- 書込スケール試験: テスト案件 ${totalDeals} 件の 詳細 を UPDATE（${Math.ceil(totalDeals / 100)} チャンク）。`,
    "-- チェックポイント・中断リラン・maxApiCalls 試験に使う。テストデータ以外に触れない。",
    "",
  ];
  const stmts = batches.map(b =>
    `UPDATE LAPP_案件管理 SET 詳細 = 'KSQL-FLOW-TEST-touched ${asOf}'\nWHERE 会社名 IN (${b});`);
  if (stmts.length > MAX_STATEMENTS) throw new Error("touch.sql が文数上限を超過");
  write("touch.sql", head.join("\n") + "\n" + stmts.join("\n\n") + "\n");
}

// ---- cleanup_<n>.sql（案件 → 顧客の順。ファイルあたり MAX_STATEMENTS 文に分割） ----
{
  const stmts = [];
  for (const b of batches) stmts.push(`DELETE FROM LAPP_案件管理 WHERE 会社名 IN (${b});`);
  for (const b of batches) stmts.push(`DELETE FROM LAPP_顧客管理 WHERE 会社名 IN (${b});`);
  const files = [];
  for (let f = 0; f * MAX_STATEMENTS < stmts.length; f++) {
    const part = stmts.slice(f * MAX_STATEMENTS, (f + 1) * MAX_STATEMENTS);
    const head = [
      `-- @ksql name: scale_cleanup_${tier.toLowerCase()}_${f + 1}`,
      "-- @ksql timeout: 3600",
      "-- @ksql dialect: 1",
      "",
      `-- テストデータ削除 (${f + 1}/${Math.ceil(stmts.length / MAX_STATEMENTS)})。会社名の完全一致のみが対象。`,
      "",
    ];
    files.push(write(`cleanup_${f + 1}.sql`, head.join("\n") + "\n" + part.join("\n\n") + "\n"));
  }
  var cleanupFiles = files; // manifest 用
}

// ---- verify.sql（突合: 検算リテラル + 再集計比較。read-only + ASSERT のみ） ----
{
  const scope = `会社名 LIKE 'KSQL-FLOW-TEST-C%'`;
  const inMonth = `受注予定日 >= @MONTH_START() AND 受注予定日 < @NEXT_MONTH_START()`;
  const sql = `-- @ksql name: scale_verify_${tier.toLowerCase()}
-- @ksql timeout: 3600
-- @ksql dialect: 1

-- 突合ジョブ（${tier}: 会社 ${N} 社 × 案件 ${DEALS_PER_COMPANY} 件）。書き込みなし。
-- 期待値は生成式から算出したリテラル: 総件数 ${totalDeals} / 総売上 ${totalSales}

-- 1) 案件側: 件数・総売上が生成式と一致（欠落・重複・値化けを検出）
ASSERT (SELECT COUNT(*) FROM LAPP_案件管理 WHERE ${scope} AND ${inMonth}) = ${totalDeals},
  '【突合NG】テスト案件の件数が期待値 ${totalDeals} と不一致';
ASSERT (SELECT SUM(売上) FROM LAPP_案件管理 WHERE ${scope} AND ${inMonth}) = ${totalSales},
  '【突合NG】テスト案件の総売上が期待値 ${totalSales} と不一致';

-- 2) 顧客側: 会社数・集計列の合計が期待と一致（余剰・欠落・書込漏れを検出）
ASSERT (SELECT COUNT(*) FROM LAPP_顧客管理 WHERE ${scope}) = ${N},
  '【突合NG】テスト顧客の会社数が期待値 ${N} と不一致（欠落または余剰）';
ASSERT (SELECT SUM(当月案件件数) FROM LAPP_顧客管理 WHERE ${scope}) = ${totalDeals},
  '【突合NG】顧客管理の当月案件件数の合計が ${totalDeals} と不一致';
ASSERT (SELECT SUM(当月売上合計) FROM LAPP_顧客管理 WHERE ${scope}) = ${totalSales},
  '【突合NG】顧客管理の当月売上合計の合計が ${totalSales} と不一致';

-- 3) 会社別: 案件の再集計と顧客管理の値が全社一致（JOIN 成立数もここで担保）
CREATE TEMP TABLE agg AS
SELECT 会社名, COUNT(*) AS 件数, SUM(売上) AS 合計
FROM LAPP_案件管理
WHERE ${scope} AND ${inMonth}
GROUP BY 会社名;

ASSERT (SELECT COUNT(*) FROM agg) = ${N}, '【突合NG】再集計の会社数が ${N} と不一致';

ASSERT (
  SELECT COUNT(*) FROM agg a
  INNER JOIN LAPP_顧客管理 k ON a.会社名 = k.会社名
  WHERE a.件数 = k.当月案件件数 AND a.合計 = k.当月売上合計
) = ${N}, '【突合NG】会社別の件数・合計が一致しない会社がある（JOIN 不成立 = 片側欠落を含む）';

SELECT COUNT(*) AS 突合対象社数 FROM agg;
`;
  write("verify.sql", sql);
}

// ---- manifest ----
const manifest = {
  tier, asOf, companies: N, dealsPerCompany: DEALS_PER_COMPANY,
  totalDeals, totalSales,
  inBatch: IN_BATCH, touchStatements: batches.length, cleanupFiles,
  csv: {
    customers: { rows: N, bytes: fs.statSync(path.join(outDir, "customers.csv")).size },
    deals: { rows: totalDeals, bytes: fs.statSync(path.join(outDir, "deals.csv")).size },
  },
  expectedWriteChunks: { seedCustomers: Math.ceil(N / 100), seedDeals: Math.ceil(totalDeals / 100), summaryUpsert: Math.ceil(N / 100), touch: Math.ceil(totalDeals / 100), cleanup: Math.ceil((totalDeals + N) / 100) },
};
write("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
