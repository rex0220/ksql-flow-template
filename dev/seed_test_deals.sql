-- @ksql name: seed_test_deals
-- @ksql timeout: 300
-- @ksql dialect: 1

-- 開発用: 当月の案件データが無い環境で、月次ジョブの書込経路まで検証するための
-- テストデータ投入。会社名・案件名は KSQL-FLOW-TEST- プレフィックスで識別でき、
-- dev/cleanup_test_deals.sql（会社名の完全一致で削除）で漏れなく片付けられる。
-- 書き込みを伴うため実行は人間が行う（npm run job -- -f dev/seed_test_deals.sql --profile <p>）。
-- 前提: kintone-sql-tools v3.72.0 以降（INSERT ... VALUES での as-of 関数対応）。

-- すでに投入済みなら何もしない（再実行しても増殖しない）
EXIT SUCCESS IF (
  SELECT COUNT(*) FROM LAPP_案件管理
  WHERE 会社名 IN ('KSQL-FLOW-TEST-山田商事', 'KSQL-FLOW-TEST-鈴木建設')
) > 0, 'テストデータは投入済みのためスキップ（削除は dev/cleanup_test_deals.sql）';

-- 先にテスト顧客を作る。SFA パックの案件管理の 会社名 はルックアップ
-- （参照元 = 顧客管理）のため、参照先に存在しない会社名は案件に書けない。
-- 冪等 UPSERT なので途中失敗からのリランでも安全
UPSERT INTO LAPP_顧客管理 (会社名)
VALUES ('KSQL-FLOW-TEST-山田商事')
KEY (会社名);

UPSERT INTO LAPP_顧客管理 (会社名)
VALUES ('KSQL-FLOW-TEST-鈴木建設')
KEY (会社名);

INSERT INTO LAPP_案件管理 (会社名, 案件名, 売上, 受注予定日)
VALUES ('KSQL-FLOW-TEST-山田商事', 'KSQL-FLOW-TEST-案件A', 100000, @TODAY());

INSERT INTO LAPP_案件管理 (会社名, 案件名, 売上, 受注予定日)
VALUES ('KSQL-FLOW-TEST-山田商事', 'KSQL-FLOW-TEST-案件B', 50000, @MONTH_START());

INSERT INTO LAPP_案件管理 (会社名, 案件名, 売上, 受注予定日)
VALUES ('KSQL-FLOW-TEST-鈴木建設', 'KSQL-FLOW-TEST-案件C', 380000, @TODAY());
