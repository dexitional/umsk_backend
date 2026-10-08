-- Restores ams_letter (admission letter templates) and ties each template to
-- a programme: programId (FK ais_program) and category (programme category,
-- default UG). The original categoryId column (old AMS admission category)
-- is kept for compatibility but is no longer used.
-- Idempotent: creates the table if missing, otherwise adds the new columns.

CREATE TABLE IF NOT EXISTS `ams_letter` (
  `id` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `categoryId` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `programId` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `category` enum('CP','DP','UG','PG') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UG',
  `title` varchar(350) COLLATE utf8mb4_unicode_ci NOT NULL,
  `signatory` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `signature` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `template` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` tinyint(1) NOT NULL DEFAULT '1',
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ams_letter_programId_idx` (`programId`),
  CONSTRAINT `ams_letter_programId_fkey` FOREIGN KEY (`programId`) REFERENCES `ais_program` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An older ams_letter (without programme columns) gets them added.
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ams_letter' AND COLUMN_NAME = 'programId');
SET @sql := IF(@col = 0, "ALTER TABLE ams_letter ADD COLUMN programId varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL, ADD KEY ams_letter_programId_idx (programId), ADD CONSTRAINT ams_letter_programId_fkey FOREIGN KEY (programId) REFERENCES ais_program (id) ON DELETE SET NULL ON UPDATE CASCADE", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ams_letter' AND COLUMN_NAME = 'category');
SET @sql := IF(@col = 0, "ALTER TABLE ams_letter ADD COLUMN category enum('CP','DP','UG','PG') NOT NULL DEFAULT 'UG'", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
