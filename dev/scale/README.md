# dev/scale — レコード増加検証ツール（SMOKE / S / M / L）

kSQL Flow のスケール検証（200 / 2,000 / 20,000 件）用のツール一式。
企画・観点・合否基準の正は ksql-flow リポジトリの `docs/internal/scale_verification_plan.md`（R2）、
一次記録は同 `verification/scale-notes.md`。

- 前提: kSQL Flow **v0.2.0**（`limits.maxReadRows`）+ kintone-sql-tools **v3.72.0**、SFA パック構成
- テストデータはすべて `KSQL-FLOW-TEST-` プレフィックス。cleanup で完全に消える
- **書き込みを伴うコマンドはすべて、書込可トークンをセッション限定で設定した VSCode 外のターミナルで人間が実行**

## ファイル

| ファイル | 役割 |
| --- | --- |
| `generate.mjs` | 段階別の CSV・precheck・touch・cleanup・verify・manifest を `out/<tier>/` に生成 |
| `seed_import.sql` | エンジン CLI（`ksql`）の IMPORT で顧客 → 案件を投入 |
| `seed_run.mjs` | シードの実行ラッパー — 併送トークン合成 + **tier 別の CLI 上限/タイムアウトを自動付与**（下記の注意参照） |
| `job_run.mjs` | ランナー実行の計測ラッパー — 経過秒 + ピーク RSS を出力（Windows/PowerShell 前提。ランナー出力には無い） |
| `ksql.cli.config.json` | エンジン CLI 用の接続設定（`baseUrl` とアプリ `id` を自環境に書き換える） |
| `scale_deal_summary.sql` | 検証専用の集計ジョブ（全文テストスコープ限定・実データ不可侵） |
| `out/<tier>/verify.sql` | 突合ジョブ（期待値リテラル + 再集計比較。**集計ジョブ実行後に**流す） |
| `out/<tier>/touch.sql` | 書込大ジョブ（チェックポイント・中断リラン・maxApiCalls 試験用） |
| `out/<tier>/cleanup_*.sql` | テストデータ完全削除（案件 → 顧客の順） |

## 0. 準備（1 回だけ）

1. `ksql.cli.config.json` の `baseUrl` とアプリ `id`（100 = 案件管理 / 200 = 顧客管理）を自環境に合わせる
2. 成果物の生成（as-of は検証全体で固定した暦日）:

   ```powershell
   node dev/scale/generate.mjs --tier SMOKE --as-of 2026-08-23
   ```

3. **書込ターミナル**（VSCode 外・セッション限定）でトークンを設定。IMPORT はルックアップ検証のため
   案件管理のトークンに顧客管理の閲覧トークンを**カンマ結合で併送**する:

   ```powershell
   $env:KSQL_TOKEN_DEALS = "<案件管理: 閲覧+追加+編集+削除>"
   $env:KSQL_TOKEN_CUSTOMERS = "<顧客管理: 閲覧+追加+編集+削除>"
   $env:KSQL_TOKEN_LOGS = "<実行ログ: 閲覧+追加+編集>"
   $env:KSQL_SEED_TOKEN_DEALS = "$env:KSQL_TOKEN_DEALS,$env:KSQL_TOKEN_CUSTOMERS"
   ```

   （検証はレコード削除を伴うため、通常運用と違い**削除権限つき**トークンが必要）

## 1. SMOKE（1 社 × 10 件・初回のみ・IMPORT の疎通）

```powershell
# 前提チェック（残存 0 件の確認。ABORTED なら他世代のテストデータが残っている — 先に片付ける）
npm run job -- -f dev/scale/out/SMOKE/precheck.sql --profile prod

# シード（エンジン CLI の IMPORT。--dry-run を外すと本実行）
node node_modules/@rex0220/kintone-sql-tools/dist-cli/ksql.js `
  --config dev/scale/ksql.cli.config.json --profile prod `
  -f dev/scale/seed_import.sql `
  --import-csv customers=dev/scale/out/SMOKE/customers.csv `
  --import-csv deals=dev/scale/out/SMOKE/deals.csv `
  --allow-dml --yes --format table

# 集計 → 突合 → 片付け（as-of は固定値を明示）
npm run job -- -f dev/scale/scale_deal_summary.sql --profile prod --as-of "2026-08-23T00:00:00+09:00"
npm run job -- -f dev/scale/out/SMOKE/verify.sql --profile prod --as-of "2026-08-23T00:00:00+09:00"
npm run job -- -f dev/scale/out/SMOKE/cleanup_1.sql --profile prod
```

期待値: seed で顧客 1 + 案件 10 / verify が SUCCESS（総売上 10,055）/ cleanup 後は両アプリの
`KSQL-FLOW-TEST-` が 0 件。ここまで通れば IMPORT の疎通（capability gate・トークン併送・
config 互換）は完了。

## 2. S / M / L（本検証）

`--tier S`（→ M → L）で生成して同じ流れ。**段階ごとの合格が次の段階の前提**（企画 §6）。
計測（3 回・中央値）・スクリーンショット・API 内訳の採取は企画 §10 の素材採取計画に従い、
`verification/scale-notes.md` に一次記録してから記事へ転記する。

### 段階別の注意

- **seed の前に必ず `precheck.sql`**（残存 0 件チェック）。検証期間中、`KSQL-FLOW-TEST-` 名前空間は本検証が専有する（他のテスト作業と重ねない）
- **シードは `seed_run.mjs` 経由を推奨**: `node --env-file=.env dev/scale/seed_run.mjs --tier <tier>`。CLI 既定の `--dml-max-rows 100` は SMOKE 以外で不足（S の実機で発見）、`--timeout 30s` は M/L の IMPORT で不足するため、tier 別の上限・タイムアウトをラッパーが自動付与する
- **IMPORT の timeout 罠（M の実機で発見）**: クライアントが TimeoutError で失敗 exit しても、**サーバ側では書込が完了していることがある**。案件 INSERT は再実行不可なので、seed 失敗時は必ず件数を実測 → cleanup → 再 seed の順で復旧する
- **verify は集計ジョブの後に**流す（顧客側の集計欄を突合するため）
- **案件の再シードは必ず cleanup 後**（案件 IMPORT は INSERT。顧客は ON DUPLICATE で冪等）
- **L のみ**:
  - ランナー config の profile に上限を追加: `"limits": { "maxReadRows": 25000, "maxTempRows": 25000 }`
    （片方だけでは失敗点が移動する — エンジン F-3 回答 §3）
  - 先に**未設定のまま 1 回実行**して既定 10,000 の明示エラーを記録する（観点 L-9 ①）
  - シードの CLI に `--max-records 25000 --dml-max-rows 25000` を追加（CLI 側の既定は 500 / 100）
  - 中断リラン・チェックポイント・maxApiCalls 試験は `out/L/touch.sql` で（企画 §4 L-11/L-12）
