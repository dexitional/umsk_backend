// Node 24: node --test scripts/test-residence.cjs (no database writes).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createRequire } = require('node:module');
const rules = require('../util/residence.ts');
const root = path.resolve(__dirname, '..');
const front = path.resolve(root, '../frontend');
const frontendRequire = createRequire(path.join(front, 'package.json'));
const React = frontendRequire('react');
const { renderToStaticMarkup } = frontendRequire('react-dom/server');
function load(file, mocks = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8').replaceAll('import.meta.env', '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, setTimeout, require: id => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id === 'react') return React;
    if (id.startsWith('react-icons/')) return frontendRequire(id);
    if (id === '../management/ManagementUI') return load(path.join(front, 'src/components/management/ManagementUI.tsx'));
    if (id.startsWith('.')) throw new Error('Unmocked module: ' + id);
    return require(id);
  } }); return module.exports;
}
test('academic-year keys normalize spacing and separators but reject ambiguous values', () => {
  for (const year of ['2026/2027', '2026 / 2027', '2026-2027']) assert.equal(rules.academicYear({ year }), '2026/2027');
  for (const year of [null, '', '2026', '2026/28', '2026/2028', '2026/2026']) assert.throws(() => rules.academicYear({ year }));
});
test('gender and room capacity inputs reject unknown or fractional values', () => {
  assert.equal(rules.genderOf('male'), 'M'); assert.equal(rules.genderOf(' F '), 'F');
  assert.equal(rules.genderOf('unknown'), null);
  for (const value of [0, -1, 1.5, NaN, '2 beds', '', true]) assert.throws(() => rules.positive(value, 'Capacity'));
  assert.equal(rules.positive('4', 'Capacity'), 4);
});
test('all student years can be assigned in semester one, with invalid and inactive students excluded', () => {
  for (const sem of [1,3,5,7,9]) assert.doesNotThrow(() => rules.checkAssignmentStudent({ semesterNum: sem, gender: 'M' }));
  for (const sem of [0,2,4,6,8,null,1.5]) assert.throws(() => rules.checkAssignmentStudent({ semesterNum: sem, gender: 'M' }));
  for (const field of ['deferStatus', 'completeStatus', 'graduateStatus']) assert.throws(() => rules.checkAssignmentStudent({ semesterNum: 1, gender: 'M', [field]: true }));
});
test('admission/import affiliation sets both halls once and rejects unregistered hall names', async () => {
  const writes = [], events = [];
  const tx = { $queryRaw: async () => [{ id: 'alpha', name: 'Alpha', gender: 'M', active: true }], residenceHall: { findUnique: async ({ where }) => where.name === 'Alpha' ? { id: 'alpha', name: 'Alpha', gender: 'M', active: true } : null },
    student: { update: async args => { writes.push(args); return args.data; } }, hallAffiliationEvent: { create: async args => events.push(args.data) } };
  const original = { id: 'fresher', gender: 'M', semesterNum: 1, instituteAffliate: 'Alpha' };
  const result = await rules.recordAdmissionHall(tx, original, 'admissions');
  assert.equal(result.originalHallId, 'alpha'); assert.equal(result.currentHallId, 'alpha'); assert.equal(result.originalHallSource, 'ADMISSION');
  assert.equal(events[0].action, 'ORIGINAL_RECORDED');
  await assert.rejects(rules.recordAdmissionHall(tx, { ...original, instituteAffliate: 'Unknown' }, 'admissions'), /not active/);
  await assert.rejects(rules.initialAffiliation(tx, { ...original, originalHallId: 'old' }, { id: 'alpha', active: true }, 'admissions', 'ADMISSION'), /cannot be replaced/);
  assert.equal(writes.length, 1);
});
test('room routes enforce staff roles and authenticated identity before writes', () => {
  const routes = []; const router = { use: (...handlers) => routes.push({ path: '*', handlers }) };
  for (const method of ['get','post','patch','delete']) router[method] = (path, ...handlers) => routes.push({ path, method, handlers });
  const Controller = function () {};
  for (const name of ['mine','options','candidates','recordOriginal','history','saveHall','saveRoom','deleteHall','deleteRoom','assignments','assign','release','occupancy','report']) Controller.prototype[name] = (_req,res) => res.json({ reached: true });
  load(path.join(root,'route/residenceRoute.ts'), { express: { Router: () => router }, '../controller/residenceController': Controller,
    '../util/residence': rules, '../middleware/verifyToken': { verifyToken: (_req,_res,next) => next() },
    '../middleware/requireRole': load(path.join(root,'middleware/requireRole.ts')) });
  function simulate(identity, endpoint = '/assignments') {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    for (const route of routes) {
      if (route.path !== '*' && !(route.path === endpoint && route.method === 'post')) continue;
      for (const handler of route.handlers) { let continued = false; handler(identity,res,() => continued = true); if (!continued) return res; }
    } return res;
  }
  for (const groupId of [1,3]) assert.equal(simulate({ groupId, userId: 'student', roles: [{ role: 'hall::admin' }] }).code, 403);
  assert.equal(simulate({ groupId: 2, userId: '', roles: [{ role: 'hall::admin' }] }).code, 401);
  assert.equal(simulate({ groupId: 2, userId: 'staff', roles: [] }).code, 403);
  for (const role of rules.HALL_ROLES) assert.equal(simulate({ groupId: 2, userId: 'staff', roles: [{ role }] }).body.reached, true);
});
test('hall forms expose capacity/gender requirements and permanent original affiliation guidance', () => {
  const forms = load(path.join(front,'src/components/residence/HallForms.tsx'), { '../../utils/residenceService': { hallMatchesStudent: () => false }, '../../utils/requestError': {} });
  const html = renderToStaticMarkup(React.createElement(forms.RecordForm, { type: 'rooms', options: { halls: [] }, save() {}, cancel() {} }));
  assert.match(html, /name="capacity" min="1" max="10000" step="1" required/); assert.match(html, /Gender \(from hall\)/); assert.match(html, /readonly=""/); assert.match(html, /name="hallId" required/);
  const original = renderToStaticMarkup(React.createElement(forms.OriginalForm, { student: { id: 's1' }, halls: [], save() {} }));
  assert.match(original, /later transfers change only the current hall/); assert.match(original, /name="reason" maxLength="1000" required/);
});
test('student hall card distinguishes original/current halls, assigned/released rooms and request failures', () => {
  const Card = load(path.join(front,'src/components/aisp/AISPHallCard.tsx'), { 'react-router-dom': { useRevalidator: () => ({ state: 'idle', revalidate() {} }) } }).default;
  const render = data => renderToStaticMarkup(React.createElement(Card,{ data }));
  assert.match(render(null), /could not be loaded/); assert.doesNotMatch(render(null), /No room has been assigned/);
  const data = { student: { instituteAffliate: 'Original Alpha', currentHall: { name: 'Current Beta' } }, session: { title: 'Semester two' }, academicYear: '2026/2027' };
  assert.match(render(data), /No room has been assigned/);
  const assigned = render({ ...data, placement: { status: 'ACTIVE', hallName: 'Current Beta', roomCode: 'B12' } });
  for (const value of ['Original Alpha','Current Beta','Room B12','2026/2027']) assert.ok(assigned.includes(value));
  assert.match(render({ ...data, placement: { status: 'RELEASED' } }), /placement has been released/);
});
test('residence service turns server errors into readable Error instances', async () => {
  const errors = load(path.join(front,'src/utils/requestError.ts'));
  const service = load(path.join(front,'src/utils/residenceService.ts'), { './axios': { request: async () => { throw { response: { data: { message: 'Room is full.' } } }; } }, './requestError': errors }).residenceService;
  await assert.rejects(service.save('assignments', {}), /Room is full/);
});

