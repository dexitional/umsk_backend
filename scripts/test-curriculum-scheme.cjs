// Node 24. Controller and frontend tests use fixtures, never the database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createRequire } = require('node:module');
const rules = require('../util/curriculumScheme.ts');
const root = path.resolve(__dirname, '..'), front = path.resolve(root, '../frontend');
const frontRequire = createRequire(path.join(front, 'package.json'));
const React = frontRequire('react');
const { renderToStaticMarkup } = frontRequire('react-dom/server');
function load(file, mocks) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console: { log() {}, error() {} }, require: name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('.')) throw new Error(`Unmocked dependency: ${name}`);
    return name === 'react' ? React : require(name);
  } }); return module.exports;
}
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const st = { id: 's', indexno: 'IDX', programId: 'p', majorId: null, semesterNum: 1, program: { hasMajor: false, schemeId: 'old-program' } };
const mount = (courseId, schemeId, extra = {}) => ({ id: courseId, courseId, schemeId, majorId: null, programId: 'p', semesterNum: 1, status: true, type: 'C', course: { title: courseId, creditHour: 3 }, ...extra });
function fixture(rows = [mount('C1', 'scheme-A'), mount('C2', 'scheme-B')]) {
  const writes = [];
  const db = { structure: { findMany: async ({ where }) => rows.filter(r => r.programId === where.programId && (!where.semesterNum || r.semesterNum === where.semesterNum) && r.status),
    create: async ({ data }) => { writes.push(data); return { id: 'new', ...data }; }, update: async ({ data }) => { writes.push(data); return { id: 'existing', ...data }; } },
    program: { create: async ({ data }) => { writes.push(data); return { id: 'p', ...data }; }, update: async ({ data }) => { writes.push(data); return data; } },
    scheme: { findUnique: async ({ where }) => where.id === 'missing' ? null : { id: where.id } },
    student: { findUnique: async () => st, findFirst: async () => st }, session: { findFirst: async () => ({ id: 'session', semester: 'SEM1' }) },
    structmeta: { findFirst: async () => null },
    assessment: { findFirst: async () => null, createMany: async ({ data }) => { writes.push(...data); return { count: data.length }; } },
    activityRegister: { findFirst: async () => null, createMany: async ({ data }) => { writes.push({ log: data }); } },
    resit: { findMany: async () => [{ courseId: 'R1', schemeId: 'original-resit', course: { title: 'Resit', creditHour: 2 } }] },
  };
  const mocks = { '../prisma/client': { prisma: db }, '../util/curriculumScheme': rules, '../util/paramStr': { paramStr: x => String(x) },
    '../util/helper': {}, '../prisma/auditAssessment': {}, '../util/pushBroadcast': {}, '../util/statutoryReport': {}, '../util/sheetScope': {},
    '../util/resitScope': {}, '../drizzle/schema': {}, '../util/password': {}, '../config/gsuite': {}, '../config/sms': {},
    nanoid: { customAlphabet: () => () => 'test' }, exceljs: {} };
  const controller = new (load(path.join(root, 'controller/aisController.ts'), mocks).default)();
  return { db, writes, controller, call: async (method, body, params = {}) => { const res = response(); await controller[method]({ body, params }, res); return res; } };
}
test('new registration uses each curriculum scheme, not programme or submitted values', async () => {
  const f = fixture();
  const rows = await rules.registrationCourses(f.db, st, [{ code: 'C1', schemeId: 'forged', credit: 99, indexno: 'other', sessionId: 'other' }, { code: 'C2' }], 'session');
  assert.deepEqual(rows.map(r => r.schemeId), ['scheme-A', 'scheme-B']);
  assert.equal(rows[0].indexno, 'IDX'); assert.equal(rows[0].credit, 3); assert.equal(rows[0].sessionId, 'session');
});
test('major-specific curriculum wins and another major cannot supply the scheme', () => {
  const rows = [mount('C1', 'generic'), mount('C1', 'major-A', { majorId: 'A' }), mount('C1', 'major-B', { majorId: 'B' })];
  assert.equal(rules.selectCurriculum(rows, 'C1', 'A').schemeId, 'major-A');
  assert.equal(rules.selectCurriculum(rows, 'C1', null).schemeId, 'generic');
  assert.throws(() => rules.selectCurriculum([rows[2]], 'C1', 'A'), /not in/);
});
test('missing schemes, conflicting duplicates and unmounted courses fail clearly', () => {
  assert.throws(() => rules.selectCurriculum([mount('C1', null)], 'C1'), /Select a grading scheme/);
  assert.throws(() => rules.selectCurriculum([mount('C1', 'A'), mount('C1', 'B')], 'C1'), /Conflicting/);
  assert.throws(() => rules.selectCurriculum([], 'C1'), /not in/);
});
test('registration semester/programme matching and duplicate submissions are enforced', async () => {
  const f = fixture([mount('C1', 'A', { semesterNum: 2 }), mount('C2', 'B', { programId: 'different' })]);
  await assert.rejects(rules.registrationCourses(f.db, st, [{ code: 'C1' }], 'session'), /not in/);
  await assert.rejects(rules.registrationCourses(f.db, st, [{ code: 'C2' }], 'session'), /not in/);
  const rows = await rules.registrationCourses(f.db, st, [{ code: 'C1', semesterNum: 2 }], 'historical', false);
  assert.equal(rows[0].schemeId, 'A');
  await assert.rejects(rules.registrationCourses(fixture().db, st, [{ code: 'C1' }, { code: 'C1' }], 'session'), /once/);
});
test('curriculum create/edit validates and saves the scheme relation', async () => {
  const f = fixture();
  for (const method of ['postCurriculum', 'updateCurriculum']) {
    const res = await f.call(method, { schemeId: 'scheme-B', programId: 'p', courseId: 'C1', semesterNum: 1 }, { id: 'c' });
    assert.equal(res.code, 200); assert.equal(f.writes.at(-1).scheme.connect.id, 'scheme-B');
    const missing = await f.call(method, { schemeId: 'missing' }, { id: 'c' }); assert.equal(missing.code, 400);
    assert.equal((await f.call(method, {}, { id: 'c' })).code, 400);
  }
});
test('programme saves cannot attach a scheme via legacy scalar or nested inputs', async () => {
  for (const method of ['postProgram', 'updateProgram']) {
    const f = fixture(); assert.equal((await f.call(method, { code: 'P', schemeId: 'A', scheme_id: 'B', scheme: { connect: { id: 'C' } } }, { id: 'p' })).code, 200);
    assert.deepEqual(Object.keys(f.writes[0]), ['code']);
  }
});
test('registration mounts expose curriculum schemes and retain the original resit scheme', async () => {
  const res = await fixture().call('fetchRegistrationMount', {}, { indexno: 's' });
  assert.equal(res.code, 200);
  assert.deepEqual(Array.from(res.body.courses, r => r.schemeId), ['scheme-A', 'scheme-B', 'original-resit']);
});
test('registration controller ignores forged scheme and logs canonical values', async () => {
  const f = fixture(); const res = await f.call('postRegistration', [{ code: 'C1', indexno: 'IDX', schemeId: 'forged', credit: 88, semesterNum: 9, sessionId: 'wrong' }]);
  assert.equal(res.code, 200); const saved = f.writes.find(w => w.courseId === 'C1');
  assert.equal(saved.schemeId, 'scheme-A'); assert.equal(saved.semesterNum, 1);
  assert.equal(f.writes.find(w => w.log).log[0].dump[0].schemeId, 'scheme-A');
});
test('registration controller validates every scheme before any writes', async () => {
  const f = fixture([mount('C1', null)]);
  const res = await f.call('postRegistration', [{ code: 'C1', indexno: 'IDX' }]);
  assert.equal(res.code, 400); assert.match(res.body.message, /grading scheme/); assert.equal(f.writes.length, 0);
});
test('graduation classification reads curriculum and rejects conflicting award bands', async () => {
  const classMeta = [{ min: 3.5, title: 'First' }];
  const db = { structure: { findMany: async () => [{ scheme: { classMeta } }, { scheme: { classMeta: [{ title: 'First', min: 3.5 }] } }] } };
  assert.deepEqual(await rules.curriculumClassMeta(db, st), classMeta);
  db.structure.findMany = async () => [{ scheme: { classMeta } }, { scheme: { classMeta: [{ min: 3, title: 'Other' }] } }];
  await assert.rejects(rules.curriculumClassMeta(db, st), /conflicting award/);
  db.structure.findMany = async () => [{ scheme: null }];
  await assert.rejects(rules.curriculumClassMeta(db, st), /missing/);
});
function frontend(file, service = {}, data = {}) {
  return load(path.join(front, 'src/pages/ais', file), { '../../utils/aisService': service, '../../utils/requestError': { requestError: e => e.message }, '../../components/ais/SubPageTitle': () => null,
    'react-router-dom': { Form: props => React.createElement('form', props), useLoaderData: () => data, useActionData: () => null,
      useNavigate: () => () => {}, useNavigation: () => ({}), redirect: path => ({ path }) } });
}
test('scheme selector is required on curriculum, absent from programme; curriculum loads current inactive scheme', async () => {
  const curriculum = frontend('PgAISStructureForm.tsx', { fetchDepartments: async () => [], fetchProgramList: async () => [], fetchMajorList: async () => [], fetchCourseList: async () => [], fetchSchemeList: async () => [], fetchCurriculum: async () => ({ id: 'c', scheme: { id: 'old', title: 'Legacy' } }) }, { data: {}, schemes: [{ id: 'a', title: 'Grade A' }] });
  const html = renderToStaticMarkup(React.createElement(curriculum.default));
  assert.match(html, /name="schemeId"[^>]*required/);
  const opts = await curriculum.loader({ params: { curriculumId: 'c' } }); assert.equal(opts.schemes[0].id, 'old');
  const program = frontend('PgAISProgramForm.tsx', {}, { data: {} });
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(program.default)), /name="schemeId"/);
});
test('curriculum form retains input and returns the backend error instead of redirecting', async () => {
  const page = frontend('PgAISStructureForm.tsx', { postCurriculum: async () => { throw new Error('Select a grading scheme.'); } });
  const result = await page.action({ params: {}, request: { formData: async () => new Map([['schemeId', ''], ['semesterNum', '1']]) } });
  assert.equal(result.error, 'Select a grading scheme.');
});
test('a registered student can still view the slip after the current curriculum changes', async () => {
  const file = path.join(front, 'src/pages/aisp/PgAISPRegistrations.tsx');
  const page = load(file, { '../../utils/aisService': { fetchRegistration: async () => [{ session: { title: 'Saved semester' } }],
    fetchRegistrationMount: async () => { throw new Error('Current curriculum scheme is missing'); }, fetchStudent: async () => ({}), fetchStudentFinance: async () => [] },
    '../../utils/authService': { useUserStore: { getState: () => ({ user: { user: { tag: 'student' } } }) } },
    '../../components/aisp/AISPPageHeader': () => null, '../../components/aisp/RegistrationListView': () => null, '../../components/aisp/RegistrationSlipView': () => null,
    'react-router-dom': {}, 'react-hot-toast': () => {}, 'react-icons/hi2': {} });
  const result = await page.loader(); assert.equal(result.slip.length, 1); assert.equal(result.data.session, 'Saved semester');
});
