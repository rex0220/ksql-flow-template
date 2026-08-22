# ksql-flow-template

kintone バッチランナー [kSQL Flow](https://github.com/rex0220/ksql-flow) のジョブを **AI エージェント（VSCode + Claude Code + kSQL MCP）と共同で作成・運用する**ためのテンプレートリポジトリです。

このテンプレートから自分のリポジトリを作れば、AI 向けの作業規約（`CLAUDE.md`）・MCP 接続設定・検証済みサンプルジョブが揃った状態から始められます。依存（ランナー + エンジン/MCP）は `npm install` でリポジトリ内に入るので、グローバルインストールは不要です。

> **as-is / no support**: MIT ライセンスで現状有姿のまま公開しており、サポート・動作保証の約束はありません。本番投入は必ず dry-run とステージング検証を経て、自己責任でお願いします。

## 構成

```text
├── CLAUDE.md                 # AI 向けの作業規約（手順・ジョブ規約・してはいけないこと）
├── .mcp.json                 # Claude Code の MCP 登録（node_modules 内の kSQL MCP を起動）
├── package.json              # 依存(@rex0220/ksql-flow + kintone-sql-tools) と npm scripts
├── ksql.config.json          # kSQL Flow（ランナー）用の接続設定 — トークンは env: 参照
├── ksql.mcp.config.json      # kSQL MCP 用の接続設定 — 閲覧のみトークン
├── .env.example              # トークンの置き場所の雛形（.env は .gitignore 済み）
└── jobs/
    └── monthly_deal_summary.sql  # 検証済みサンプルジョブ（月次案件集計）
```

サンプルジョブは kintone 標準の「営業支援（SFA）パック」（案件管理・顧客管理）を前提にしています。アプリ構成の準備は [kSQL Flow の README](https://github.com/rex0220/ksql-flow#readme) と紹介記事を参照してください。

## セットアップ

1. **このテンプレートから自分のリポジトリを作成** — GitHub の「Use this template」→ clone。設定にはアプリ ID や業務用語が入るので、**リポジトリは Private を推奨**します。[GitHub CLI](https://cli.github.com/) なら 1 行です:

   ```bash
   gh repo create my-ksql-jobs --template rex0220/ksql-flow-template --private --clone
   ```

2. **依存を入れる**（Node.js 20.6 以上）

   ```bash
   npm install
   ```

   ランナー（kSQL Flow）とエンジン + MCP サーバー（kintone-sql-tools）が入ります。これだけです。
3. **実行ログアプリの作成** — kSQL Flow 同梱の[アプリテンプレート](https://github.com/rex0220/ksql-flow/tree/main/template)から作成（約 3 分）
4. **接続設定の書き換え** — `ksql.config.json` と `ksql.mcp.config.json` の `baseUrl` とアプリ `id` を自環境に合わせる（トークン値はファイルに書かない）
5. **トークンを置く** — `.env.example` をコピーして `.env` を作り、**閲覧のみトークン**を貼る

   | 変数 | 権限 | 用途 |
   | --- | --- | --- |
   | `KSQL_TOKEN_DEALS_RO` / `KSQL_TOKEN_CUSTOMERS_RO` | 閲覧のみ | AI の MCP（スキーマ確認・下見クエリ） |
   | `KSQL_TOKEN_DEALS` / `KSQL_TOKEN_CUSTOMERS` / `KSQL_TOKEN_LOGS` | 閲覧のみの値を入れる | `npm run validate` / `npm run dry-run` |

   **本実行する人間だけ**が、書込可（閲覧 + 編集 + 追加）のトークンを **OS の環境変数**（`setx` 等）に設定します。OS 環境変数は `.env` より優先されるため、`.env` は閲覧のみのまま共有でき、AI のセッションからは書き込めません。
6. **VSCode で開いて Claude Code を起動** — 初回に kSQL MCP サーバーの使用可否を聞かれるので許可します（登録内容は `.mcp.json`）

## 使い方

Claude Code に業務要件を日本語で伝えます。例:

> 案件管理アプリから「当月受注予定」の案件を会社別に集計して、顧客管理アプリの `当月案件件数`・`当月売上合計`・`最終集計日時` を更新するジョブを作ってください。マイナス売上があれば異常停止、対象 0 件は正常スキップで。

AI は `CLAUDE.md` の規約に従って、スキーマ確認 → 方言仕様の参照 → 生成 → 二段の validate → dry-run まで進め、差分を報告してきます。**問題なければ人間が本実行**します（書込可トークンを OS 環境変数に設定したターミナルで）:

```bash
npm run job -- -f jobs/<ジョブ名>.sql --profile prod
```

npm scripts 一覧:

| コマンド | 内容 |
| --- | --- |
| `npm run check-logapp -- --profile prod` | ログアプリの定義検査（初回のみ） |
| `npm run validate -- -f jobs/<name>.sql --profile prod` | ジョブのフル検証 |
| `npm run dry-run -- -f jobs/<name>.sql --profile prod` | 差分プレビュー（書込ゼロ） |
| `npm run job -- -f jobs/<name>.sql --profile prod` | 本実行（人間のみ・書込可トークン必須） |

## 関連リンク

- ランナー: https://github.com/rex0220/ksql-flow （[公開仕様書](https://github.com/rex0220/ksql-flow/blob/main/docs/ksql_flow_spec.md)）
- エンジン + MCP: https://github.com/rex0220/kintone-sql-tools
- 解説記事: [AIエージェントにkintoneを操作させるにはSQLが最適解である](https://qiita.com/rex0220/items/fbed33b11251cdf7e31e)

## ライセンス

MIT
