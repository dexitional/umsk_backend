-- Student NHIS number, admission type and scholarship, plus the updated
-- disability list. Idempotent: safe to run more than once.
--
--   nhisNo       NHIS (National Health Insurance) number
--   admitType    'REGULAR' or 'FEE_PAYING'
--   scholar      1 = on a scholarship
--   scholarBody  name of the scholarship institution (when scholar = 1)

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ais_student' AND COLUMN_NAME = 'nhisNo');
SET @sql := IF(@col = 0, 'ALTER TABLE ais_student ADD COLUMN nhisNo VARCHAR(50) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ais_student' AND COLUMN_NAME = 'admitType');
SET @sql := IF(@col = 0, 'ALTER TABLE ais_student ADD COLUMN admitType VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ais_student' AND COLUMN_NAME = 'scholar');
SET @sql := IF(@col = 0, 'ALTER TABLE ais_student ADD COLUMN scholar TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ais_student' AND COLUMN_NAME = 'scholarBody');
SET @sql := IF(@col = 0, 'ALTER TABLE ais_student ADD COLUMN scholarBody VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Disability list, stored in uppercase like the rest of the list. Each title
-- is added only if no row with the same title
-- (ignoring case and surrounding spaces) exists, so re-runs and existing
-- entries never duplicate. Existing rows are left as they are, since
-- students may already reference them.
INSERT INTO disability (id, title, status, createdAt, updatedAt)
SELECT UUID(), UPPER(t.title), 1, NOW(3), NOW(3)
FROM (
  SELECT 'Persons with physical disability' AS title
  UNION ALL SELECT 'Deaf persons (Persons who are non-verbal)'
  UNION ALL SELECT 'Persons with communication disabilities'
  UNION ALL SELECT 'Persons who are hard of hearing'
  UNION ALL SELECT 'Persons with visual disability'
  UNION ALL SELECT 'Persons with psychosocial disabilities'
  UNION ALL SELECT 'Persons with cerebral palsy'
  UNION ALL SELECT 'Persons with bipolar conditions'
  UNION ALL SELECT 'Persons with attention deficit disorders'
  UNION ALL SELECT 'Persons with schizophrenia'
  UNION ALL SELECT 'Persons with developmental and neurological disabilities'
  UNION ALL SELECT 'Persons with autism'
  UNION ALL SELECT 'Persons with Down syndrome'
  UNION ALL SELECT 'Persons with spinal injury'
  UNION ALL SELECT 'Persons with autoimmune conditions'
  UNION ALL SELECT 'Persons with osteogenesis imperfecta'
  UNION ALL SELECT 'Persons with albinism'
  UNION ALL SELECT 'Persons with intellectual disability'
  UNION ALL SELECT 'Persons with epilepsy'
  UNION ALL SELECT 'Persons with leprosy'
  UNION ALL SELECT 'Little persons'
) t
WHERE NOT EXISTS (
  SELECT 1 FROM disability d WHERE LOWER(TRIM(d.title)) = LOWER(TRIM(t.title))
);
