-- Existing lookup tables and ais_activity_progchange are reused without data changes.
INSERT INTO sso_amodule (appId, tag, title, description, status, createdAt, updatedAt)
SELECT a.id, 'utilities', 'Utilities Module', 'Reference data and student changes of program', 1, NOW(3), NOW(3)
FROM sso_app a WHERE a.tag = 'ais'
AND NOT EXISTS (SELECT 1 FROM sso_amodule m WHERE m.tag = 'utilities');
INSERT INTO sso_arole (appModuleId, title, description, status, createdAt, updatedAt)
SELECT m.id, 'admin', 'Manage utilities and approve student changes of program', 1, NOW(3), NOW(3)
FROM sso_amodule m WHERE m.tag = 'utilities'
AND NOT EXISTS (SELECT 1 FROM sso_arole r WHERE r.appModuleId = m.id AND r.title = 'admin');
