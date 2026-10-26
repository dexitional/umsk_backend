-- Credential vault: the portal password last issued to each student,
-- AES-256-GCM encrypted with CREDENTIAL_VAULT_KEY (util/credentialVault.ts).
-- Lets staff re-send credentials in bulk and push the same password to
-- Google Workspace when the institutional email is generated. Additive;
-- safe to run more than once.

CREATE TABLE IF NOT EXISTS `ais_student_credential` (
    `studentId` VARCHAR(191) NOT NULL,
    `cipher` TEXT NOT NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`studentId`),
    CONSTRAINT `ais_student_credential_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `ais_student`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
