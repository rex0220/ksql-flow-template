-- @ksql name: seed_test_deals
-- @ksql timeout: 300
-- @ksql dialect: 1

-- 開発用: 当月の案件データが無い環境で、月次ジョブの書込経路まで検証するための
-- テストデータ投入。会社名・案件名は KSQL-FLOW-TEST- プレフィックスで識別でき、
-- dev/cleanup_test_deals.sql（会社名の完全一致で削除）で漏れなく片付けられる。
-- 書き込みを伴うため実行は人間が行う（npm run job -- -f dev/seed_test_deals.sql --profile <p>）。
--
-- 実装メモ:
-- * INSERT ... VALUES はリテラル限定で @TODAY() 等の as-of 関数を書けないため、
--   既存 1 行をソースにした INSERT ... SELECT で当月日付を注入する
-- * テスト会社名の判定は LIKE でなく IN（完全一致）を使う — DELETE の WHERE は
--   kintone へ押し下げ可能な述語が必要で、LIKE は使えない（cleanup と条件を揃える）

-- すでに投入済みなら何もしない（再実行しても増殖しない）
EXIT SUCCESS IF (
  SELECT COUNT(*) FROM LAPP_案件管理
  WHERE 会社名 IN ('KSQL-FLOW-TEST-山田商事', 'KSQL-FLOW-TEST-鈴木建設')
) > 0, 'テストデータは投入済みのためスキップ（削除は dev/cleanup_test_deals.sql）';

-- INSERT ... SELECT の 1 行ソースに使うため、案件管理が空でないことを確認
ASSERT (SELECT COUNT(*) FROM LAPP_案件管理) > 0,
  '【中断】案件管理にレコードが 1 件もありません（SFA パックのサンプルデータを入れるか、手動で 1 件登録してから再実行してください）';

INSERT INTO LAPP_案件管理 (会社名, 案件名, 売上, 受注予定日)
SELECT 'KSQL-FLOW-TEST-山田商事', 'KSQL-FLOW-TEST-案件A', 100000, @TODAY()
FROM LAPP_案件管理 LIMIT 1;

INSERT INTO LAPP_案件管理 (会社名, 案件名, 売上, 受注予定日)
SELECT 'KSQL-FLOW-TEST-山田商事', 'KSQL-FLOW-TEST-案件B', 50000, @MONTH_START()
FROM LAPP_案件管理 LIMIT 1;

INSERT INTO LAPP_案件管理 (会社名, 案件名, 売上, 受注予定日)
SELECT 'KSQL-FLOW-TEST-鈴木建設', 'KSQL-FLOW-TEST-案件C', 380000, @TODAY()
FROM LAPP_案件管理 LIMIT 1;
