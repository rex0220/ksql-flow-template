# リラン指示ポーラー VPS 導入・運用手順

このポーラーは、実行ログアプリの失敗した BATCH レコードにある `rerun_request` を 5 分ごとに確認し、確保に成功した 1 件だけを `run_batch.sh --resume` で実行します。実 kintone を使うドリルは人間が実施する後工程です。ローカルテストから実 kintone への書き込みは行いません。

## 前提

- VPS の Node.js が 22 系であること
- `/usr/bin/node` と `/usr/bin/flock` が存在すること。異なる場合は `scripts/poll_control.sh` の固定パスを配備先に合わせてレビュー付きで変更すること
- リポジトリが `/opt/ksql/my-ksql-jobs` に配置され、通常バッチと同じ専用 OS ユーザーで動くこと
- `.env` に既存の `KSQL_TOKEN_LOGS` があり、Git 管理外かつ mode 600 であること
- API トークンに実行ログアプリのレコード閲覧・編集権限があること

API トークンは Administrator 相当で動作し、kintone のフィールド単位アクセス権の対象外です。実ユーザーには `rerun_request` だけを編集可能にし、他の編集可能フィールドは閲覧だけにします。トークンを保持する VPS と専用 OS ユーザーを同じ管理境界として扱ってください。

## 実行ログアプリの契約

ログアプリ 4249 に次の 10 フィールドが必要です。すべて必須にせず、`rerun_request` の既定値はチェックなし、`rerun_state` の既定値は未選択にします。

| フィールドコード | 型 | 選択肢 |
| --- | --- | --- |
| `rerun_request` | チェックボックス | `REQUEST` のみ |
| `rerun_state` | ドロップダウン | `REQUESTED`, `CLAIMED`, `SUCCESS`, `FAILED`, `UNKNOWN`, `EXPIRED`, `CANCELED` のみ |
| `rerun_requested_at` | 日時 | なし |
| `rerun_requested_by` | 文字列（1行） | なし |
| `rerun_claimed_host` | 文字列（1行） | なし |
| `rerun_claim_expires_at` | 日時 | なし |
| `rerun_attempt` | 数値 | 整数、最小 0、初期値 0 |
| `rerun_exit_code` | 数値 | 整数 |
| `rerun_result` | 文字列（複数行） | なし |
| `rerun_batch_id` | 文字列（1行） | なし |

## 配備前の設定

1. `poll-control.config.json` を配備先に合わせます。秘密値は書かず、`tokenEnv` には環境変数名 `KSQL_TOKEN_LOGS` だけを指定します。
2. `baseUrl` は `ksql.config.json` の `prod.baseUrl` と同じ HTTPS origin、`logAppId` は実行ログアプリの ID、`profile` は `prod` にします。
3. `host` は VPS 上で `hostname` を実行した結果、すなわち Node の `os.hostname()` と完全一致させます。リポジトリ内の実値設定は配備前の仮値 `vps-batch-01` です。
4. `command` と `cwd` は配備先の絶対パスにします。args は `['--resume']` から変更できません。
5. `batchTimeoutSec` は kSQL Flow の有効値と一致させます。現在は既定の 3600 秒、claim の余裕は 600 秒です。kSQL Flow 側の timeout を変える PR では同時に見直します。
6. `requestTtlSec` は最大ポーリング空白より長くします。既定は 6 時間、ポーリング空白の申告値は 5 分です。
7. 実行権限と秘密ファイルの権限を設定します。

```sh
cd /opt/ksql/my-ksql-jobs
chmod 700 scripts/poll_control.sh
chmod 600 .env poll-control.config.json
```

## 必須 preflight

cron を有効にする前、およびフィールドや設定を変更した後に実行します。通常ポーリングはこの field check を毎回実行しません。

```sh
cd /opt/ksql/my-ksql-jobs
/usr/bin/node --env-file=.env scripts/poll_control.mjs --config poll-control.config.json --check
```

成功時は `リラン用フィールド契約を確認しました。` と表示されます。失敗時は候補取得も `run_batch.sh` の起動も行いません。詳細な API 本文やトークンは表示しない設計なので、設定値、アプリの 10 フィールド、API 権限、ネットワークを管理画面側と照合してください。

ローカル回帰も配備前に実行します。

```sh
node --test test/poll_control.test.mjs
node --check scripts/poll_control.mjs
node --check test/poll_control.test.mjs
```

## cron

通常バッチの cron 行は変更せず、その下に終日 5 分間隔で追加します。営業時間限定を既定にしません。

