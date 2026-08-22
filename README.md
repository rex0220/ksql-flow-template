# ksql-flow-template

kintone バッチランナー [kSQL Flow](https://github.com/rex0220/ksql-flow) のジョブを **AI エージェント（VSCode + Claude Code + kSQL MCP）と共同で作成・運用する**ためのテンプレートリポジトリです。

「Use this template」で自分のリポジトリを作れば、AI 向けの作業規約（`CLAUDE.md`）・MCP 接続設定・検証済みサンプルジョブが揃った状態から始められます。

> **as-is / no support**: MIT ライセンスで現状有姿のまま公開しており、サポート・動作保証の約束はありません。本番投入は必ず `--dry-run` とステージング検証を経て、自己責任でお願いします。

## 構成

```text
├── CLAUDE.md                 # AI 向けの作業規約（手順・ジョブ規約・してはいけないこと）
├── .mcp.json                 # Claude Code の MCP 登録（kSQL MCP）
├── ksql.config.json          # kSQL Flow（ランナー）用の接続設定 — トークンは env: 参照
├── ksql.mcp.config.json      # kSQL MCP 用の接続設定 — 閲覧のみトークン
├── .gitignore                # .ksql/（実行時生成物）を除外
└── jobs/
    └── monthly_deal_summary.sql  # 検証済みサンプルジョブ（月次案件集計）
```

サンプルジョブは kintone 標準の「営業支援（SFA）パック」（案件管理・顧客管理）を前提にしています。アプリ構成の準備は [kSQL Flow の README](https://github.com/rex0220/ksql-flow#readme) と紹介記事を参照してください。

## セットアップ

1. **このテンプレートから自分のリポジトリを作成** — GitHub の「Use this template」→ clone
2. **ツールのインストール**（Node.js 18+）

   ```bash
   npm i -g @rex0220/ksql-flow @rex0220/kintone-sql-tools
   ```

3. **実行ログアプリの作成** — kSQL Flow 同梱の[アプリテンプレート](https://github.com/rex0220/ksql-flow/tree/main/template)から作成（約 3 分）
4. **接続設定の書き換え** — `ksql.config.json` と `ksql.mcp.config.json` の `baseUrl` とアプリ `id` を自環境に合わせる（トークン値はファイルに書かない）
5. **トークンの発行と環境変数設定** — 各アプリで 2 種類のトークンを発行して置き場所を分ける

   | 環境変数 | 権限 | 置き場所 |
   | --- | --- | --- |
   | `KSQL_TOKEN_DEALS_RO` / `KSQL_TOKEN_CUSTOMERS_RO` | 閲覧のみ | AI（Claude Code）を起動するシェル |
   | `KSQL_TOKEN_DEALS` / `KSQL_TOKEN_CUSTOMERS` / `KSQL_TOKEN_LOGS` | 閲覧 + 編集（+ 追加） | 本実行する人間のシェル / スケジューラ |

   AI 側のシェルにも `KSQL_TOKEN_DEALS` 等を設定する場合は**閲覧のみトークンの値**を入れてください（`ksql-flow validate` / `--dry-run` はそれで動きます）。
6. **VSCode で開いて Claude Code を起動** — `.mcp.json` により kSQL MCP が自動で接続されます

## 使い方

Claude Code に業務要件を日本語で伝えます。例:

> 案件管理アプリから「当月受注予定」の案件を会社別に集計して、顧客管理アプリの `当月案件件数`・`当月売上合計`・`最終集計日時` を更新するジョブを作ってください。マイナス売上があれば異常停止、対象 0 件は正常スキップで。

AI は `CLAUDE.md` の規約に従って、スキーマ確認 → 方言仕様の参照 → 生成 → 二段の validate → dry-run まで進め、差分を報告してきます。**問題なければ人間が本実行**します:

```bash
ksql-flow run -f jobs/<ジョブ名>.sql --profile prod
```

## 関連リンク

- ランナー: https://github.com/rex0220/ksql-flow （[公開仕様書](https://github.com/rex0220/ksql-flow/blob/main/docs/ksql_flow_spec.md)）
- エンジン + MCP: https://github.com/rex0220/kintone-sql-tools
- 解説記事: [AIエージェントにkintoneを操作させるにはSQLが最適解である](https://qiita.com/rex0220/items/fbed33b11251cdf7e31e)

## ライセンス

MIT
