-- @ksql name: notify_test_fail
-- @ksql timeout: 60
-- @ksql dialect: 1

-- 開発用: 失敗通知（ログアプリの条件通知）の動作確認のため、意図的に ASSERT を失敗させる。
-- 業務アプリへの書込はゼロ（COUNT の読取のみ）。ログアプリに失敗レコードを残すことが目的。
--   単発実行            → 条件 2（record_type = JOB・parent_batch_id 空・FAILED 系）が発火
--   run-all .\dev\notify_test → 条件 1（record_type = BATCH・FAILED 系）が発火
-- ステータスは ABORTED になる（ASSERT 失敗 = 業務異常）。条件の status に
-- FAILED / ABORTED / TIMEOUT の 3 値が入っていることの確認も兼ねる。

ASSERT (
  SELECT COUNT(*) FROM LAPP_案件管理
  WHERE 会社名 = 'KSQL-FLOW-TEST-通知テスト-存在しない会社'
) > 0, '【通知テスト】意図的な失敗です。対応は不要です（dev/notify_test）';
