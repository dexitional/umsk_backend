-- Apply once. Retain the legacy programme column for rollback/data compatibility.
ALTER TABLE ais_structure ADD COLUMN scheme_id VARCHAR(191) NULL;
CREATE INDEX ais_structure_scheme_id_idx ON ais_structure(scheme_id);
ALTER TABLE ais_structure ADD CONSTRAINT ais_structure_scheme_id_fkey
  FOREIGN KEY (scheme_id) REFERENCES ais_scheme(id) ON DELETE RESTRICT ON UPDATE CASCADE;
-- Preserve each existing curriculum's former programme grading configuration.
UPDATE ais_structure c JOIN ais_program p ON p.id = c.programId
SET c.scheme_id = p.schemeId WHERE c.scheme_id IS NULL AND p.schemeId IS NOT NULL;
-- No assessment/resit schemes or recorded grades are changed.
