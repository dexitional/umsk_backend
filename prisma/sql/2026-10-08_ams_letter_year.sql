-- Admission year on admission letters (ams_letter.year), e.g. 2026:
-- ::session_year prints as 2026/2027 and a programme's bulk print picks the
-- students whose date of admission (ais_student.entryDate) is in that year.
-- NULL keeps the old behaviour (default session year, current Year 1).
-- Also drops the unused old AMS admission-category column (categoryId).
-- Idempotent: safe to run more than once.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ams_letter' AND COLUMN_NAME = 'year');
SET @sql := IF(@col = 0, 'ALTER TABLE ams_letter ADD COLUMN `year` INT NULL AFTER category', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ams_letter' AND COLUMN_NAME = 'categoryId');
SET @sql := IF(@col = 1, 'ALTER TABLE ams_letter DROP COLUMN categoryId', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
