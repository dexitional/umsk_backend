// Run with Node 24: node --test scripts/test-sts.cjs. No database connections.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createRequire } = require('node:module');
const rules = require('../util/sts.ts');
const root = path.resolve(__dirname, '..');
const front = path.resolve(root, '../frontend');
const frontRequire = createRequire(path.join(front, 'package.json'));
const React = frontRequire('react');
const { renderToStaticMarkup } = frontRequire('react-dom/server');
function load(file, mocks = {}) {
  const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env', '({})');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console: { error() {} }, require: name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === 'react') return React;
    if (name.startsWith('.')) throw new Error(`Unmocked dependency ${name}`);
    return require(name);
  } }, { filename: file });
  return module.exports;
}
const response = () => ({ code: 200, headers: {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; }, setHeader(key, value) { this.headers[key] = value; } });
const admin = { groupId: 2, userId: 'staff-1', roles: [{ role: 'sts::admin' }] };
const mentor = { groupId: 2, userId: 'mentor-login', roles: [{ role: 'sts::mentor' }] };
const student = (sem = 1, total = 8) => ({ id: 'st1', indexno: 'IDX1', fname: 'Ama', lname: 'Mensah', semesterNum: sem, programId: 'p1',
  deferStatus: false, graduateStatus: false, completeStatus: false, program: { id: 'p1', longName: 'B.Ed', semesterTotal: total } });
const placement = { studentId: 'st1', sessionId: 'sem1', schoolId: 'school1', mentorId: 'mentor1', notes: 'Initial visit' };
function fixture(config = {}) {
  let state = { students: [student()], sessions: [{ id: 'sem1', default: true, status: true, semester: 'SEM1', title: '2026 Semester 1' }],
    schools: [{ id: 'school1', name: 'School One', active: true }, { id: 'school2', name: 'School Two', active: true }],
    mentors: [{ id: 'mentor1', schoolId: 'school1', name: 'Mentor One', active: true, accountTag: 'mentor-login' }, { id: 'mentor2', schoolId: 'school2', name: 'Mentor Two', active: true, accountTag: 'other-login' }],
    assignments: [], events: [], ...config };
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (key === 'mentor') return matches(state.mentors.find(m => m.id === row.mentorId) || {}, value);
    if (key === 'OR') return value.some(w => matches(row, w));
    if (value && typeof value === 'object' && 'contains' in value) return String(row[key] || '').includes(value.contains);
    return row[key] === value;
  });
  const detail = row => ({ ...row, session: state.sessions.find(s => s.id === row.sessionId), school: state.schools.find(s => s.id === row.schoolId), mentor: state.mentors.find(m => m.id === row.mentorId) });
  const tx = {
    $queryRaw: async () => [],
    student: { findUnique: async ({ where }) => state.students.find(s => matches(s, where)), findMany: async ({ where }) => state.students.filter(s => matches(s, where)) },
    session: { findUnique: async ({ where }) => state.sessions.find(s => matches(s, where)) },
    stsSchool: { findUnique: async ({ where }) => state.schools.find(s => matches(s, where)), delete: async ({ where }) => {
      if (state.mentors.some(m => m.schoolId === where.id) || state.assignments.some(a => a.schoolId === where.id)) throw { code: 'P2003' };
      return state.schools.find(s => matches(s, where));
    } },
    stsMentor: { findUnique: async ({ where, include }) => { const m = state.mentors.find(m => matches(m, where)); return m && include ? { ...m, _count: { assignments: state.assignments.filter(a => a.mentorId === m.id).length } } : m; },
      update: async ({ where, data }) => Object.assign(state.mentors.find(m => matches(m, where)), data),
      create: async ({ data }) => { const row = { id: 'new-mentor', ...data }; state.mentors.push(row); return row; } },
    user: { findUnique: async () => config.account ?? { groupId: 2, status: true } },
    stsAssignment: {
      create: async ({ data }) => {
        if (state.assignments.some(a => a.studentId === data.studentId && a.sessionId === data.sessionId)) throw { code: 'P2002' };
        const row = { id: 'a' + state.assignments.length, status: 'ACTIVE', version: 1, ...data }; state.assignments.push(row); return { ...row };
      },
      findFirst: async ({ where, include }) => { const row = state.assignments.find(a => matches(a, where)); return row && include?.events ? { ...row, events: state.events.filter(e => e.assignmentId === row.id) } : row && { ...row }; },
      findUniqueOrThrow: async ({ where }) => ({ ...state.assignments.find(a => matches(a, where)) }),
      updateMany: async ({ where, data }) => { const row = state.assignments.find(a => matches(a, where)); if (!row || config.conflict) return { count: 0 }; const version = row.version + 1; Object.assign(row, data, { version }); return { count: 1 }; },
      findMany: async ({ where, skip = 0, take = Infinity }) => state.assignments.filter(a => matches(a, where)).slice(skip, skip + take).map(detail),
      count: async ({ where }) => state.assignments.filter(a => matches(a, where)).length,
      groupBy: async ({ where }) => ['ACTIVE', 'COMPLETED', 'CANCELLED'].map(status => ({ status, _count: { _all: state.assignments.filter(a => matches(a, where) && a.status === status).length } })),
    },
    stsAssignmentEvent: { create: async ({ data }) => { if (config.failEvent) throw new Error('event write failed'); const event = { id: 'e' + state.events.length, ...data }; state.events.push(event); return event; } },
  };
  const db = { ...tx, $transaction: async work => { if (Array.isArray(work)) return Promise.all(work); const before = structuredClone(state); try { return await work(tx); } catch (error) { state = before; throw error; } } };
  const controller = new (load(path.join(root, 'controller/stsController.ts'), { '../prisma/client': { prisma: db }, '../util/sts': rules, '../util/auditLog': { logRecords: async () => {} } }).default)();
  const call = async (method, body = {}, extra = {}, identity = admin) => { const res = response(); await controller[method]({ ...identity, params: {}, query: {}, body, ...extra }, res); return res; };
  return { call, state: () => state, config };
}

