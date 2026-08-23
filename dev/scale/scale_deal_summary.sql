-- @ksql name: scale_deal_summary
-- @ksql timeout: 3600
-- @ksql dialect: 1

-- スケール検証専用の集計ジョブ。jobs/monthly_deal_summary.sql と同じ構成だが、
-- ASSERT・集計・書込のすべてを KSQL-FLOW-TEST-C プレフィックスに限定しており、
-- 実データ（テスト外の案件・顧客）には一切書き込まない。
-- 読取件数が既定上限 10,000 を超える L 段階では limits.maxReadRows / maxTempRows を
-- 25,000 に設定すること（企画 R2 §4 L-9）。

-- 1) 業務異常ゲート（テストスコープ内のみ）
ASSERT (
  SELECT COUNT(*) FROM LAPP_案件管理
  WHERE 会社名 LIKE 'KSQL-FLOW-TEST-C%'
    AND 受注予定日 >= @MONTH_START() AND 受注予定日 < @NEXT_MONTH_START()
    AND 売上 < 0
) = 0, '【異常中断】テスト案件にマイナスの売上データが存在します';

-- 2) 会社別に集計（インメモリ）
CREATE TEMP TABLE summary AS
SELECT 会社名,
       COUNT(*) AS 当月案件件数,
       SUM(売上) AS 当月売上合計
FROM LAPP_案件管理
WHERE 会社名 LIKE 'KSQL-FLOW-TEST-C%'
  AND 受注予定日 >= @MONTH_START() AND 受注予定日 < @NEXT_MONTH_START()
GROUP BY 会社名;

-- 3) 対象 0 件は正常スキップ
EXIT SUCCESS IF (SELECT COUNT(*) FROM summary) = 0,
  'テスト案件が 0 件のためスキップ';

-- 4) 冪等な書き込み（書込先もテスト会社のみ）
UPSERT INTO LAPP_顧客管理 (会社名, 当月案件件数, 当月売上合計, 最終集計日時)
SELECT 会社名, 当月案件件数, 当月売上合計, @NOW()
FROM summary
KEY (会社名);
