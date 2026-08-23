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
├── jobs/
│   └── monthly_deal_summary.sql  # 検証済みサンプルジョブ（月次案件集計）
└── dev/                      # 開発用（run-all の対象外）
    ├── seed_test_deals.sql       # 当月テストデータ投入（書込経路の検証用）
    └── cleanup_test_deals.sql    # テストデータの完全削除
```

サンプルジョブは kintone 標準の「営業支援（SFA）パック」（案件管理・顧客管理）を前提にしています。アプリ構成の準備は [kSQL Flow の README](https://github.com/rex0220/ksql-flow#readme) と紹介記事を参照してください。

## 前提条件

| 項目 | 要件 |
| --- | --- |
| ランナー | kSQL Flow 0.3 系（`npm install` で入ります・MIT） |
| SQL エンジン / MCP | kintone-sql-tools 3.72 系（同上） |
| Node.js | 20.6 以上 |
| エディター | VSCode + Claude Code |
| kintone アプリ | 営業支援（SFA）パック + 顧客管理への追加 3 フィールド + 実行ログアプリ（API トークン認証） |

## 環境構築（初回 15 分）

### 1. テンプレートから自分のリポジトリを作る

テンプレートページ右上の「Use this template → Create a new repository」で、自分のアカウントに **Private** で作成して clone します（設定にアプリ ID や業務用語が入るため。**visibility は Public が初期値なので必ず Private に切り替えてください**）。[GitHub CLI](https://cli.github.com/) なら 1 行です:

```bash
gh repo create my-ksql-jobs --template rex0220/ksql-flow-template --private --clone
```

### 2. 依存を入れる

```bash
npm install
```

ランナー（kSQL Flow）とエンジン + MCP サーバー（kintone-sql-tools）が入ります。これだけです。

### 3. 実行ログアプリを作る

kSQL Flow 同梱の[アプリテンプレート](https://github.com/rex0220/ksql-flow/tree/main/template)から作成します（約 3 分。フィールド定義・レイアウト・一覧設定済み）。

作成後、**失敗通知を kintone 標準の条件通知で設定**しておくと追加インフラなしで通知が届きます（設定 → 通知 → レコードの条件通知に 2 つ）:

1. `record_type = BATCH` かつ status が `FAILED` / `ABORTED` / `TIMEOUT` のいずれか（run-all の失敗を 1 通に集約）
2. `record_type = JOB` かつ `parent_batch_id` が空 かつ status が同上（単発 run の失敗）

宛先は個人ではなく「**ジョブ管理**」グループを作ってグループ宛にするのがおすすめです。担当の入れ替えは cybozu.com 共通管理のグループメンバー変更だけで済み、アプリの通知設定は触りません（グループ宛でも通知はメンバー個々に届きます）。

### 4. 接続設定を書き換える

`ksql.config.json` と `ksql.mcp.config.json` の `baseUrl` とアプリ `id` を自環境に合わせます。トークン値はこの 2 ファイルには書きません（`env:` 参照のまま）。

> 案件管理の `tokens` に顧客管理のトークンも並べてあるのは意図的です。SFA パックの案件管理の `会社名` は**ルックアップ**（参照元 = 顧客管理）で、kintone はルックアップ付きレコードの書込時に**参照先アプリの閲覧権限を同じリクエストのトークンで検証**するため、参照先トークンの併送が必要です（欠けていると `does not exist in the datasource app for lookup, or you do not have permission...` エラーになります — 実機で確認済み）。

### 5. トークンを置く

`.env.example` をコピーして `.env` を作り、**閲覧のみトークン**を貼ります。

| 変数 | 権限 | 用途 |
| --- | --- | --- |
| `KSQL_TOKEN_DEALS_RO` / `KSQL_TOKEN_CUSTOMERS_RO` | 閲覧のみ | AI の MCP（スキーマ確認・下見クエリ） |
| `KSQL_TOKEN_DEALS` / `KSQL_TOKEN_CUSTOMERS` / `KSQL_TOKEN_LOGS` | 閲覧のみの値を入れる | `npm run validate` / `npm run dry-run` |

**本実行する人間だけ**が、書込可（閲覧 + 編集 + 追加）のトークンを **VSCode の外の自分のターミナルで、セッション限定の環境変数**として設定します（プロセスの環境変数は `.env` より優先されます）:

```powershell
# PowerShell（このウィンドウ限り。閉じれば消える）
$env:KSQL_TOKEN_DEALS = "<書込可トークン>"
$env:KSQL_TOKEN_CUSTOMERS = "<書込可トークン>"
$env:KSQL_TOKEN_LOGS = "<書込可トークン>"
```

`setx` などの**恒久的なユーザー環境変数にはしないでください** — 以後に起動する全プロセス（VSCode と Claude Code のターミナルを含む）へ配られるため、AI 側にも書込トークンが渡ってしまい、トークン分離が崩れます。セッション限定なら、`.env` は閲覧のみのまま共有でき、AI のプロセス環境には書込トークンが存在しません。

### 6. VSCode で開いて Claude Code を起動

初回に kSQL MCP サーバーの使用可否を聞かれるので許可します（登録内容は `.mcp.json`）。

### 7. 疎通確認

Claude Code に「**`ksql_describe_app` で `LAPP_案件管理` のフィールド一覧を見せて**」と指示し、フィールドコードと型の一覧が返ってくれば準備完了です。あわせてターミナル側も:

```bash
npm run check-logapp -- --profile prod
```

`OK: ログアプリ (ID ...) は 8.2 のフィールド定義を満たしています` が出れば、ランナー側の疎通とログアプリの定義検査も完了です。

## 使い方

Claude Code に業務要件を日本語で伝えます。例:

> 案件管理アプリから「当月受注予定」の案件を会社別に集計して、顧客管理アプリの `当月案件件数`・`当月売上合計`・`最終集計日時` を更新するジョブを作ってください。マイナス売上があれば異常停止、対象 0 件は正常スキップで。

AI は `CLAUDE.md` の規約に従って、スキーマ確認 → 方言仕様の参照 → 生成 → 二段の validate → dry-run まで進め、差分を報告してきます。**問題なければ人間が本実行**します（書込可トークンをセッション限定で設定した VSCode 外のターミナルで — 手順 5 参照）:

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

## 定期実行に載せる（サーバー構築・約 15 分）

このリポジトリには起動バッチ `run_batch.bat`（配置先に依存しない `%~dp0` 基準・ASCII のみ）を同梱しており、clone するだけで定期実行に必要な一式が揃います。初回配置 = clone + npm install、以降のジョブ更新 = 基本 pull。

1. サーバーに Node.js 20.6+ を導入
2. ジョブリポジトリを clone（private のため認証が必要。[GitHub CLI](https://cli.github.com/) なら `gh auth login` 後に）:

   ```powershell
   gh repo clone <あなたのアカウント>/my-ksql-jobs C:\ksql\my-ksql-jobs
   cd C:\ksql\my-ksql-jobs
   npm install
   ```

3. `.env.example` をコピーして `.env` を作り、**このサーバー用の書込可トークン**を貼る（無人サーバーには AI が同居しないため、開発機と違い書込可を `.env` に置く — トークンの露出面はこのディレクトリに閉じる）
4. 疎通確認（ログアプリの定義検査）:

   ```powershell
   node --env-file=.env node_modules\@rex0220\ksql-flow\dist\cli.js validate --check-logapp --profile prod
   ```

5. 起動バッチを手動で 1 回実行し、Exit Code とログアプリの記録を確認:

   ```powershell
   .\run_batch.bat
   $LASTEXITCODE   # 0 = 成功（対象 0 件の NO_DATA を含む）
   ```

6. タスク登録（毎朝 6:00・自動再起動なし）: [ksql-flow の examples/windows-task-scheduler/register_task.ps1](https://github.com/rex0220/ksql-flow/blob/main/examples/windows-task-scheduler/register_task.ps1) の `$batchPath` を clone 先に合わせて実行

実機で踏んだ罠（BOM なし日本語 .ps1 の無言死・カレントディレクトリ依存パスの 0xFFFD0000）と運用設計の詳細は連載記事 #4 を参照。

## 書込経路まで検証する（当月データが無いとき）

月次ジョブは当月データが 0 件だと NO_DATA で正常スキップするため、そのままでは書込経路の動作確認ができません。`dev/` の開発用ジョブでテストデータを投入して検証できます（書き込みを伴うため、すべて書込可トークン側のターミナルで人間が実行）:

```bash
npm run job -- -f dev/seed_test_deals.sql --profile prod             # 1. テスト案件 3 件を当月日付で投入
npm run dry-run -- -f jobs/monthly_deal_summary.sql --profile prod   # 2. INSERT 2 件の差分を確認
npm run job -- -f jobs/monthly_deal_summary.sql --profile prod       # 3. 本実行（テスト顧客 2 社が集計される）
npm run job -- -f dev/cleanup_test_deals.sql --profile prod          # 4. テストデータを完全削除
```

- テストデータは会社名・案件名が `KSQL-FLOW-TEST-` プレフィックスで、cleanup が**会社名の完全一致**で案件・顧客の両方を削除します
- seed は再実行しても増殖しません（投入済みなら正常スキップ）
- seed は**テスト顧客 2 社を先に顧客管理へ UPSERT**します — SFA パックの案件管理の `会社名` はルックアップ（参照元 = 顧客管理）のため、参照先に無い会社名は案件に書けません（実機で確認済み）
- 期待値: dry-run で `UPDATE 2 件`（seed が作った 2 社の集計欄が埋まる差分）、本実行後の顧客管理に「KSQL-FLOW-TEST-山田商事: 2 件 / 150,000」「KSQL-FLOW-TEST-鈴木建設: 1 件 / 380,000」

## 関連リンク

- ランナー: https://github.com/rex0220/ksql-flow （[公開仕様書](https://github.com/rex0220/ksql-flow/blob/main/docs/ksql_flow_spec.md)）
- エンジン + MCP: https://github.com/rex0220/kintone-sql-tools
- 解説記事:
  - [【kSQL Flow #1】kintone のバッチ処理を SQL 1 本で書けるランナーの紹介](https://qiita.com/rex0220/items/893ab4016a5aaf595642)
  - [【kSQL Flow #2】AI エージェントに kintone のバッチジョブを書かせる — MCP + Claude Code](https://qiita.com/rex0220/items/3a1213a596a8c49b67aa)（このテンプレートの使い方を実録で解説）
  - [【kSQL Flow #3】毎朝の無人実行の前に — kintone バッチを 200 → 20,000 → 100,000 件で鍛える](https://qiita.com/rex0220/items/62e950ab1ccc5b54ff69)（dev/scale の検証ツールの実録）
  - [AIエージェントにkintoneを操作させるにはSQLが最適解である](https://qiita.com/rex0220/items/fbed33b11251cdf7e31e)

## ライセンス

MIT