test('student profile loads and renders read-only annual room and current-semester STS school', async () => {
  const residence = { student: { instituteAffliate: 'Original Hall', currentHall: { name: 'Current Hall' } }, session: { title: 'Second Semester' }, academicYear: '2026/2027', placement: { status: 'ACTIVE', hallName: 'Current Hall', roomCode: 'B12' } };
  const sts = { session: { id: 'semester-two', title: 'Second Semester' }, placement: { schoolName: 'Assigned Practice School', mentorName: 'Mentor Ama', status: 'ACTIVE' } };
  let loaderData;
  const router = { useRevalidator: () => ({ state: 'idle', revalidate() {} }), useLoaderData: () => loaderData,
    Link: ({ children, to }) => React.createElement('a', { href: to }, children) };
  const HallCard = load(path.join(front, 'src/components/aisp/AISPHallCard.tsx'), { 'react-router-dom': router }).default;
  const STSCard = load(path.join(front, 'src/components/aisp/AISPSTSCard.tsx'), { 'react-router-dom': router }).default;
  let failHall = false, failSTS = false;
  const view = load(path.join(front, 'src/pages/aisp/PgAISPProfile.tsx'), {
    'react-router-dom': router, 'react-icons/hi2': frontendRequire('react-icons/hi2'),
    '../../components/aisp/AISPHallCard': HallCard, '../../components/aisp/AISPSTSCard': STSCard,
    '../../components/aisp/AISPPanel': ({ children }) => React.createElement('section', null, children),
    '../../components/aisp/AISPInfoTile': ({ label, value }) => React.createElement('div', null, label, ': ', value),
    '../../components/aisp/AISPPhotoBlend': { AISPCrest: () => null, AISPPhotoBlend: () => null },
    '../../utils/authService': { useUserStore: { getState: () => ({ user: { user: { tag: 'own-student' } } }) } },
    '../../utils/aisService': { fetchStudent: async id => { assert.equal(id, 'own-student'); return { id, fname: 'Student', semesterNum: 2 }; } },
    '../../utils/residenceService': { residenceService: { mine: async () => { if (failHall) throw new Error('Hall unavailable'); return residence; } } },
    '../../utils/stsService': { stsService: { current: async () => { if (failSTS) throw new Error('STS unavailable'); return sts; } } },
  });
  loaderData = await view.loader({ params: { studentId: 'another-student' } });
  const html = renderToStaticMarkup(React.createElement(view.default));
  for (const phrase of ['Original Hall', 'Current Hall', 'Room B12', '2026/2027', 'Assigned Practice School', 'Second Semester', 'Mentor Ama']) assert.ok(html.includes(phrase));
  assert.doesNotMatch(html, /<(input|select|textarea|form)\b/);
  failHall = true;
  loaderData = await view.loader({ params: {} });
  assert.equal(loaderData.residence, null); assert.equal(loaderData.sts, sts);
  const partial = renderToStaticMarkup(React.createElement(view.default));
  assert.match(partial, /hall and room details could not be loaded/); assert.match(partial, /Assigned Practice School/);
  failHall = false; failSTS = true;
  loaderData = await view.loader({ params: {} });
  assert.equal(loaderData.residence, residence); assert.equal(loaderData.sts, null);
  const other = renderToStaticMarkup(React.createElement(view.default));
  assert.match(other, /Room B12/); assert.match(other, /STS placement could not be loaded/);
});


