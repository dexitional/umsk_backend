-- Lets a student change their Date of Birth (dob) and Hall of Affiliation
-- (instituteAffliate) once from the student portal. Each timestamp records
-- when that one-time self-edit was used; NULL means it is still available.
-- Admin edits (AIS student form) don't set these. Idempotent: safe to run
-- more than once.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ais_student' AND COLUMN_NAME = 'dobEditedAt');
SET @sql := IF(@col = 0, 'ALTER TABLE ais_student ADD COLUMN dobEditedAt DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ais_student' AND COLUMN_NAME = 'affiliateEditedAt');
SET @sql := IF(@col = 0, 'ALTER TABLE ais_student ADD COLUMN affiliateEditedAt DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
