-- @ksql name: monthly_deal_summary
-- @ksql timeout: 600
-- @ksql dialect: 1

-- 当月受注予定（受注予定日が当月内）の案件を会社別に集計し、
-- 顧客管理の 当月案件件数・当月売上合計・最終集計日時 を更新する。
-- as-of 注入（/flow の asOf）で過去月のバックフィルも同一スクリプトで再現可能。

-- 1) 業務異常ゲート: マイナス売上があれば何も書かずに中断（アラート対象）
ASSERT (
  SELECT COUNT(*) FROM LAPP_案件管理
  WHERE 受注予定日 >= @MONTH_START() AND 受注予定日 < @NEXT_MONTH_START()
    AND 売上 < 0
) = 0, '【異常中断】当月受注予定の案件にマイナスの売上データが存在します';

-- 2) 会社別に集計（インメモリ・書込 API 消費なし）
CREATE TEMP TABLE summary AS
SELECT 会社名,
       COUNT(*) AS 当月案件件数,
       SUM(売上) AS 当月売上合計
FROM LAPP_案件管理
WHERE 受注予定日 >= @MONTH_START() AND 受注予定日 < @NEXT_MONTH_START()
GROUP BY 会社名;

-- 3) 対象 0 件の月は正常スキップ（アラートなし）
EXIT SUCCESS IF (SELECT COUNT(*) FROM summary) = 0,
  '当月受注予定の案件が 0 件のためスキップ';

-- 4) 冪等な書き込み: 会社名（重複禁止）をキーに UPSERT
UPSERT INTO LAPP_顧客管理 (会社名, 当月案件件数, 当月売上合計, 最終集計日時)
SELECT 会社名, 当月案件件数, 当月売上合計, @NOW()
FROM summary
KEY (会社名);
