-- スケール検証のシード: エンジン CLI (ksql) の IMPORT で実行する。
-- ソースは --import-csv customers=<path> --import-csv deals=<path> で供給（gate ON）。
-- 顧客 → 案件の順（案件管理の 会社名 はルックアップで参照先の存在が必須）。
-- 顧客は ON DUPLICATE で冪等。案件は INSERT のため、再実行の前に cleanup を先に流すこと。

IMPORT INTO LAPP_顧客管理 (会社名)
FROM CSV customers BY NAME
ON DUPLICATE (会社名);

IMPORT INTO LAPP_案件管理 (会社名, 案件名, 売上, 受注予定日)
FROM CSV deals BY NAME;
