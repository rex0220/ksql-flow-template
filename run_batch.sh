#!/bin/sh
# kSQL Flow: cron / systemd timer からの起動スクリプト（Linux / macOS 版）
# 配置先に依存しないよう、スクリプト自身のディレクトリへ移動する
# （Windows 版 run_batch.bat の %~dp0 と同じ思想。cron は cwd がホームになるため必須）
#   - トークンはリポジトリ内の .env（.gitignore 済み・chmod 600 推奨）
#   - node を直接起動し、ksql-flow の Exit Code をそのまま呼び出し元へ返す（0/2/3/4/5）
#   - 「失敗したら自動で再実行」は設定しない。復旧は run-all --resume（冪等リラン）に一本化
#   - 引数はそのまま run-all へ渡る: 復旧は ./run_batch.sh --resume、
#     バックフィルは ./run_batch.sh --as-of "2026-08-25T00:00:00+09:00"
cd "$(dirname "$0")" || exit 1
exec node --env-file=.env node_modules/@rex0220/ksql-flow/dist/cli.js run-all ./jobs --profile prod "$@"
