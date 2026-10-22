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
  const tx = { residenceHall: { findUnique: async ({ where }) => where.name === 'Alpha' ? { id: 'alpha', name: 'Alpha', active: true } : null },
    student: { update: async args => { writes.push(args); return args.data; } }, hallAffiliationEvent: { create: async args => events.push(args.data) } };
  const original = { id: 'fresher', semesterNum: 1, instituteAffliate: 'Alpha' };
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
  const forms = load(path.join(front,'src/components/residence/HallForms.tsx'), { '../../utils/residenceService': {}, '../../utils/requestError': {} });
  const html = renderToStaticMarkup(React.createElement(forms.RecordForm, { type: 'rooms', options: { halls: [] }, save() {}, cancel() {} }));
  assert.match(html, /name="capacity" min="1" max="10000" step="1" required/); assert.match(html, /name="gender" required/); assert.match(html, /name="hallId" required/);
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
