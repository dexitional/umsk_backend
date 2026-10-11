-- SMS template on admission letters (ams_letter.smsTemplate), texted to a
-- programme's freshers by "Activate Admission". Uses ::tokens (::first_name,
-- ::program, ::portal_url, ::login, ...); NULL/blank = default wording.
-- Idempotent: safe to run more than once.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ams_letter' AND COLUMN_NAME = 'smsTemplate');
SET @sql := IF(@col = 0, 'ALTER TABLE ams_letter ADD COLUMN smsTemplate TEXT NULL AFTER template', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
