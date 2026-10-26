// Node 24: node --test scripts/test-utilities.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createRequire } = require('node:module');
const rules = require('../util/utilities.ts');
const root = path.resolve(__dirname, '..');
const front = path.resolve(root, '../frontend');
const frontendRequire = createRequire(path.join(front, 'package.json'));
const React = frontendRequire('react');
const { renderToStaticMarkup } = frontendRequire('react-dom/server');
function load(file, mocks = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, setTimeout, clearTimeout, require: id => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id === 'react') return React;
    if (id.startsWith('react-icons/')) return frontendRequire(id);
    if (id.startsWith('.')) throw new Error('Unmocked module: ' + id);
    return require(id);
  } }); return module.exports;
}
test('only the seven intended lookup models and editable fields are accepted', () => {
  assert.equal(Object.keys(rules.utilityModels).length, 7);
  for (const key of ['student', 'user', '__proto__', 'constructor', '$transaction']) assert.throws(() => rules.definition(key), /Unknown/);
  const data = rules.lookupData('religion', { title: '  Example  ', id: 'injected', createdAt: 'bad', student: { deleteMany: {} } });
  assert.deepEqual(data, { title: 'Example', status: true });
  assert.throws(() => rules.lookupData('title', { tag: 'Mr' }), /Label/);
  assert.throws(() => rules.lookupData('region', { title: 'Region', tag: 'a'.repeat(51) }), /Tag/);
  assert.throws(() => rules.lookupData('religion', { title: 'Name', status: 'false' }), /Status/);
  assert.throws(() => rules.lookupData('country', { longName: 'Country', code: '1.5' }), /whole number/);
  assert.throws(() => rules.lookupData('country', { longName: 'Country', shortName: 'a'.repeat(11) }), /Short name/);
  assert.equal(rules.lookupData('country', { longName: 'Country' }).code, null);
});
test('stale or absent versions are rejected, even for rapid consecutive edits', () => {
  const r = { updatedAt: new Date() };
  rules.checkVersion(r, r.updatedAt.toISOString());
  assert.throws(() => rules.checkVersion(r), /Reload/);
  assert.throws(() => rules.checkVersion(r, '2001-01-01'), /changed/);
  assert.ok(rules.nextVersion(r) > r.updatedAt);
});
test('ORM and raw-query deadlocks are reported as retriable conflicts', () => {
  assert.equal(rules.isWriteConflict({ code: 'P2034' }), true);
  assert.equal(rules.isWriteConflict({ code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict' } } } }), true);
  assert.equal(rules.isWriteConflict({ code: 'P2010', meta: { code: '1213' } }), true);
  assert.equal(rules.isWriteConflict({ code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'mysql', code: 1205 } } } }), true);
  assert.equal(rules.isWriteConflict({ code: 'P2010', meta: { code: '1064' } }), false);
});
test('utilities endpoints require a signed-in AIS staff administrator or registry role', () => {
  const routes = [];
  const router = Object.fromEntries(['use', 'get', 'post', 'patch', 'delete'].map(method => [method, (...args) => routes.push({ method, args })]));
  load(path.join(root, 'route/utilitiesRoute.ts'), {
    express: { Router: () => router }, '../controller/utilitiesController': class {}, '../util/utilities': rules,
    '../middleware/verifyToken': { verifyToken: (_q, _s, next) => next() },
  });
  const gate = routes.filter(r => r.method === 'use')[1].args[0];
  const simulate = req => { let allowed = false; const res = { status(code) { this.code = code; return this; }, json() {} }; gate(req, res, () => allowed = true); return allowed ? 200 : res.code; };
  const identity = { userId: 'staff', groupId: 2, roles: [{ app: 'ais', role: 'utilities::admin' }] };
  assert.equal(simulate(identity), 200);
  assert.equal(simulate({ ...identity, userId: '' }), 401);
  assert.equal(simulate({ ...identity, groupId: 1 }), 403);
  assert.equal(simulate({ ...identity, roles: [{ app: 'other', role: 'utilities::admin' }] }), 403);
  assert.equal(simulate({ ...identity, roles: [{ app: 'ais', role: 'student::clerk' }] }), 403);
  assert.equal(simulate({ ...identity, roles: [{ app: 'ais', role: 'student::registry' }] }), 200);
  assert.ok(routes.some(r => r.method === 'post' && r.args[0] === '/change-of-program/:id/approve'));
});
test('lookup editors expose actual model fields and change approval requests a destination major', () => {
  const forms = load(path.join(front, 'src/components/utilities/UtilityForms.tsx'), { '../../utils/utilitiesService': { utilitiesService: {} } });
  const html = renderToStaticMarkup(React.createElement(forms.LookupForm, { meta: rules.utilityModels.country, busy: false }));
  for (const label of ['Country code', 'Short name', 'Country name', 'Nationality', 'Active']) assert.ok(html.includes(label));
  const approval = renderToStaticMarkup(React.createElement(forms.ApprovalForm, { record: { student: { fname: 'Test' }, newProgramId: 'p', newprogram: { hasMajor: true, longName: 'Program' } }, options: { majors: [{ id: 'm', programId: 'p', longName: 'Major' }] } }));
  assert.match(approval, /Destination major/); assert.match(approval, /Approve and apply/);
});
test('utilities landing page exposes all eight modules and hides them from unauthorized users', () => {
  const modules = Object.entries(rules.utilityModels).map(([key, meta]) => [key, meta.title]); modules.splice(2, 0, ['change-of-program', 'Change of program']);
  const make = allowed => load(path.join(front, 'src/pages/ais/PgAISUtilities.tsx'), {
    'react-router-dom': { useParams: () => ({ module: 'invalid' }), NavLink: ({ children, to }) => React.createElement('a', { href: to }, children) },
    '../../components/utilities/UtilityForms': {}, '../../utils/utilitiesService': { utilityModules: modules, utilityRoles: rules.UTILITY_ROLES }, '../../utils/roles': { useHasRole: () => allowed },
  }).default;
  const html = renderToStaticMarkup(React.createElement(make(true)));
  for (const [key] of modules) assert.ok(html.includes('/ais/utilities/' + key));
  const denied = renderToStaticMarkup(React.createElement(make(false)));
  assert.match(denied, /do not have permission/); assert.ok(!denied.includes('/ais/utilities/'));
});
