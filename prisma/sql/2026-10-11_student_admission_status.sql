-- Fresher admission offer on ais_student. "Activate Admission" (Admission
-- Letters) sets admissionStatus = 'PENDING' for a programme's freshers; the
-- student then ACCEPTS or REJECTS from the student portal, stamping
-- admissionRespondedAt. NULL = no offer to answer (continuing students keep
-- the full portal). Idempotent: safe to run more than once.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ais_student' AND COLUMN_NAME = 'admissionStatus');
SET @sql := IF(@col = 0, 'ALTER TABLE ais_student ADD COLUMN admissionStatus VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ais_student' AND COLUMN_NAME = 'admissionRespondedAt');
SET @sql := IF(@col = 0, 'ALTER TABLE ais_student ADD COLUMN admissionRespondedAt DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
