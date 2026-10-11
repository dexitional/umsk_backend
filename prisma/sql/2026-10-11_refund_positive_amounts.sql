-- Refunds are posted like charges: a POSITIVE fms_studaccount.amount, which
-- raises the student's balance (ais_student.accountNet; positive = owing).
-- They used to be written negative (like payments). This recomputes
-- accountNet for every student with a negative refund row (as if the row
-- were already positive), then flips those rows.
-- Idempotent: once no negative REFUND rows remain, it changes nothing.

UPDATE ais_student s
  JOIN (
    SELECT studentId,
           SUM(CASE WHEN (type = 'REFUND' OR refundId IS NOT NULL) AND amount < 0 THEN -amount ELSE amount END) AS net
    FROM fms_studaccount
    WHERE studentId IS NOT NULL
    GROUP BY studentId
    HAVING SUM((type = 'REFUND' OR refundId IS NOT NULL) AND amount < 0) > 0
  ) a ON a.studentId = s.id
  SET s.accountNet = a.net;

UPDATE fms_studaccount SET amount = -amount
  WHERE (type = 'REFUND' OR refundId IS NOT NULL) AND amount < 0;
