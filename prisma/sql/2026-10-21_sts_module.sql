-- Supported Teaching in Schools: apply once before deploying the STS routes.
-- Additive migration; existing student, semester and appraisal data is retained.

-- CreateTable
CREATE TABLE `ais_sts_school` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `district` VARCHAR(255) NULL,
    `address` VARCHAR(500) NULL,
    `phone` VARCHAR(30) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ais_sts_school_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ais_sts_mentor` (
    `id` VARCHAR(191) NOT NULL,
    `schoolId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `phone` VARCHAR(30) NULL,
    `email` VARCHAR(255) NULL,
    `accountTag` VARCHAR(50) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ais_sts_mentor_schoolId_idx`(`schoolId`),
    INDEX `ais_sts_mentor_accountTag_idx`(`accountTag`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ais_sts_assignment` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `schoolId` VARCHAR(191) NOT NULL,
    `mentorId` VARCHAR(191) NOT NULL,
    `semesterNum` INTEGER NOT NULL,
    `yearGroup` INTEGER NOT NULL,
    `programId` VARCHAR(191) NOT NULL,
    `programName` VARCHAR(450) NOT NULL,
    `studentName` VARCHAR(950) NOT NULL,
    `indexno` VARCHAR(50) NULL,
    `schoolName` VARCHAR(255) NOT NULL,
    `mentorName` VARCHAR(255) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `notes` TEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdBy` VARCHAR(50) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ais_sts_assignment_sessionId_schoolId_yearGroup_idx`(`sessionId`, `schoolId`, `yearGroup`),
    INDEX `ais_sts_assignment_mentorId_idx`(`mentorId`),
    UNIQUE INDEX `ais_sts_assignment_studentId_sessionId_key`(`studentId`, `sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ais_sts_assignment_event` (
    `id` VARCHAR(191) NOT NULL,
    `assignmentId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(30) NOT NULL,
    `actor` VARCHAR(50) NOT NULL,
    `reason` VARCHAR(1000) NULL,
    `snapshot` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ais_sts_assignment_event_assignmentId_createdAt_idx`(`assignmentId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ais_sts_mentor` ADD CONSTRAINT `ais_sts_mentor_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `ais_sts_school`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ais_sts_assignment` ADD CONSTRAINT `ais_sts_assignment_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `ais_student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ais_sts_assignment` ADD CONSTRAINT `ais_sts_assignment_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `ais_session`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ais_sts_assignment` ADD CONSTRAINT `ais_sts_assignment_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `ais_sts_school`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ais_sts_assignment` ADD CONSTRAINT `ais_sts_assignment_mentorId_fkey` FOREIGN KEY (`mentorId`) REFERENCES `ais_sts_mentor`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ais_sts_assignment_event` ADD CONSTRAINT `ais_sts_assignment_event_assignmentId_fkey` FOREIGN KEY (`assignmentId`) REFERENCES `ais_sts_assignment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Roles appear in the existing AIS Access Control screen. No grants are automatic.
INSERT INTO sso_amodule (appId, tag, title, description, status, createdAt, updatedAt)
SELECT a.id, 'sts', 'Supported Teaching in Schools', 'Schools, mentors and semester student placements', 1, NOW(3), NOW(3)
FROM sso_app a WHERE a.tag = 'ais'
AND NOT EXISTS (SELECT 1 FROM sso_amodule m WHERE m.tag = 'sts');

INSERT INTO sso_arole (appModuleId, title, description, status, createdAt, updatedAt)
SELECT m.id, 'admin', 'Manage STS schools, mentors, placements and reports', 1, NOW(3), NOW(3)
FROM sso_amodule m WHERE m.tag = 'sts'
AND NOT EXISTS (SELECT 1 FROM sso_arole r WHERE r.appModuleId = m.id AND r.title = 'admin');

INSERT INTO sso_arole (appModuleId, title, description, status, createdAt, updatedAt)
SELECT m.id, 'mentor', 'View and update progress for own STS students', 1, NOW(3), NOW(3)
FROM sso_amodule m WHERE m.tag = 'sts'
AND NOT EXISTS (SELECT 1 FROM sso_arole r WHERE r.appModuleId = m.id AND r.title = 'mentor');