test('hall gender is mandatory and must match the student before affiliation', () => {
  for (const gender of ['M', 'F']) assert.doesNotThrow(() => rules.assertHallGender({ gender }, { gender }));
  assert.doesNotThrow(() => rules.assertHallGender({ gender: ' Female ' }, { gender: 'F' }));
  assert.throws(() => rules.assertHallGender({ gender: 'F' }, { gender: 'M' }), /does not match this hall/);
  assert.throws(() => rules.assertHallGender({ gender: 'M' }, { gender: null }), /Set the hall gender/);
  assert.throws(() => rules.assertHallGender({ gender: null }, { gender: 'M' }), /Record the student/);
});
test('hall forms require a gender and affiliation selectors hide incompatible halls', () => {
  const service = load(path.join(front, 'src/utils/residenceService.ts'), { './axios': {}, './requestError': {} });
  const forms = load(path.join(front, 'src/components/residence/HallForms.tsx'), { '../../utils/residenceService': service, '../../utils/requestError': {} });
  const halls = [{ id: 'm', name: 'Male Hall', gender: 'M', active: true }, { id: 'f', name: 'Female Hall', gender: 'F', active: true }, { id: 'legacy', name: 'Unconfigured Hall', gender: null, active: true }];
  const hallHtml = renderToStaticMarkup(React.createElement(forms.RecordForm, { type: 'halls', options: { halls }, save() {}, cancel() {} }));
  assert.match(hallHtml, /name="gender" required/);
  const affiliation = renderToStaticMarkup(React.createElement(forms.OriginalForm, { student: { id: 's', gender: 'F' }, halls, save() {} }));
  assert.match(affiliation, /Female Hall/); assert.doesNotMatch(affiliation, /Male Hall|Unconfigured Hall/);
});
