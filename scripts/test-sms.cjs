// node --test scripts/test-sms.cjs — all provider calls are mocked; no SMS is sent.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function load(relative, mocks = {}, env = {}) {
  const filename = path.resolve(root, relative);
  const source = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, process: { env }, setTimeout, console: { warn() {}, log() {}, error() {} }, require: id => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id.startsWith('.')) throw new Error('Unmocked dependency: ' + id);
    return require(id);
  } }, { filename });
  return module.exports;
}
const accepted = () => ({ data: { status: 'success', code: '2000', summary: { _id: 'campaign', total_sent: 1, total_rejected: 0 } } });
const gateway = (post = async () => accepted(), env = { UMS_SMS_KEY: 'test-key', UMS_SENDERID: 'College' }) => load('config/sms.ts', { axios: { post } }, env);
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
function controller(db, sms) {
  return new (load('controller/aisController.ts', {
    '../prisma/client': { prisma: db }, '../util/residence': {}, '../util/academic': {}, '../util/curriculumScheme': {}, '../prisma/auditAssessment': {},
    '../util/pushBroadcast': { broadcastCircular: async () => {} }, '../util/helper': { errorMessage: e => e.message }, '../util/statutoryReport': {},
    '../util/paramStr': { paramStr: x => String(x) }, '../util/sheetScope': {}, '../util/resitScope': {}, '../drizzle/schema': {},
    '../util/password': { generateStrongPassword: () => 'Test-password', hashPassword: password => 'hashed:' + password }, '../config/gsuite': { updateGsuitePassword: async () => ({ ok: true }) }, '../config/sms': sms,
    nanoid: { customAlphabet: () => () => 'test' }, exceljs: {},
  }).default)();
}
test('normalizes Ghana phone formats, international numbers and legacy alternatives', () => {
  const sms = gateway();
  for (const value of ['024 123-4567', '+233 (24) 1234567', '233241234567', '00233241234567', '+233(0)241234567', 241234567, '0241234567 / 0201234567']) assert.equal(sms.normalizePhone(value), '0241234567');
  assert.equal(sms.normalizePhone('+44 7700 900123'), '447700900123');
  for (const value of [null, undefined, '', 'bad', '123', '024123456', '+233123']) assert.throws(() => sms.normalizePhone(value), /phone/);
});
test('validates configuration and message before contacting the provider', async () => {
  let calls = 0; const post = async () => { calls++; return accepted(); };
  await assert.rejects(() => gateway(post, {})('0241234567', 'Message'), /key is missing/);
  await assert.rejects(() => gateway(post, { UMS_SMS_KEY: 'key', UMS_SENDERID: 'LongerThanEleven' })('0241234567', 'Message'), /11 characters/);
  await assert.rejects(() => gateway(post)('0241234567', '  '), /content/);
  assert.equal(calls, 0);
});
test('requires documented successful acceptance and uses timeouts without leaking provider payloads', async () => {
  let request;
  const sms = gateway(async (...args) => { request = args; return accepted(); });
  const result = await sms('+233241234567', 'Private message');
  assert.equal(result.accepted, true); assert.equal(result.campaignId, 'campaign');
  assert.equal(request[0], 'https://api.mnotify.com/api/sms/quick'); assert.equal(request[1].recipient[0], '0241234567');
  assert.equal(request[2].params.key, 'test-key'); assert.equal(request[2].timeout, 15000); assert.equal(request[2].maxRedirects, 0);
  assert.ok(!JSON.stringify(result).includes('Private message'));
  for (const data of [{ status: 'error', code: '1004', message: 'Insufficient balance' }, { status: 'success', code: '2000', summary: { total_sent: 0, total_rejected: 1 } }, { status: 'success' }]) {
    await assert.rejects(() => gateway(async () => ({ data }))('0241234567', 'Message'));
  }
});
test('provider HTTP errors and timeouts are failures with no API key or credential disclosure', async () => {
  for (const error of [{ response: { status: 401, data: { message: 'invalid API key test-secret' } } }, { message: 'Request timeout https://provider?key=test-secret private password', code: 'ECONNABORTED' }]) {
    let calls = 0; const sms = gateway(async () => { calls++; throw error; });
    const result = await sms.safe('0241234567', 'Private password');
    assert.equal(result.accepted, false); assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes('test-secret')); assert.ok(!JSON.stringify(result).includes('Private password'));
  }
});
test('bulk sends await completion, bound concurrency, deduplicate and count rejected/invalid recipients', async () => {
  let active = 0, peak = 0, calls = 0;
  const sms = gateway(async (_url, payload) => {
    active++; peak = Math.max(peak, active); calls++;
    await new Promise(resolve => setTimeout(resolve, 4)); active--;
    if (payload.recipient[0] === '0241234567') return { data: { status: 'error', message: 'Insufficient credit' } };
    return accepted();
  });
  const numbers = Array.from({ length: 12 }, (_, i) => '02010000' + String(i).padStart(2, '0'));
  const result = await sms.sendMany([...numbers, '0241234567', '+233241234567', null], 'Message');
  assert.equal(active, 0); assert.ok(peak <= 5); assert.equal(calls, 13);
  assert.equal(result.sent, 12); assert.equal(result.failed, 1); assert.equal(result.invalid, 1); assert.equal(result.duplicates, 1);
  assert.match(result.errors[0], /insufficient credit/);
});
test('circulars wait for SMS results and audit actual acceptance, including empty-content rejection', async () => {
  let finished = false, audit, body = 'Notice';
  const sms = gateway(async () => { await new Promise(resolve => setTimeout(resolve, 4)); finished = true; return accepted(); });
  const c = controller({ informer: { findUnique: async () => ({ id: 'notice', receiver: 'STUDENT', smsContent: body }) }, student: { findMany: async () => [{ phone: '0241234567' }, { phone: null }] }, log: { create: async ({ data }) => { audit = data; } } }, sms);
  const res = response(); await c.sendNotice({ body: { noticeId: 'notice' }, userId: 'staff' }, res);
  assert.equal(finished, true); assert.equal(res.body.sent, 1); assert.equal(res.body.invalid, 1); assert.equal(audit.meta.sent, 1);
  body = ''; const invalid = response(); await c.sendNotice({ body: { noticeId: 'notice' } }, invalid); assert.equal(invalid.code, 400);
});
test('registration reminders count provider refusals as failures', async () => {
  const sms = gateway(async () => ({ data: { status: 'error', message: 'Invalid API key' } }));
  let audit;
  const c = controller({ session: { findUnique: async () => ({ id: 'session', title: 'Semester' }) }, activityRegister: { findMany: async () => [] }, student: { findMany: async () => [{ phone: '0241234567' }] }, log: { create: async ({ data }) => { audit = data; } } }, sms);
  const res = response(); await c.sendRegistrationReminder({ params: { id: 'session' } }, res);
  assert.equal(res.body.sent, 0); assert.equal(res.body.failed, 1); assert.equal(audit.meta.sent, 0);
});
test('assessor and debtor notices select the appropriate recipients', async () => {
  let receiver = 'ASSESSOR', query;
  const c = controller({ informer: { findUnique: async () => ({ id: 'n', receiver, smsContent: 'Message' }) }, session: { findFirst: async () => ({ id: 'current' }) },
    sheet: { findMany: async args => { query = args; return [{ assignee: { phone: '0241234567' } }]; } }, student: { findMany: async args => { query = args; return []; } }, log: { create: async () => {} } }, gateway());
  await c.sendNotice({ body: { noticeId: 'n' } }, response()); assert.equal(query.where.sessionId, 'current'); assert.equal(query.select.assignee.select.phone, true);
  receiver = 'DEBTOR'; await c.sendNotice({ body: { noticeId: 'n' } }, response()); assert.equal(query.where.completeStatus, false); assert.equal(query.where.deferStatus, false); assert.equal(query.where.accountNet.gt, 0);
});
test('account reset succeeds independently of SMS and reports truthful audit metadata', async () => {
  let changed = false, audit;
  const c = controller({ staff: { findFirst: async () => ({ phone: '0241234567' }) }, user: { findFirst: async () => ({ id: 'u', username: 'staff' }), update: async () => { changed = true; } }, log: { create: async ({ data }) => { audit = data; } } }, gateway(async () => { throw new Error('offline'); }));
  const res = response(); await c.resetStaff({ body: { staffId: 'staff' } }, res);
  assert.equal(res.code, 200); assert.equal(changed, true); assert.equal(res.body.sms.accepted, false); assert.equal(audit.meta.smsSent, false);
  assert.ok(!JSON.stringify(audit).includes('password'));
});
test('frontend never shows a success toast for rejected or incomplete SMS batches', () => {
  const messages = [];
  const feedback = load('../frontend/src/utils/smsFeedback.ts', { 'react-hot-toast': { success: message => messages.push(['success', message]), error: message => messages.push(['error', message]) } });
  feedback.notifySmsSummary({ sent: 0, failed: 2, errors: ['No credit'] }); assert.equal(messages.at(-1)[0], 'error');
  feedback.notifySmsSummary({ sent: 2, failed: 1 }); assert.equal(messages.at(-1)[0], 'error');
  feedback.notifySmsSummary([{ accepted: true }, { accepted: false, message: 'Rejected' }]); assert.equal(messages.at(-1)[0], 'error');
  feedback.notifySmsSummary({ sent: 2, failed: 0 }); assert.equal(messages.at(-1)[0], 'success'); assert.match(messages.at(-1)[1], /accepted by the provider/);
  feedback.notifySmsSummary([{}, {}]); assert.equal(messages.at(-1)[0], 'error');
  assert.throws(() => feedback.notifySmsSummary({}), /No SMS submission result/);
});
test('password recovery matches normalized stored numbers and reports failed SMS after a completed reset', async () => {
  let changes = 0, audit;
  const sms = gateway(async () => { throw new Error('offline'); });
  const db = { user: { findFirst: async () => ({ tag: 'student', username: 'student', groupId: 1 }), updateMany: async () => { changes++; return { count: 1 }; } },
    student: { findFirst: async () => ({ id: 'student', phone: '+233 24 123 4567' }) }, log: { create: async ({ data }) => { audit = data; } } };
  const Auth = load('controller/authController.ts', { '../model/authModel': class {}, '../util/helper': {}, '../prisma/client': { prisma: db }, '../util/paramStr': { paramStr: x => x },
    '../util/password': { generateStrongPassword: () => 'secret-password', hashPassword: () => 'hash' }, '../config/sms': sms, '../config/gsuite': {}, nanoid: { customAlphabet: () => () => 'pin' } }).default;
  const c = new Auth();
  const wrong = response(); await c.forgetPassword({ body: { tag: 'student', phone: '0201234567' } }, wrong); assert.equal(changes, 0); assert.equal(wrong.code, 202);
  const res = response(); await c.forgetPassword({ body: { tag: 'student', phone: '0241234567' } }, res);
  assert.equal(changes, 1); assert.equal(res.code, 502); assert.equal(res.body.success, false); assert.match(res.body.message, /password was reset/); assert.equal(audit.meta.smsSent, false);
  assert.ok(!JSON.stringify(res.body).includes('secret-password')); assert.ok(!JSON.stringify(audit).includes('secret-password'));
});
test('student PIN sends require POST and an authorized staff role', () => {
  const routes = [];
  const router = Object.fromEntries(['use', 'get', 'post', 'delete', 'patch'].map(method => [method, (...args) => routes.push({ method, args })]));
  const verify = () => {};
  load('route/authRoute.ts', { express: { Router: () => router }, '../controller/authController': class {}, '../middleware/verifyToken': { verifyToken: verify }, '../middleware/rateLimitterFlexible': { loginLimiter: () => {} } });
  assert.equal(routes.filter(r => r.method === 'get' && r.args[0].startsWith('/pins/send')).length, 0);
  const send = routes.find(r => r.method === 'post' && r.args[0] === '/pins/send/:tag');
  assert.equal(send.args[1][0], verify);
  const gate = send.args[1][1];
  for (const [req, expected] of [[{ groupId: 1, roles: [{ app: 'ais', role: 'student::admin' }] }, 403], [{ groupId: 2, roles: [] }, 403], [{ groupId: 2, roles: [{ app: 'ais', role: 'student::registry' }] }, 200]]) {
    const res = response(); let allowed = false; gate(req, res, () => allowed = true); assert.equal(allowed ? 200 : res.code, expected);
  }
});

