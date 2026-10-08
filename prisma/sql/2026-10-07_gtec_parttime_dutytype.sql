-- GTEC statutory return support:
--   * staffStatus PARTTIME marks part-time staff (Table 14).
--   * hrs_job.dutyType marks a job as TECHNICAL / NON_TECHNICAL (Tables 15-16);
--     NULL until set on the job form.
-- Idempotent: safe to run more than once.

ALTER TABLE hrs_staff
  MODIFY staffStatus ENUM('TEMPORAL','PERMANENT','DEAD','RETIRED','ABSENCE','EXITED','PARTTIME') NOT NULL DEFAULT 'PERMANENT';

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hrs_job' AND COLUMN_NAME = 'dutyType');
SET @sql := IF(@col = 0, "ALTER TABLE hrs_job ADD COLUMN dutyType ENUM('TECHNICAL','NON_TECHNICAL') NULL AFTER staffCategory", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
