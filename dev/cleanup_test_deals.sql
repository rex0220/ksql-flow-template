-- @ksql name: cleanup_test_deals
-- @ksql timeout: 300
-- @ksql dialect: 1

-- 開発用: dev/seed_test_deals.sql が投入したテスト案件と、
-- 月次ジョブがテスト会社名で作成した顧客管理レコードを削除する。
-- 対象はテスト会社名の完全一致のみ（DELETE の WHERE は kintone へ押し下げ可能な
-- 述語が必要なため、LIKE でなく IN を使う）。

-- 想定外の大量削除を防ぐガード（seed が作るのは案件 3 件・顧客 2 件）
-- 注意: 境界は 1 桁にすること。エンジン v3.71.0 の ASSERT 大小比較は数値でも
-- 辞書順で比較される既知問題があり（起票済み）、2 桁境界（<= 10 等）は誤動作する。
ASSERT (
  SELECT COUNT(*) FROM LAPP_案件管理
  WHERE 会社名 IN ('KSQL-FLOW-TEST-山田商事', 'KSQL-FLOW-TEST-鈴木建設')
) <= 5, '【異常中断】KSQL-FLOW-TEST- の案件が想定より多いため削除を停止しました';

ASSERT (
  SELECT COUNT(*) FROM LAPP_顧客管理
  WHERE 会社名 IN ('KSQL-FLOW-TEST-山田商事', 'KSQL-FLOW-TEST-鈴木建設')
) <= 5, '【異常中断】KSQL-FLOW-TEST- の顧客が想定より多いため削除を停止しました';

DELETE FROM LAPP_案件管理
WHERE 会社名 IN ('KSQL-FLOW-TEST-山田商事', 'KSQL-FLOW-TEST-鈴木建設');

DELETE FROM LAPP_顧客管理
WHERE 会社名 IN ('KSQL-FLOW-TEST-山田商事', 'KSQL-FLOW-TEST-鈴木建設');