for (const kind of ['Student', 'Staff']) for (const operation of ['stage', 'reset']) for (const outcome of ['accepted', 'rejected', 'missing-phone']) {
  test(`${kind} ${operation}: ${outcome} SMS uses the saved username and password and preserves the account`, async () => {
    const person = { id: 'student', staffNo: 'staff', phone: outcome === 'missing-phone' ? null : '+233 55 864 1826', instituteEmail: kind === 'Staff' ? 'staff@college.example' : null };
    let account = operation === 'reset' ? { id: 'account', username: 'actual-login', tag: kind.toLowerCase() } : null;
    const audits = [], messages = [];
    const db = {
      student: { findFirst: async () => person }, staff: { findFirst: async () => person },
      user: { findFirst: async () => account, create: async ({ data }) => { account = { id: 'account', ...data }; return account; }, update: async ({ data }) => { account = { ...account, ...data }; return account; } },
      log: { create: async ({ data }) => { audits.push(data); } },
    };
    const sms = gateway(async (_url, payload) => { messages.push(payload); return outcome === 'rejected' ? { data: { status: 'error', message: 'Sender rejected' } } : accepted(); });
    const c = controller(db, sms), res = response();
    await c[operation + kind]({ body: kind === 'Student' ? { studentId: 'student' } : { staffId: 'staff' }, userId: 'admin' }, res);
    assert.equal(res.code, 200); assert.ok(account); assert.equal(res.body.sms.accepted, outcome === 'accepted');
    assert.equal(messages.length, outcome === 'missing-phone' ? 0 : 1);
    if (messages.length) {
      assert.equal(messages[0].recipient[0], '0558641826');
      assert.ok(messages[0].message.includes(account.username));
      assert.ok(messages[0].message.includes(account.password.slice('hashed:'.length)));
      assert.ok(!messages[0].message.includes('hashed:'));
    }
    assert.ok(!JSON.stringify(audits).includes('hashed:'));
    assert.ok(!JSON.stringify(res.body).includes('hashed:'));
    assert.equal(audits.at(-1).meta.sms.accepted, outcome === 'accepted');
  });
}
test('unknown or missing student IDs do not stage/reset an account; existing accounts are not staged twice', async () => {
  let writes = 0, sends = 0, person = null, account = null;
  const c = controller({ student: { findFirst: async () => person }, user: { findFirst: async () => account, create: async () => { writes++; return {}; }, update: async () => { writes++; return {}; } }, log: { create: async () => {} } }, gateway(async () => { sends++; return accepted(); }));
  for (const operation of ['stageStudent', 'resetStudent']) for (const body of [{}, { studentId: 'unknown' }]) {
    const res = response(); await c[operation]({ body }, res); assert.ok(res.code >= 400);
  }
  person = { id: 'student', phone: '0558641826' }; account = { id: 'existing' };
  const res = response(); await c.stageStudent({ body: { studentId: 'student' } }, res); assert.ok(res.code >= 400);
  assert.equal(writes, 0); assert.equal(sends, 0);
});

