-- @ksql name: monthly_deal_summary
-- @ksql timeout: 600
-- @ksql dialect: 1

-- Step 1: 業務異常があれば安全停止（アラート対象）
ASSERT (
  SELECT COUNT(*) FROM LAPP_案件管理
  WHERE 受注予定日 >= @MONTH_START() AND 受注予定日 < @NEXT_MONTH_START()
    AND 売上 < 0
) = 0, '【異常中断】マイナスの売上データが存在するため処理を停止しました';

-- Step 2: インメモリ一時テーブルへ集計（この間 kintone API は消費しない）
CREATE TEMP TABLE temp_monthly_summary AS
SELECT 会社名, COUNT(案件No_) AS 案件件数, SUM(売上) AS 売上合計
FROM LAPP_案件管理
WHERE 受注予定日 >= @MONTH_START() AND 受注予定日 < @NEXT_MONTH_START()
GROUP BY 会社名;

-- Step 3: 対象 0 件は「正常な早期終了」（アラートを鳴らさない）
EXIT SUCCESS IF (SELECT COUNT(*) FROM temp_monthly_summary) = 0,
  '集計対象となる案件データが 0 件のためスキップ';

-- Step 4: キー指定 UPSERT（何度リランしても同じ結果になる = 冪等）
UPSERT INTO LAPP_顧客管理 (会社名, 当月案件件数, 当月売上合計, 最終集計日時)
SELECT 会社名, 案件件数, 売上合計, @NOW()  -- @NOW() は実時計ではなくバッチ開始時の基準時刻（as-of）
FROM temp_monthly_summary
KEY (会社名);
