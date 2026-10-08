-- Adds the `access::admin` role (role tag = <module tag>::<role title>): the
-- only role that can manage user roles (Access Control page, /ais/access,
-- /ais/uroles, /ais/aroles). Previously this rode on `hrm::admin`, so anyone
-- who could manage HR records could also grant any role.
--
-- To avoid locking anyone out, current `hrm::admin` holders who are STAFF
-- accounts (sso_user.groupId = 2) are given `access::admin` too. Student or
-- other accounts holding hrm::admin are deliberately not copied -- review
-- and remove those from Access Control.
--
-- Lives under the Academic Management System app (sso_app.tag = 'ais').
-- Idempotent: safe to run more than once.

INSERT INTO sso_amodule (appId, tag, title, description, status, createdAt, updatedAt)
SELECT a.id, 'access', 'Access Control', 'Assign and revoke user roles across all apps', 1, NOW(3), NOW(3)
FROM sso_app a
WHERE a.tag = 'ais'
  AND NOT EXISTS (SELECT 1 FROM sso_amodule m WHERE m.tag = 'access');

INSERT INTO sso_arole (appModuleId, title, description, status, createdAt, updatedAt)
SELECT m.id, 'admin', 'Manage user roles (Access Control)', 1, NOW(3), NOW(3)
FROM sso_amodule m
WHERE m.tag = 'access'
  AND NOT EXISTS (SELECT 1 FROM sso_arole r WHERE r.appModuleId = m.id AND r.title = 'admin');

INSERT INTO sso_urole (userId, appRoleId, roleMeta, status, createdAt, updatedAt)
SELECT DISTINCT ur.userId, na.id, 'Copied from hrm::admin', 1, NOW(3), NOW(3)
FROM sso_urole ur
JOIN sso_arole ha ON ha.id = ur.appRoleId AND ha.title = 'admin'
JOIN sso_amodule hm ON hm.id = ha.appModuleId AND hm.tag = 'hrm'
JOIN sso_user u ON u.id = ur.userId AND u.groupId = 2
JOIN sso_amodule nm ON nm.tag = 'access'
JOIN sso_arole na ON na.appModuleId = nm.id AND na.title = 'admin'
WHERE NOT EXISTS (SELECT 1 FROM sso_urole x WHERE x.userId = ur.userId AND x.appRoleId = na.id);