function paymentFixture({ outcome = 'accepted', fresher = false, amount = 500, missingStudent = false, failPayment = false } = {}) {
  const messages = [], audits = [];
  let transaction = null, created = 0;
  const student = { id: 'student', indexno: fresher ? null : 'INDEX-1', fname: 'Student', phone: outcome === 'missing-phone' ? null : '+233558641826', semesterNum: fresher ? 1 : 3, entrySemesterNum: 1, entryDate: new Date('2026-01-01'), entryGroup: 'GH', program: { prefix: 'AKA' } };
  const db = {
    transaction: { findFirst: async () => transaction, create: async ({ data }) => { if (failPayment) throw new Error('Database unavailable'); created++; transaction = { id: 'payment', ...data }; return transaction; } },
    student: { findFirst: async ({ where }) => where.OR ? (missingStudent ? null : student) : null, update: async ({ data }) => Object.assign(student, data) },
    studentAccount: { aggregate: async ({ where }) => ({ _sum: { amount: where.type === 'PAYMENT' ? -amount : 1000 - amount } }), findFirst: async () => ({ amount: 1000, bill: { quota: 50 } }) },
    transtype: { findUnique: async () => ({ amountInGhc: 100, amountInUsd: 10 }) },
    transwift: { upsert: async () => ({}) }, resit: { findMany: async () => [], updateMany: async () => ({ count: 0 }) }, $queryRaw: async () => [],
  };
  const sms = gateway(async (_url, payload) => { messages.push(payload); return outcome === 'rejected' ? { data: { status: 'error', message: 'Insufficient credit' } } : accepted(); });
  const C = load('controller/fmsController.ts', {
    '../prisma/client': { prisma: db }, '../config/sms': sms, '../util/helper': {}, '../util/billing': {}, '../util/paramStr': { paramStr: x => x },
    '../util/auditLog': { logRecords: async (...args) => { audits.push(args); }, pick: x => x, PAYMENT_FIELDS: [], BILL_FIELDS: [] },
  }).default;
  const c = new C();
  return { messages, audits, student, created: () => created, call: async (serviceId = 2) => {
    const res = response(); await c.payService({ collector: { id: 'collector', name: 'Bank' }, body: { studentId: 'student', serviceId, amountPaid: amount, transRef: 'BANK-TEST-REF' } }, res); return res;
  } };
}
test('every supported payment service sends one receipt, with document guidance where appropriate', async () => {
  for (const serviceId of [2, 3, 4, 5, 6, 8, 9, 10]) {
    const f = paymentFixture(), res = await f.call(serviceId);
    assert.equal(res.code, 200); assert.equal(res.body.success, true); assert.equal(res.body.sms.accepted, true);
    assert.equal(f.messages.length, 1); assert.match(f.messages[0].message, /GHC 500.00/); assert.match(f.messages[0].message, /BANK-TEST-REF/);
    assert.equal(f.messages[0].message.includes('document recipient'), [5, 6, 9, 10].includes(serviceId));
    assert.equal(f.audits.at(-1)[1], 'SMS_PAYMENT_RECEIPT'); assert.equal(f.audits.at(-1)[3][0].sms.accepted, true);
  }
});
test('payment SMS failure does not reject a saved payment, and repeated callbacks do not resend', async () => {
  for (const outcome of ['accepted', 'rejected', 'missing-phone']) {
    const f = paymentFixture({ outcome }), first = await f.call();
    assert.equal(first.body.success, true); assert.equal(first.body.sms.accepted, outcome === 'accepted');
    const count = f.messages.length, repeat = await f.call();
    assert.equal(repeat.body.success, true); assert.equal(f.created(), 1); assert.equal(f.messages.length, count);
    assert.equal(f.audits.at(-1)[3][0].sms.accepted, outcome === 'accepted');
  }
});
test('index notification is included in the receipt only after the percentage payment threshold', async () => {
  for (const amount of [499, 500]) {
    const f = paymentFixture({ fresher: true, amount }), res = await f.call();
    assert.equal(res.body.success, true); assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].message.includes('Your index number is'), amount === 500);
    assert.equal(!!f.student.indexno, amount === 500);
  }
});
test('rejected or unrecorded payments send no receipt', async () => {
  for (const options of [{ missingStudent: true }, { failPayment: true }, { amount: 0 }]) {
    const f = paymentFixture(options), res = await f.call(); assert.equal(res.body.success, false); assert.equal(f.messages.length, 0); assert.equal(f.created(), 0);
  }
});
