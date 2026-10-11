-- Recomputes every student's balance (ais_student.accountNet) from their
-- ledger (sum of fms_studaccount.amount; positive = owing). Deleting a bill
-- or payment used to remove ledger rows without recomputing, leaving some
-- balances stale. Only rows that actually differ are touched.
-- Idempotent: safe to run more than once.

UPDATE ais_student s
  LEFT JOIN (
    SELECT studentId, SUM(amount) AS net
    FROM fms_studaccount
    WHERE studentId IS NOT NULL
    GROUP BY studentId
  ) a ON a.studentId = s.id
  SET s.accountNet = COALESCE(a.net, 0)
  WHERE ROUND(COALESCE(s.accountNet, 0), 2) <> ROUND(COALESCE(a.net, 0), 2);