```cron
*/5 * * * * /opt/ksql/my-ksql-jobs/scripts/poll_control.sh >> /var/log/ksql/poll-control.log 2>&1
```

`poll_control.sh` は `/run/lock/ksql-poll-control.lock` を non-blocking で確保します。競合時は API を呼ばず正常スキップします。定期実行の主は VPS cron または GitHub Actions の一方だけにし、二重スケジュールを常用しないでください。

## logrotate

`/etc/logrotate.d/ksql-poll-control` を root で次の内容にします。専用 OS ユーザー名・グループ名は実環境に合わせてください。

```text
/var/log/ksql/poll-control.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 ksql ksql
}
```

ポーラーは子プロセスの stdout / stderr をこのログへそのまま流しますが、kintone の `rerun_result` へは固定要約だけを書きます。ログを問い合わせやチケットへ貼る前にも、通常バッチ側の出力に秘密情報がないことを確認してください。

## 日常運用

1. 実行ログアプリで対象が `record_type = BATCH`、`status = FAILED / ABORTED / TIMEOUT`、profile と host が目的の VPS と一致することを確認します。
2. 人間が編集できる `rerun_request` の `REQUEST` だけをチェックして保存します。
3. 通常は 5 分以内に `rerun_state = CLAIMED` となります。実行中もチェックは残ります。
4. Exit 0〜4、未知終了、期限切れ、stale、取消では終端状態となりチェックが外れます。Exit 5 だけは `REQUESTED` に戻ってチェックを維持し、期限内の次回 poll で再度確保を試みます。
5. `rerun_batch_id` が空でも、候補 BATCH が 0 件または複数件なら仕様どおりです。元レコードの固定要約と、その時刻帯の実行ログを照合します。

kintone の停止リマインダーは「更新日時 + 1 時間」かつ「チェックあり・`rerun_state` 未選択」だけを検知します。誤報ゼロを優先するため、終端状態への再要求や Exit 5 継続の滞留は対象外です。再要求が進まないときは、通知を待たずに元レコードの `rerun_state` を直接確認してください。

## 障害時の確認と復旧

- 未選択のまま進まない: cron、`poll-control.log`、固定された Node/flock パス、hostname、API 接続を確認し、`--check` を再実行します。
- `REQUESTED` が続く: 通常バッチや別の resume が動いていないかを確認します。要求時刻は Exit 5 で延長されません。
- `UNKNOWN`: 自動再実行しません。VPS のプロセスと同時刻の BATCH/JOB ログを人間が照合し、必要なら元レコードへ改めてチェックを入れます。
- `CANCELED`: 対象 status、受付上限、profile/host を確認し、正しい失敗 BATCH を選び直します。
- 結果書込が競合した可能性: ポーラーは再 GET と 1 回の再適用までで停止します。`CLAIMED` が stale になった場合も自動実行されないため、実行ログと VPS を照合します。

停止する場合は cron 行をコメントアウトします。実行中プロセスを強制終了すると結果が `UNKNOWN` または stale になる可能性があるため、まず `rerun_state = CLAIMED` の有無とプロセスを確認してください。cron を戻す前に `--check` を通します。

実機ドリルでは、作成・変更する識別可能な値をすべて `KSQL_FLOW_TEST_` で始めます。Exit 0 / 2 / 3 / 5、期限切れ、claim 競合、結果競合、stale、再要求、BATCH 0 件 / 複数件の確認と、prefix 限定の後片付けは人間と実施してください。本番 lock を無効化して競合を作らないでください。

## kintone メンテナンス時間帯の挙動

メンテナンス時間帯のポーリングに**特別な対応は不要**です（cron の時間指定でポーリングを止めない — メンテは不定期・告知制のため、静的に彫り込むと手順が腐ります）。

- **待機中にメンテへ入った場合**: 候補 GET が失敗（503 / メンテページの HTML）→ 有限回の再試行後、**何も書かず・何も起動せず**終了。固定文言 1 行がログに残るだけで、5 分後の次回 cron が再試行します。claim 前に必ず失敗するため状態は壊れません
- **claim 後にメンテへ入った場合（稀）**: resume が Exit 3、または結果書き戻しが失敗し、レコードは `CLAIMED` のまま残ります → 確保期限（`batchTimeoutSec` + `claimGraceSec`）超過後の stale 回収で `UNKNOWN` + チェック解除に収束。メンテ明けに再チェックしてください
- **リマインダーとの重なり**: メンテ直前の要求が 1 時間を超えて未処理になると、メンテ明けに「ポーラーを確認してください」が 1 通届くことがあります。ポーラー自体は正常で、明け後 5 分以内に処理が進みます（発報は 1 回きり）
