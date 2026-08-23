// Timing + peak-RSS wrapper for the kSQL Flow runner (the runner console output has neither).
// Usage: node --env-file=.env dev/scale/job_run.mjs run -f <file.sql> --profile prod [--as-of ...] [--dry-run] [--json]
// Passes all arguments through to the runner CLI, prints elapsed seconds / peak RSS / exit code,
// and propagates the runner's exit code. Peak RSS is sampled every 250 ms via PowerShell
// (WorkingSet64), so very short runs may under-sample — treat it as a lower bound.
import { spawn, execFileSync } from "node:child_process";

const passthrough = process.argv.slice(2);
if (passthrough.length === 0) {
  console.error("FATAL: no runner arguments given");
  process.exit(89);
}

const args = ["node_modules/@rex0220/ksql-flow/dist/cli.js", ...passthrough];
console.log(`[job_run] command: node ${args.join(" ")}`);

const t0 = Date.now();
const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });

let peakRss = 0;
const sampler = setInterval(() => {
  try {
    const out = execFileSync("powershell", [
      "-NoProfile", "-Command", `(Get-Process -Id ${child.pid}).WorkingSet64`,
    ], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const ws = parseInt(out.trim(), 10);
    if (Number.isFinite(ws) && ws > peakRss) peakRss = ws;
  } catch { /* process already exited or sampling failed — keep last peak */ }
}, 250);

child.on("exit", (code) => {
  clearInterval(sampler);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const rssMb = peakRss > 0 ? (peakRss / 1024 / 1024).toFixed(1) : "n/a";
  console.log(`[job_run] exit_code=${code} elapsed_sec=${elapsed} peak_rss_mb=${rssMb}`);
  process.exit(code ?? 91);
});
