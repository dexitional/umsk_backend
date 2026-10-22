// Node 24: node --test scripts/test-system-updates.cjs
// Controller tests use an isolated in-memory transaction fixture, never a live database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const billing = require('../util/billing.ts');
const front = path.resolve(__dirname, '../../frontend');
const frontRequire = createRequire(path.join(front, 'package.json'));
const React = frontRequire('react');
const { renderToStaticMarkup } = frontRequire('react-dom/server');

function load(file, mocks = {}, frontend = false) {
  const filename = path.resolve(frontend ? front : path.join(__dirname, '..'), file);
  const source = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, console: { log() {}, error() {} }, require: name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === 'react') return React;
    if (/\.(webp|png|jpg|css)$/.test(name)) return 'asset';
    if (name.startsWith('.')) throw new Error(`Unmocked dependency ${name}`);
    return (frontend ? frontRequire : require)(name);
  } }, { filename });
  return module.exports;
}

const bill = (extra = {}) => ({ id: 'b1', narrative: 'Tuition', programId: 'p1', sessionId: 's1', bankaccId: 'bank',
  type: 'GH', currency: 'GHC', amount: 1000, discount: 100, quota: 50, mainGroupCode: '1011', discountGroupCode: '0010',
  posted: false, status: true, includeStudentIds: [], excludeStudentIds: [], ...extra });
const student = (id, semesterNum, extra = {}) => ({ id, indexno: `IDX-${id}`, semesterNum, programId: 'p1', entryGroup: 'GH',
  deferStatus: false, completeStatus: false, entryDate: new Date('2024-01-01'), accountNet: 0, ...extra });
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });

function fixture(initialBill = bill(), students = [], entries = [], failInsert = false) {
  let state = { bill: initialBill, students, entries, activity: [] };
  const matches = (s, where) => where.OR ? where.OR.some(r => Object.entries(r).every(([key, value]) =>
    typeof value === 'object' ? value.in.includes(s[key]) : s[key] === value)) : Object.entries(where).every(([key, value]) =>
    typeof value === 'object' ? value.in.includes(s[key]) : s[key] === value);
  const ledgerMatches = (entry, where) => Object.entries(where).every(([key, value]) => entry[key] === value);
  const tx = {
    $queryRaw: async () => [],
    bill: {
      findUnique: async () => state.bill,
      updateMany: async ({ where, data }) => {
        if (!state.bill || state.bill.id !== where.id || state.bill.posted !== where.posted) return { count: 0 };
        Object.assign(state.bill, data); return { count: 1 };
      },
      update: async ({ data }) => Object.assign(state.bill, data),
    },
    student: {
      findMany: async ({ where }) => state.students.filter(s => matches(s, where)),
      findUnique: async ({ where }) => state.students.find(s => s.id === where.id),
      groupBy: async () => state.students.map(s => ({ instituteAffliate: s.instituteAffliate })),
      update: async ({ where, data }) => Object.assign(state.students.find(s => s.id === where.id), data),
    },
    studentAccount: {
      findMany: async ({ where, include }) => state.entries.filter(e => ledgerMatches(e, where)).map(e => include?.student ? { ...e, student: state.students.find(s => s.id === e.studentId) } : e),
      findFirst: async ({ where }) => state.entries.find(e => ledgerMatches(e, where)),
      createMany: async ({ data }) => { if (failInsert) throw new Error('Database offline'); state.entries.push(...data); return { count: data.length }; },
      create: async ({ data }) => { state.entries.push(data); return data; },
      deleteMany: async ({ where }) => { state.entries = state.entries.filter(e => !ledgerMatches(e, where)); },
      aggregate: async ({ where }) => ({ _sum: { amount: state.entries.filter(e => ledgerMatches(e, where)).reduce((sum, e) => sum + e.amount, 0) } }),
    },
    activityBill: { create: async ({ data }) => { state.activity.push(data); } },
    log: { create: async () => ({}) },
  };
  const db = { bill: tx.bill, studentAccount: tx.studentAccount, $transaction: async (fn) => {
    const before = structuredClone(state);
    try { return await fn(tx); } catch (error) { state = before; throw error; }
  } };
  const mocks = {
    '../prisma/client': { prisma: db }, '../config/sms': () => {},
    '../util/billing': billing, '../util/helper': { friendlyDbError: () => 'Please try again.' },
    '../util/paramStr': { paramStr: value => String(value) },
    '../util/auditLog': { logRecords: async () => {}, pick: x => x, diff: () => ({}), BILL_FIELDS: [] },
  };
  const controller = new (load('controller/fmsController.ts', mocks).default)();
  return { controller, db, tx, state: () => state, mocks };
}

