// Google Workspace (Admin SDK Directory API) integration.
//
// Requires domain-wide delegation on a service account -- a bare service
// account cannot manage users in a Workspace domain, Google requires
// impersonating a real super admin via delegation. See the setup steps
// given to the GSuite admin (GCP Console: enable Admin SDK API, create the
// service account, download its JSON key; Workspace Admin Console: Security
// > API Controls > Domain-wide Delegation, authorize the service account's
// Client ID for the admin.directory.user and admin.directory.orgunit scopes
// below).
//
// Until GSUITE_SERVICE_ACCOUNT_KEY_JSON and GSUITE_ADMIN_EMAIL are set in
// .env, every call here is a no-op (returns { skipped: true }) rather than
// throwing -- so the feature stays inert and never blocks the caller
// (generateEmail / resetStudent) until the Google-side setup is complete.

const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user',
  'https://www.googleapis.com/auth/admin.directory.orgunit',
];

type GsuiteResult = { ok: boolean; skipped?: boolean; error?: string };

function isConfigured(): boolean {
  return !!(process.env.GSUITE_SERVICE_ACCOUNT_KEY_JSON && process.env.GSUITE_ADMIN_EMAIL);
}

function getDirectoryClient() {
  const key = JSON.parse(process.env.GSUITE_SERVICE_ACCOUNT_KEY_JSON as string);
  const jwtClient = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES,
    subject: process.env.GSUITE_ADMIN_EMAIL, // domain-wide delegation: impersonate this admin
  });
  return google.admin({ version: 'directory_v1', auth: jwtClient });
}

// Students are organized one sub-OU per admission year under the base OU
// (e.g. /Students/2025), mirroring this Workspace's existing /admitted_2024
// convention. Creates the year sub-OU on demand if it doesn't exist yet --
// confirmed via orgunits.get/insert directly against the live directory:
// orgUnitPath is passed WITHOUT a leading slash to .get(), a missing OU
// 404s with "Org unit not found", and .insert() takes the child's bare
// `name` plus its `parentOrgUnitPath`.
async function ensureStudentOrgUnit(directory: any, year: string | number): Promise<string> {
  const base = process.env.GSUITE_OU_PATH || '/Students';
  const orgUnitPath = `${base}/${year}`;
  try {
    await directory.orgunits.get({ customerId: 'my_customer', orgUnitPath: orgUnitPath.replace(/^\//, '') });
  } catch (error: any) {
    if (error?.response?.status !== 404) throw error;
    await directory.orgunits.insert({
      customerId: 'my_customer',
      requestBody: { name: String(year), parentOrgUnitPath: base },
    });
  }
  return orgUnitPath;
}

export async function createGsuiteUser({
  email,
  password,
  firstName,
  lastName,
  year,
}: { email: string; password: string; firstName?: string; lastName?: string; year?: string | number }): Promise<GsuiteResult> {
  if (!isConfigured()) return { ok: false, skipped: true, error: 'GSuite integration not configured' };
  try {
    const directory = getDirectoryClient();
    const orgUnitPath = year
      ? await ensureStudentOrgUnit(directory, year)
      : (process.env.GSUITE_OU_PATH || '/Students');
    await directory.users.insert({
      requestBody: {
        primaryEmail: email,
        password,
        name: {
          givenName: firstName || email.split('@')[0],
          familyName: lastName || '.',
        },
        orgUnitPath,
        changePasswordAtNextLogin: false,
      },
    });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.response?.data?.error?.message || error?.message || 'Unknown GSuite error' };
  }
}

export async function updateGsuitePassword({
  email,
  password,
}: { email: string; password: string }): Promise<GsuiteResult> {
  if (!isConfigured()) return { ok: false, skipped: true, error: 'GSuite integration not configured' };
  try {
    const directory = getDirectoryClient();
    await directory.users.update({
      userKey: email,
      requestBody: { password },
    });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.response?.data?.error?.message || error?.message || 'Unknown GSuite error' };
  }
}
