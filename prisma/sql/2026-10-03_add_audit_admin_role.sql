-- Adds the `audit::admin` role (role tag = <module tag>::<role title>) that
-- grants full access to the Log & Audit Trail module (/logs, /api/logs).
-- Lives under the Academic Management System app (sso_app.tag = 'ais'),
-- alongside the existing `log` module. Idempotent: safe to run more than once.

INSERT INTO sso_amodule (appId, tag, title, description, status, createdAt, updatedAt)
SELECT a.id, 'audit', 'Audit Trail', 'Log & Audit Trail module: system-wide activity and assessment audit records', 1, NOW(3), NOW(3)
FROM sso_app a
WHERE a.tag = 'ais'
  AND NOT EXISTS (SELECT 1 FROM sso_amodule m WHERE m.tag = 'audit');

INSERT INTO sso_arole (appModuleId, title, description, status, createdAt, updatedAt)
SELECT m.id, 'admin', 'Full access to the Log & Audit Trail module', 1, NOW(3), NOW(3)
FROM sso_amodule m
WHERE m.tag = 'audit'
  AND NOT EXISTS (SELECT 1 FROM sso_arole r WHERE r.appModuleId = m.id AND r.title = 'admin');