test('all 15 year combinations target both semesters and all four years', () => {
  for (let n = 1; n < 16; n++) {
    const code = n.toString(2).padStart(4, '0');
    for (let sem = 1; sem <= 8; sem++) {
      const expected = code[Math.ceil(sem / 2) - 1] === '1';
      assert.equal(billing.targetSemesters(code).includes(sem), expected);
      assert.equal(billing.codesForSemester(sem).includes(code), expected);
    }
  }
  assert.deepEqual(billing.codesForSemester(0), []);
});

test('rejects malformed target codes, unsafe amounts, invalid discounts and categories', () => {
  for (const extra of [{ mainGroupCode: '0000' }, { mainGroupCode: '10000' }, { amount: NaN }, { amount: -1 },
    { discount: 1001 }, { quota: 101 }, { type: 'OTHER' }, { discountGroupCode: '0100' }]) {
    assert.throws(() => billing.validateBill(bill(extra)), billing.BillingError);
  }
  const valid = billing.validateBill(bill({ posted: true, includeStudentIds: ['bad'], discount: '', quota: '' }));
  assert.equal(valid.discount, 0);
  assert.equal(valid.quota, null);
  assert.equal(valid.posted, undefined);
});

test('publication selects the correct year groups, honours exceptions and discounts, and does not duplicate existing charges', async () => {
  const students = Array.from({ length: 8 }, (_, i) => student(`s${i + 1}`, i + 1));
  students.push(student('deferred', 1, { deferStatus: true }), student('complete', 1, { completeStatus: true }),
    student('other-program', 1, { programId: 'other' }), student('international', 1, { entryGroup: 'INT' }));
  const app = fixture(bill({ includeStudentIds: ['IDX-s3'], excludeStudentIds: ['IDX-s7'] }), students,
    [{ billId: 'b1', studentId: 's1', amount: 1000 }]);
  const res = response(); await app.controller.activateBill({ params: { id: 'b1' } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(app.state().entries.map(r => r.studentId).sort(), ['s1', 's2', 's3', 's5', 's6', 's8']);
  assert.equal(app.state().entries.find(r => r.studentId === 's5').amount, 900);
  assert.equal(app.state().students.find(r => r.id === 's6').accountNet, 900);
  const again = response(); await app.controller.activateBill({ params: { id: 'b1' } }, again);
  assert.equal(again.code, 409); assert.equal(app.state().entries.length, 6);
});

test('publication rolls back on no matching recipients, invalid exceptions or ledger failure', async () => {
  for (const app of [fixture(bill(), []), fixture(bill({ includeStudentIds: ['missing'] }), [student('s1', 1)]),
    fixture(bill(), [student('s1', 1)], [], true)]) {
    const res = response(); await app.controller.activateBill({ params: { id: 'b1' } }, res);
    assert.ok(res.code >= 400); assert.equal(app.state().bill.posted, false);
    assert.equal(app.state().entries.length, 0); assert.equal(app.state().activity.length, 0);
  }
});

test('draft inclusion resolves index numbers without charging before publication; removal persists as an exclusion', async () => {
  const app = fixture(bill(), [student('s1', 1)]);
  const req = { params: { id: 'b1' }, body: { tag: 'IDX-s1', action: 'create' } };
  const res = response(); await app.controller.includeBill(req, res);
  assert.equal(res.code, 200); assert.equal(app.state().entries.length, 0);
  assert.ok(app.state().bill.includeStudentIds.includes('s1'));
  await app.controller.activateBill(req, response()); assert.equal(app.state().entries.length, 1);
  await app.controller.includeBill({ ...req, body: { ...req.body, action: 'remove' } }, response());
  assert.equal(app.state().entries.length, 0);
  assert.ok(app.state().bill.excludeStudentIds.includes('s1'));
  assert.equal(app.state().students[0].accountNet, 0);
});

test('receivers return an empty list for a real empty bill, and a distinct missing-bill error', async () => {
  for (const [existing, status] of [[bill(), 200], [null, 404]]) {
    const app = fixture(existing); const res = response();
    await app.controller.billReceivers({ params: { id: 'b1' } }, res);
    assert.equal(res.code, status);
    if (status === 200) assert.deepEqual(res.body, []);
  }
});

test('revocation removes charges and restores balances, including bills without receivers', async () => {
  const app = fixture(bill({ posted: true }), [student('s1', 1, { accountNet: 950 })],
    [{ billId: 'b1', studentId: 's1', amount: 1000 }, { billId: null, studentId: 's1', amount: -50 }]);
  const res = response(); await app.controller.revokeBill({ params: { id: 'b1' } }, res);
  assert.equal(res.code, 200); assert.equal(app.state().bill.posted, false);
  assert.equal(app.state().students[0].accountNet, -50);
  const empty = response(); await app.controller.revokeBill({ params: { id: 'b1' } }, empty);
  assert.equal(empty.code, 200);
});

test('students must confirm their hall even when keeping the imported value, and cannot change it again', async () => {
  const app = fixture(bill(), [student('s1', 1, { instituteAffliate: 'Alpha', affiliateEditedAt: null })]);
  const mocks = { ...app.mocks, '../util/curriculumScheme': require('../util/curriculumScheme.ts'), '../prisma/auditAssessment': {}, '../util/pushBroadcast': {}, '../util/statutoryReport': {},
    '../util/sheetScope': {}, '../util/resitScope': {}, '../drizzle/schema': {}, '../util/password': {}, '../config/gsuite': {},
    nanoid: { customAlphabet: () => () => 'fixture' }, exceljs: {} };
  const controller = new (load('controller/aisController.ts', mocks).default)();
  const request = body => ({ params: { id: 's1' }, groupId: 1, userId: 's1', body });
  const missing = response(); await controller.updateStudent(request({ phone: '123' }), missing);
  assert.equal(missing.code, 400);
  const unknown = response(); await controller.updateStudent(request({ instituteAffliate: 'Unknown Hall' }), unknown);
  assert.equal(unknown.code, 400); assert.equal(app.state().students[0].affiliateEditedAt, null);
  const confirmed = response(); await controller.updateStudent(request({ instituteAffliate: 'Alpha' }), confirmed);
  assert.equal(confirmed.code, 200); assert.ok(app.state().students[0].affiliateEditedAt);
  const changed = response(); await controller.updateStudent(request({ instituteAffliate: 'Beta' }), changed);
  assert.equal(changed.code, 400); assert.equal(app.state().students[0].instituteAffliate, 'Alpha');
  const contact = response(); await controller.updateStudent(request({ phone: '456' }), contact);
  assert.equal(contact.code, 200);
});

test('frontend billing service throws the actual message instead of treating it as a constructor', async () => {
  let result = { status: 202, data: { message: 'Cannot load receivers' } };
  const service = load('src/utils/fmsService.ts', { './axios': { get: async () => result }, 'react-hot-toast': {},
    './authService': { useUserStore: { getState: () => ({ isAuthenticated: () => true }) } } }, true).default;
  await assert.rejects(() => service.billReceivers('b1'), /Cannot load receivers/);
  result = { status: 200, data: [] }; assert.deepEqual(await service.billReceivers('b1'), []);
  result = { status: 204 }; assert.equal((await service.billReceivers('b1')).length, 0);
});

test('registration print routes render the college letterhead in print mode', () => {
  const Header = load('src/components/print/PrintHeaderAucc.tsx', {}, true).default;
  for (const pathname of ['/print/registration', '/print/registration/s1']) {
    const View = load('src/components/print/PrintHeader.tsx', { './PrintHeaderAucc': Header, './PrintNoHeader': () => 'NO LETTERHEAD',
      'react-router': { useLocation: () => ({ pathname }) } }, true).default;
    const html = renderToStaticMarkup(React.createElement(View));
    assert.match(html, /Akatsi College of Education/); assert.doesNotMatch(html, /NO LETTERHEAD|print:hidden/);
    assert.match(html, /print:block/);
  }
});

test('student ID card back uses College and the supplied telephone number', () => {
  const { IDCardBack } = load('src/components/ais/AISIDCard.tsx', { html2canvas: {}, jspdf: {} }, true);
  const html = renderToStaticMarkup(React.createElement(IDCardBack, { data: {} }));
  assert.match(html, /registered student of the College/); assert.match(html, /\+233 20 361 7239/);
  assert.doesNotMatch(html, /University|25 675 4949|24 538 3769/i);
});

test('hall prompt persists until confirmation and then stops', () => {
  const { needsHallConfirmation, hallConfirmationPath } = load('src/utils/studentHall.ts', {}, true);
  assert.equal(needsHallConfirmation({ id: 's1', instituteAffliate: 'Alpha' }), true);
  assert.equal(needsHallConfirmation({ id: 's1', affiliateEditedAt: '2026-10-21' }), false);
  assert.equal(hallConfirmationPath({ id: 's1' }), '/aisp/profile/s1/edit');
});

test('bill form errors stay on the form and receiver failures offer a retry instead of an empty-state message', async () => {
  const failure = { response: { data: { message: 'Select a valid target year.' } } };
  const errors = load('src/utils/requestError.ts', {}, true);
  const form = load('src/pages/fms/PgFMSBillForm.tsx', {
    '../../utils/requestError': errors, '../../utils/aisService': {},
    '../../utils/fmsService': { postBill: async () => { throw failure; } },
    '../../components/ais/SubPageTitle': () => null, '../../components/fms/YearGroupCodeField': () => null,
    'react-router-dom': { redirect: () => { throw new Error('Must not redirect on failure'); } },
  }, true);
  const result = await form.action({ params: {}, request: { formData: async () => new Map([['amount', '100'], ['discount', ''], ['quota', '']]) } });
  assert.equal(result.error, failure.response.data.message);
  let resultData;
  const receivers = load('src/pages/fms/PgFMSBillReceiver.tsx', {
    '../../utils/requestError': errors, '../../utils/fmsService': { billReceivers: async () => { throw failure; } },
    '../../components/ais/AISStudentCard': () => null,
    'react-router-dom': { useLoaderData: () => resultData, useRevalidator: () => ({ state: 'idle', revalidate: () => {} }) },
  }, true);
  resultData = await receivers.loader({ params: { billId: 'b1' } });
  const html = renderToStaticMarkup(React.createElement(receivers.default));
  assert.match(html, /Select a valid target year/); assert.match(html, /Retry/); assert.doesNotMatch(html, /No Receivers/);
});

test('a published bill cannot be edited into a different target group', async () => {
  const app = fixture(bill({ posted: true }));
  const res = response();
  await app.controller.updateBill({ params: { id: 'b1' }, body: bill({ mainGroupCode: '1111' }) }, res);
  assert.equal(res.code, 409); assert.equal(app.state().bill.mainGroupCode, '1011');
});
