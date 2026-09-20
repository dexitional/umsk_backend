"use strict";
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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGsuiteUser = createGsuiteUser;
exports.updateGsuitePassword = updateGsuitePassword;
const { google } = require('googleapis');
const SCOPES = ['https://www.googleapis.com/auth/admin.directory.user'];
function isConfigured() {
    return !!(process.env.GSUITE_SERVICE_ACCOUNT_KEY_JSON && process.env.GSUITE_ADMIN_EMAIL);
}
function getDirectoryClient() {
    const key = JSON.parse(process.env.GSUITE_SERVICE_ACCOUNT_KEY_JSON);
    const jwtClient = new google.auth.JWT({
        email: key.client_email,
        key: key.private_key,
        scopes: SCOPES,
        subject: process.env.GSUITE_ADMIN_EMAIL, // domain-wide delegation: impersonate this admin
    });
    return google.admin({ version: 'directory_v1', auth: jwtClient });
}
function createGsuiteUser(_a) {
    return __awaiter(this, arguments, void 0, function* ({ email, password, firstName, lastName, }) {
        var _b, _c, _d;
        if (!isConfigured())
            return { ok: false, skipped: true, error: 'GSuite integration not configured' };
        try {
            const directory = getDirectoryClient();
            yield directory.users.insert({
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
        }
        catch (error) {
            return { ok: false, error: ((_d = (_c = (_b = error === null || error === void 0 ? void 0 : error.response) === null || _b === void 0 ? void 0 : _b.data) === null || _c === void 0 ? void 0 : _c.error) === null || _d === void 0 ? void 0 : _d.message) || (error === null || error === void 0 ? void 0 : error.message) || 'Unknown GSuite error' };
        }
    });
}
function updateGsuitePassword(_a) {
    return __awaiter(this, arguments, void 0, function* ({ email, password, }) {
        var _b, _c, _d;
        if (!isConfigured())
            return { ok: false, skipped: true, error: 'GSuite integration not configured' };
        try {
            const directory = getDirectoryClient();
            yield directory.users.update({
                userKey: email,
                requestBody: { password },
            });
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: ((_d = (_c = (_b = error === null || error === void 0 ? void 0 : error.response) === null || _b === void 0 ? void 0 : _b.data) === null || _c === void 0 ? void 0 : _c.error) === null || _d === void 0 ? void 0 : _d.message) || (error === null || error === void 0 ? void 0 : error.message) || 'Unknown GSuite error' };
        }
    });
}
