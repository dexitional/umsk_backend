// Google Workspace (Admin SDK Directory API) integration.
//
// Requires domain-wide delegation on a service account -- a bare service
// account cannot manage users in a Workspace domain, Google requires
// impersonating a real super admin via delegation. See the setup steps
// given to the GSuite admin (GCP Console: enable Admin SDK API, create the
// service account, download its JSON key; Workspace Admin Console: Security
// > API Controls > Domain-wide Delegation, authorize the service account's
// Client ID for the https://www.googleapis.com/auth/admin.directory.user
// scope).
//
// Until GSUITE_SERVICE_ACCOUNT_KEY_JSON and GSUITE_ADMIN_EMAIL are set in
// .env, every call here is a no-op (returns { skipped: true }) rather than
// throwing -- so the feature stays inert and never blocks the caller
// (generateEmail / resetStudent) until the Google-side setup is complete.

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/admin.directory.user'];

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

export async function createGsuiteUser({
  email,
  password,
  firstName,
  lastName,
}: { email: string; password: string; firstName?: string; lastName?: string }): Promise<GsuiteResult> {
  if (!isConfigured()) return { ok: false, skipped: true, error: 'GSuite integration not configured' };
  try {
    const directory = getDirectoryClient();
    await directory.users.insert({
      requestBody: {
        primaryEmail: email,
        password,
        name: {
          givenName: firstName || email.split('@')[0],
          familyName: lastName || '.',
        },
        orgUnitPath: process.env.GSUITE_OU_PATH || '/Students',
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