test('eligibility covers every semester, Year 4 final-semester rule and invalid records', () => {
  for (let sem = 1; sem <= 7; sem++) assert.equal(rules.eligibility(student(sem)), null);
  assert.match(rules.eligibility(student(8)), /final/);
  assert.match(rules.eligibility(student(7, 7)), /final/);
  assert.equal(rules.eligibility(student(6, 6)), null); // Years 1–3 remain eligible each semester.
  assert.match(rules.eligibility(student(9, 10)), /Years 1 to 4/);
  for (const [key, value] of [['semesterNum', null], ['semesterNum', 0], ['semesterNum', 1.5], ['deferStatus', true], ['graduateStatus', true], ['completeStatus', true], ['program', null]]) {
    assert.ok(rules.eligibility({ ...student(), [key]: value }));
  }
});
test('school and mentor validation allow-list fields and reject malformed input', () => {
  assert.equal(rules.schoolData({ code: ' abc ', name: 'School', injected: true }).code, 'ABC');
  assert.equal(rules.schoolData({ code: 'abc', name: 'School', injected: true }).injected, undefined);
  for (const b of [{ code: '', name: 'School' }, { code: 'a', name: ' ' }, { code: 'a', name: 'School', active: 'false' }]) assert.throws(() => rules.schoolData(b));
  assert.throws(() => rules.mentorData({ schoolId: 's', name: 'Mentor', email: 'bad' }));
  assert.throws(() => rules.positiveInt('1.5', 'Version'));
});
test('assignment stores academic snapshots and an atomic creation event', async () => {
  const f = fixture(); const res = await f.call('createAssignment', placement);
  assert.equal(res.code, 201); assert.equal(res.body.yearGroup, 1); assert.equal(res.body.studentName, 'Ama Mensah');
  assert.equal(f.state().events[0].action, 'ASSIGNED');
  f.state().students[0].semesterNum = 3; f.state().schools[0].name = 'Renamed';
  assert.equal(f.state().assignments[0].semesterNum, 1); assert.equal(f.state().assignments[0].schoolName, 'School One');
});
test('duplicate requests cannot create two placements for the same semester', async () => {
  const f = fixture(); await f.call('createAssignment', placement);
  assert.equal((await f.call('createAssignment', placement)).code, 409);
  assert.equal(f.state().assignments.length, 1); assert.equal(f.state().events.length, 1);
});
test('each new semester permits a fresh independent placement for the same student', async () => {
  const f = fixture(); await f.call('createAssignment', placement);
  f.state().sessions[0].default = false;
  f.state().sessions.push({ id: 'sem2', semester: 'SEM2', default: true, status: true }); f.state().students[0].semesterNum = 2;
  assert.equal((await f.call('createAssignment', { ...placement, sessionId: 'sem2' })).code, 201);
  assert.equal(f.state().assignments.length, 2); assert.equal(f.state().assignments[0].semesterNum, 1);
});
test('rejects inactive/noncurrent semesters, parity mismatch, final semester and school/mentor mismatch', async () => {
  for (const mutate of [s => s.sessions[0].default = false, s => s.sessions[0].status = false, s => s.students[0].semesterNum = 2,
    s => { s.students[0].semesterNum = 8; s.sessions[0].semester = 'SEM2'; }, s => s.schools[0].active = false, s => s.mentors[0].active = false,
    s => s.mentors[0].schoolId = 'school2']) {
    const f = fixture(); mutate(f.state()); assert.equal((await f.call('createAssignment', placement)).code, 400);
    assert.equal(f.state().assignments.length, 0);
  }
});
test('event write failure rolls back the placement', async () => {
  const f = fixture({ failEvent: true }); assert.equal((await f.call('createAssignment', placement)).code, 500);
  assert.equal(f.state().assignments.length, 0);
});
test('reassignment requires a reason, retains prior snapshot and cannot change student/session', async () => {
  const f = fixture(); await f.call('createAssignment', placement);
  const data = { version: 1, schoolId: 'school2', mentorId: 'mentor2' };
  assert.equal((await f.call('updateAssignment', data, { params: { id: 'a0' } })).code, 400);
  const res = await f.call('updateAssignment', { ...data, reason: 'Mentor transfer', studentId: 'another', sessionId: 'another' }, { params: { id: 'a0' } });
  assert.equal(res.code, 200); assert.equal(res.body.studentId, 'st1'); assert.equal(res.body.sessionId, 'sem1');
  assert.equal(f.state().events[0].snapshot.schoolName, 'School One'); assert.equal(f.state().events[1].snapshot.schoolName, 'School Two');
  assert.equal(f.state().events[1].reason, 'Mentor transfer');
});
test('stale versions and write conflicts return 409 without adding history', async () => {
  const f = fixture(); await f.call('createAssignment', placement);
  assert.equal((await f.call('updateAssignment', { version: 2, notes: 'stale' }, { params: { id: 'a0' } })).code, 409);
  f.config.conflict = true;
  assert.equal((await f.call('updateAssignment', { version: 1, notes: 'conflict' }, { params: { id: 'a0' } })).code, 409);
  assert.equal(f.state().events.length, 1);
});
test('linked mentor may update own progress but cannot cancel, reassign or access other students', async () => {
  const f = fixture(); await f.call('createAssignment', placement);
  assert.equal((await f.call('updateAssignment', { version: 1, notes: 'Good progress', status: 'COMPLETED' }, { params: { id: 'a0' } }, mentor)).code, 200);
  for (const body of [{ status: 'CANCELLED', reason: 'test' }, { schoolId: 'school2', mentorId: 'mentor2', reason: 'test' }]) {
    assert.equal((await f.call('updateAssignment', { version: 2, ...body }, { params: { id: 'a0' } }, mentor)).code, 403);
  }
  assert.equal((await f.call('updateAssignment', { version: 2, notes: 'unauthorized' }, { params: { id: 'a0' } }, { ...mentor, userId: 'other-login' })).code, 404);
  assert.equal((await f.call('history', {}, { params: { id: 'a0' } }, { ...mentor, userId: 'other-login' })).code, 404);
});
test('mentor list/report filters cannot remove mentor scope; inactive mentors lose access', async () => {
  const f = fixture(); await f.call('createAssignment', placement);
  assert.equal((await f.call('assignments', {}, {}, mentor)).body.total, 1);
  assert.equal((await f.call('assignments', {}, { query: { mentorId: 'mentor1' } }, { ...mentor, userId: 'other-login' })).body.total, 0);
  f.state().mentors[0].active = false;
  assert.equal((await f.call('assignments', {}, {}, mentor)).body.total, 0);
});
test('cancellation is retained and restoring a final-semester student is rejected', async () => {
  const f = fixture(); await f.call('createAssignment', placement);
  assert.equal((await f.call('updateAssignment', { version: 1, status: 'CANCELLED' }, { params: { id: 'a0' } })).code, 400);
  assert.equal((await f.call('updateAssignment', { version: 1, status: 'CANCELLED', reason: 'Withdrawn' }, { params: { id: 'a0' } })).code, 200);
  assert.equal((await f.call('updateAssignment', { version: 2, status: 'ACTIVE' }, { params: { id: 'a0' } })).code, 400);
  f.state().students[0].semesterNum = 8;
  assert.equal((await f.call('updateAssignment', { ...placement, version: 2, reason: 'Restore' }, { params: { id: 'a0' } })).code, 400);
  assert.equal(f.state().assignments[0].status, 'CANCELLED'); assert.equal(f.state().events.length, 2);
});
test('school deletion and moving a mentor preserve referenced placement history', async () => {
  const f = fixture(); await f.call('createAssignment', placement);
  assert.equal((await f.call('deleteSchool', {}, { params: { id: 'school1' } })).code, 409);
  assert.equal((await f.call('saveMentor', { name: 'Mentor', schoolId: 'school2' }, { params: { id: 'mentor1' } })).code, 409);
});
test('mentor login links must reference active staff accounts', async () => {
  for (const account of [{ groupId: 1, status: true }, { groupId: 2, status: false }]) {
    const f = fixture({ account }); assert.equal((await f.call('saveMentor', { name: 'Mentor', schoolId: 'school1', accountTag: 'account' })).code, 400);
  }
});
test('student endpoint ignores supplied student filters and returns only own placements', async () => {
  const f = fixture(); await f.call('createAssignment', placement);
  assert.equal((await f.call('mine', {}, {}, { userId: 'st1', groupId: 1 })).body.length, 1);
  assert.equal((await f.call('mine', {}, { query: { studentId: 'st1' } }, { userId: 'st2', groupId: 1 })).body.length, 0);
  assert.equal((await f.call('mine')).code, 403);
});
test('CSV export uses filters, retains notes and protects spreadsheet formula cells', async () => {
  const f = fixture(); await f.call('createAssignment', { ...placement, notes: '=HYPERLINK("evil")' });
  const res = await f.call('report', {}, { query: { sessionId: 'sem1', yearGroup: '1' } });
  assert.equal(res.code, 200); assert.match(res.body, /Ama Mensah/); assert.match(res.body, /'=HYPERLINK/);
  assert.doesNotMatch((await f.call('report', {}, { query: { schoolId: 'school2' } })).body, /Ama Mensah/);
  for (const s of ['=1+1', '+123', '-1', '@SUM(1)', '  =1', '\tformula']) assert.ok(rules.csvCell(s).startsWith('"\''));
});
test('route middleware rejects student management and mentor school/assignment writes', async () => {
  const router = require('express').Router();
  const routes = [];
  const fakeRouter = { use: (...handlers) => routes.push({ path: '*', handlers }) };
  for (const method of ['get', 'post', 'patch', 'delete']) fakeRouter[method] = (path, ...handlers) => routes.push({ path, method, handlers });
  const Controller = function () {};
  for (const name of ['mine','options','candidates','saveSchool','deleteSchool','saveMentor','deleteMentor','assignments','history','createAssignment','updateAssignment','report']) Controller.prototype[name] = (req, res) => res.json({ reached: true });
  load(path.join(root, 'route/stsRoute.ts'), { express: { Router: () => fakeRouter }, '../controller/stsController': Controller,
    '../util/sts': rules, '../middleware/verifyToken': { verifyToken: (req,res,next) => next() },
    '../middleware/requireRole': load(path.join(root, 'middleware/requireRole.ts')) });
  const simulate = (method, path, identity) => { const res = response(); let stopped = false; for (const route of routes) {
    if (route.path !== '*' && (route.path !== path || route.method !== method)) continue;
    for (const handler of route.handlers) { let next = false; handler(identity, res, () => next = true); if (!next) { stopped = true; break; } }
    if (stopped) break;
  } return res; };
  assert.equal(simulate('post', '/schools', mentor).code, 403);
  assert.equal(simulate('post', '/assignments', mentor).code, 403);
  assert.equal(simulate('get', '/options', { ...admin, groupId: 1 }).code, 403);
  assert.equal(simulate('get', '/assignments', { ...mentor, userId: '' }).code, 401);
  assert.equal(simulate('get', '/options', { ...admin, roles: [] }).code, 403);
  assert.equal(simulate('post', '/schools', admin).body.reached, true);
});
test('frontend renders required mentor/school inputs, cancellation reason and semester guidance', () => {
  const forms = load(path.join(front, 'src/components/sts/STSForms.tsx'), { '../../utils/stsService': {}, '../../utils/requestError': {} });
  const props = { schools: [], busy: false, save() {}, cancel() {} };
  const schoolHtml = renderToStaticMarkup(React.createElement(forms.RecordForm, { ...props, type: 'schools' }));
  assert.match(schoolHtml, /name="code" required/); assert.match(schoolHtml, /name="name" required/);
  const cancelHtml = renderToStaticMarkup(React.createElement(forms.ProgressForm, { ...props, admin: true, record: { status: 'CANCELLED', studentName: 'Ama' } }));
  assert.match(cancelHtml, /Cancellation reason/); assert.match(cancelHtml, /required/);
  const placementHtml = renderToStaticMarkup(React.createElement(forms.PlacementForm, { ...props, options: { sessions: [], schools: [] } }));
  assert.match(placementHtml, /No active academic semester/); assert.match(placementHtml, /final programme semester/);
});
test('frontend service surfaces request failures as Error instances', async () => {
  const requests = load(path.join(front, 'src/utils/requestError.ts'));
  const service = load(path.join(front, 'src/utils/stsService.ts'), { './axios': { request: async () => { throw { response: { data: { message: 'Mentor does not belong to school.' } } }; } }, './requestError': requests }).stsService;
  await assert.rejects(service.save('assignments', placement), /Mentor does not belong to school/);
});
