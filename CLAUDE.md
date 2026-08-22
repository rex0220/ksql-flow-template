# CLAUDE.md — kSQL Flow ジョブ作成リポジトリ

このリポジトリは、kintone バッチランナー [kSQL Flow](https://github.com/rex0220/ksql-flow) のジョブを AI エージェントと共同で作成・運用するための作業リポジトリです。

## あなた（AI）の役割と制限

- 担当するのは **ジョブ SQL の作成・検証・dry-run まで**。本実行（`--dry-run` なしの `ksql-flow run`）は人間が自分のターミナルで行う。あなたは実行しない。
- このセッションの環境変数に設定されるトークンは**閲覧のみ**。kintone への書き込みはできない前提で動くこと。
- kSQL / kSQL Flow の構文を**推測で書かない**。必ず下記の手順でドキュメントとスキーマを確認してから書く。

## ジョブ作成の手順（必ずこの順で）

1. **スキーマ確認**: MCP `ksql_describe_app` でフィールドコードと型を実測する（思い込みで書かない）
2. **方言仕様の確認**: MCP `ksql_docs` を引数なしで呼んで章の索引を確認し、**Flow dialect 1 の章**（言語リファレンス §27）と関連レシピを読む。kSQL Flow のジョブは dialect 1 で書く
3. **下見**: MCP `ksql_query` で件数確認の SELECT を流し、条件とデータの当たりをつける
4. **生成**: `jobs/<ジョブ名>.sql` に保存する（1 ジョブ 1 ファイル、ファイル名 = ジョブ名）
5. **一次検証**: MCP `ksql_validate`
6. **二次検証**: ターミナルで `ksql-flow validate -f jobs/<ジョブ名>.sql --profile <profile>`
7. **dry-run**: `ksql-flow run -f jobs/<ジョブ名>.sql --profile <profile> --dry-run` を実行し、差分（読取件数・INSERT/UPDATE/DELETE 予定・変更サンプル）を報告して人間の判断を仰ぐ

## ジョブ規約

- 先頭に `-- @ksql name:` / `-- @ksql timeout:` / `-- @ksql dialect: 1` を書く
- 時刻関数は**必ず `@` 付き**（`@NOW()`, `@MONTH_START()` など）。バッチ開始時の基準時刻（as-of）に固定され、バックフィルが再現可能になる。`@` なしは KSQL1306 警告になる
- **業務異常は `ASSERT` で停止**（アラート対象）、**対象 0 件は `EXIT SUCCESS IF` で正常スキップ**（アラートなし）。この 2 つを混同しない — 混同すると月初のたびに誤アラートが飛ぶ
- 書き込みは**キー指定 `UPSERT`** を既定にする（何度リランしても同じ結果 = 冪等）。キーは重複禁止フィールド
- アプリ参照は `LAPP_<論理名>`（`ksql.config.json` の `apps` / `ksql.mcp.config.json` の `logicalApps` と同じ名前）
- 集計の中間結果は `CREATE TEMP TABLE`（インメモリ・書込 API を消費しない）

## Exit Code（スケジューラ・CI が分岐に使う）

| Code | 意味 |
| --- | --- |
| 0 | 成功（対象 0 件の NO_DATA を含む） |
| 1 | 検証エラー（実行前に停止） |
| 2 | 業務異常（ASSERT 違反・書き込みゼロで停止） |
| 3 | 実行時エラー（`--resume` で同じ as-of からリラン） |
| 4 | 部分成功（run-all） |
| 5 | 多重起動（何もせず終了） |

## 参照

- ランナー仕様書: https://github.com/rex0220/ksql-flow/blob/main/docs/ksql_flow_spec.md
- エンジン言語リファレンス・レシピ: MCP `ksql_docs`（こちらが一次資料）
