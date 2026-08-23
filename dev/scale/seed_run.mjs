// Seed wrapper: run with `node --env-file=.env dev/scale/seed_run.mjs [--tier SMOKE|S|M|L]` from the repo root.
// Composes KSQL_SEED_TOKEN_DEALS = KSQL_TOKEN_DEALS + "," + KSQL_TOKEN_CUSTOMERS
// (lookup-source token sent together). Never prints token values.
import { spawnSync } from "node:child_process";

const tierIdx = process.argv.indexOf("--tier");
const tier = tierIdx >= 0 ? process.argv[tierIdx + 1] : "SMOKE";
if (!["SMOKE", "S", "M", "L", "XL"].includes(tier)) {
  console.error(`FATAL: unknown tier "${tier}"`);
  process.exit(89);
}

for (const name of ["KSQL_TOKEN_DEALS", "KSQL_TOKEN_CUSTOMERS"]) {
  if (!process.env[name]) {
    console.error(`FATAL: ${name} is not set (expected from --env-file=.env)`);
    process.exit(90);
  }
}

const args = [
  "node_modules/@rex0220/kintone-sql-tools/dist-cli/ksql.js",
  "--config", "dev/scale/ksql.cli.config.json",
  "--profile", "prod",
  "-f", "dev/scale/seed_import.sql",
  "--import-csv", `customers=dev/scale/out/${tier}/customers.csv`,
  "--import-csv", `deals=dev/scale/out/${tier}/deals.csv`,
  "--allow-dml", "--yes", "--format", "table",
];
// CLI defaults (maxRecords 500 / dmlMaxRows 100) only fit SMOKE (10 deals);
// S=200 / M=2,000 / L=20,000 all exceed dmlMaxRows 100 (found live in S seed, 2026-08-23).
// Keep the fail-closed guard meaningful with tier-scaled caps instead of one huge value.
const LIMITS = { S: ["1000", "500"], M: ["5000", "2500"], L: ["25000", "25000"], XL: ["110000", "110000"] };
if (LIMITS[tier]) {
  const [maxRecords, dmlMaxRows] = LIMITS[tier];
  args.push("--max-records", maxRecords, "--dml-max-rows", dmlMaxRows);
}
// CLI --timeout default 30000 ms is too short for M/L IMPORT batches
// (M seed hit "TimeoutError: batch timeout exceeded" AFTER all rows were written, 2026-08-23).
const TIMEOUTS = { M: "600000", L: "3600000", XL: "7200000" };
if (TIMEOUTS[tier]) {
  args.push("--timeout", TIMEOUTS[tier]);
}

console.log(`[seed_run] tier=${tier} command: node ${args.join(" ")}`);
const t0 = Date.now();
const r = spawnSync(process.execPath, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    KSQL_SEED_TOKEN_DEALS: `${process.env.KSQL_TOKEN_DEALS},${process.env.KSQL_TOKEN_CUSTOMERS}`,
  },
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[seed_run] exit_code=${r.status} elapsed_sec=${elapsed}`);
process.exit(r.status ?? 91);
