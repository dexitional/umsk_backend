-- Apply once, after prior migrations. Existing hall text is retained as the original affiliation.
-- AlterTable
ALTER TABLE `ais_student` ADD COLUMN `currentHallId` VARCHAR(191) NULL,
    ADD COLUMN `originalHallId` VARCHAR(191) NULL,
    ADD COLUMN `originalHallSource` VARCHAR(30) NULL;

-- CreateTable
CREATE TABLE `ais_hall` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(350) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ais_hall_code_key`(`code`),
    UNIQUE INDEX `ais_hall_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ais_hall_room` (
    `id` VARCHAR(191) NOT NULL,
    `hallId` VARCHAR(191) NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `gender` VARCHAR(1) NOT NULL,
    `capacity` INTEGER NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ais_hall_room_hallId_code_key`(`hallId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ais_hall_assignment` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `academicYear` VARCHAR(50) NOT NULL,
    `hallId` VARCHAR(191) NOT NULL,
    `roomId` VARCHAR(191) NOT NULL,
    `semesterNum` INTEGER NOT NULL,
    `studentName` VARCHAR(950) NOT NULL,
    `indexno` VARCHAR(50) NULL,
    `originalHallName` VARCHAR(350) NOT NULL,
    `hallName` VARCHAR(350) NOT NULL,
    `roomCode` VARCHAR(50) NOT NULL,
    `gender` VARCHAR(1) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdBy` VARCHAR(50) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ais_hall_assignment_roomId_academicYear_status_idx`(`roomId`, `academicYear`, `status`),
    INDEX `ais_hall_assignment_academicYear_hallId_idx`(`academicYear`, `hallId`),
    UNIQUE INDEX `ais_hall_assignment_studentId_academicYear_key`(`studentId`, `academicYear`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ais_hall_assignment_event` (
    `id` VARCHAR(191) NOT NULL,
    `assignmentId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(30) NOT NULL,
    `actor` VARCHAR(50) NOT NULL,
    `reason` VARCHAR(1000) NULL,
    `snapshot` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ais_hall_assignment_event_assignmentId_createdAt_idx`(`assignmentId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ais_hall_affiliation_event` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(30) NOT NULL,
    `actor` VARCHAR(50) NOT NULL,
    `reason` VARCHAR(1000) NULL,
    `snapshot` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ais_hall_affiliation_event_studentId_createdAt_idx`(`studentId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ais_student` ADD CONSTRAINT `ais_student_originalHallId_fkey` FOREIGN KEY (`originalHallId`) REFERENCES `ais_hall`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ais_student` ADD CONSTRAINT `ais_student_currentHallId_fkey` FOREIGN KEY (`currentHallId`) REFERENCES `ais_hall`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ais_hall_room` ADD CONSTRAINT `ais_hall_room_hallId_fkey` FOREIGN KEY (`hallId`) REFERENCES `ais_hall`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ais_hall_assignment` ADD CONSTRAINT `ais_hall_assignment_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `ais_student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ais_hall_assignment` ADD CONSTRAINT `ais_hall_assignment_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `ais_session`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ais_hall_assignment` ADD CONSTRAINT `ais_hall_assignment_hallId_fkey` FOREIGN KEY (`hallId`) REFERENCES `ais_hall`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ais_hall_assignment` ADD CONSTRAINT `ais_hall_assignment_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `ais_hall_room`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ais_hall_assignment_event` ADD CONSTRAINT `ais_hall_assignment_event_assignmentId_fkey` FOREIGN KEY (`assignmentId`) REFERENCES `ais_hall_assignment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ais_hall_affiliation_event` ADD CONSTRAINT `ais_hall_affiliation_event_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `ais_student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Preserve the currently recorded hall; prior unrecorded transfers cannot be inferred.
INSERT INTO ais_hall (id, code, name, active, version, createdAt, updatedAt)
SELECT UUID(), CONCAT('LEGACY-', MD5(LOWER(existing.name))), existing.name, 1, 1, NOW(3), NOW(3)
FROM (SELECT MIN(TRIM(instituteAffliate)) AS name FROM ais_student
WHERE instituteAffliate IS NOT NULL AND TRIM(instituteAffliate) <> ''
GROUP BY TRIM(instituteAffliate)) existing;
UPDATE ais_student s JOIN ais_hall h ON h.name = TRIM(s.instituteAffliate)
SET s.originalHallId = h.id, s.currentHallId = h.id, s.originalHallSource = 'LEGACY';
INSERT INTO ais_hall_affiliation_event (id, studentId, action, actor, reason, snapshot, createdAt)
SELECT UUID(), id, 'LEGACY_IMPORTED', 'system:migration', 'Existing hall value preserved; historical admission hall not independently verified',
JSON_OBJECT('originalHallId', originalHallId, 'originalHallName', instituteAffliate, 'currentHallId', currentHallId, 'source', 'LEGACY'), NOW(3)
FROM ais_student WHERE originalHallId IS NOT NULL;

INSERT INTO sso_amodule (appId, tag, title, description, status, createdAt, updatedAt)
SELECT a.id, 'hall', 'Hall Module', 'Halls, gender-based rooms and annual student placements', 1, NOW(3), NOW(3)
FROM sso_app a WHERE a.tag = 'ais'
AND NOT EXISTS (SELECT 1 FROM sso_amodule m WHERE m.tag = 'hall');
INSERT INTO sso_arole (appModuleId, title, description, status, createdAt, updatedAt)
SELECT m.id, 'admin', 'Manage halls, rooms, affiliations and placement reports', 1, NOW(3), NOW(3)
FROM sso_amodule m WHERE m.tag = 'hall'
AND NOT EXISTS (SELECT 1 FROM sso_arole r WHERE r.appModuleId = m.id AND r.title = 'admin');
