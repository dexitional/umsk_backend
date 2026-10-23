-- Apply once after 2026-10-22_hall_management.sql.
-- Existing affiliations do not prove the official hall gender; configure it in Hall Module.
ALTER TABLE ais_hall ADD COLUMN gender VARCHAR(1) NULL;
-- New affiliations/room assignments are blocked until the hall gender is configured.
-- Existing hall affiliations and placement history are preserved.
