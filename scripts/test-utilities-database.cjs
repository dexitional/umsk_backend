// UTILITIES_TEST_DATABASE=1 node scripts/test-utilities-database.cjs
// Uses a disposable database on a LOCAL server. Does not modify application data.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const mysql = require('mysql2/promise');
const { randomUUID } = require('node:crypto');
const { Prisma, PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
const rules = require('../util/utilities.ts');
const url = new URL(process.env.UMS_URL || process.env.DATABASE_URL);
const cfg = process.env.MYSQL_HOST ? { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASS, database: process.env.MYSQL_DB }
  : { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) };
if (process.env.UTILITIES_TEST_DATABASE !== '1' || !['localhost', '127.0.0.1', '::1'].includes(cfg.host)) throw new Error('Select a local database and UTILITIES_TEST_DATABASE=1.');
const temp = 'umsk_utilities_test_' + randomUUID().replaceAll('-', '');
let connection, db, checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name); };
const version = r => ({ ...r, updatedAt: new Date(r.updatedAt).toISOString() });
(async () => {
  connection = await mysql.createConnection({ ...cfg, multipleStatements: true });
  await connection.query(`CREATE DATABASE \`${temp}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await connection.query(`USE \`${temp}\``);
  const names = ['student', 'staff', 'nss', 'relative', 'program', 'session', 'major', 'activityProgchange', 'log', ...Object.keys(rules.utilityModels)];
  const tables = [...names.map(name => { const model = Prisma.dmmf.datamodel.models.find(m => m.name === name); return model.dbName || name; }), 'sso_app', 'sso_amodule', 'sso_arole'];
  for (const table of tables) await connection.query(`CREATE TABLE ${mysql.escapeId(table)} LIKE ${mysql.escapeId(cfg.database)}.${mysql.escapeId(table)}`);
  await connection.query(`INSERT INTO sso_app SELECT * FROM ${mysql.escapeId(cfg.database)}.sso_app WHERE tag='ais'`);
  const migration = fs.readFileSync(path.resolve(__dirname, '../prisma/sql/2026-10-22_utilities_module.sql'), 'utf8');
  await connection.query(migration); await connection.query(migration);
  db = new PrismaClient({ adapter: new PrismaMariaDb({ ...cfg, database: temp, connectionLimit: 10 }) });
  const filename = path.resolve(__dirname, '../controller/utilitiesController.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, require: id => id === '../prisma/client' ? { prisma: db } : id === '../util/utilities' ? rules : require(id) });
  const c = new module.exports.default();
  const call = async (method, body = {}, params = {}, query = {}) => { const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; await c[method]({ userId: 'registry', groupId: 2, body, params, query }, res); return res; };
  await check('role migration is idempotent', async () => {
    const [rows] = await connection.query("SELECT r.id FROM sso_arole r JOIN sso_amodule m ON m.id=r.appModuleId WHERE m.tag='utilities' AND r.title='admin'"); assert.equal(rows.length, 1);
  });
  for (const [key, meta] of Object.entries(rules.utilityModels)) await check(key + ': create, list, update, stale edit, delete and audit', async () => {
    const data = Object.fromEntries(meta.fields.map(f => [f.key, f.type === 'number' ? 233 : key + '-' + f.key]));
    if (key === 'country') data.shortName = 'GH';
    const created = await call('save', data, { module: key }); assert.equal(created.code, 201, JSON.stringify(created.body));
    const r = version(created.body);
    assert.equal((await call('save', data, { module: key })).code, 409);
    const listed = await call('list', {}, { module: key }, { search: key }); assert.equal(listed.body.total, 1);
    const updated = await call('save', { ...r, status: false }, { module: key, id: r.id }); assert.equal(updated.code, 200);
    assert.equal((await call('save', r, { module: key, id: r.id })).code, 409);
    assert.equal((await call('remove', r, { module: key, id: r.id })).code, 409);
    assert.equal((await call('list', {}, { module: key }, { status: 'active' })).body.total, 0);
    assert.equal((await call('remove', version(updated.body), { module: key, id: r.id })).code, 200);
    assert.equal(await db[key].count(), 0);
  });
  await check('referenced lookup cannot be deleted, and deactivation preserves student data', async () => {
    const r = version((await call('save', { title: 'Referenced' }, { module: 'religion' })).body);
    await db.student.create({ data: { id: 'reference', religionId: r.id } });
    assert.equal((await call('remove', r, { module: 'religion', id: r.id })).code, 409);
    assert.equal((await call('save', { ...r, status: false }, { module: 'religion', id: r.id })).code, 200);
    assert.equal((await db.student.findUnique({ where: { id: 'reference' } })).religionId, r.id);
  });
  const old = await db.program.create({ data: { code: 'OLD', shortName: 'Old', longName: 'Old program', category: 'UG', semesterTotal: 8 } });
  const target = await db.program.create({ data: { code: 'NEW', shortName: 'New', longName: 'New program', category: 'UG', semesterTotal: 8, hasMajor: true } });
  const major = await db.major.create({ data: { programId: target.id, longName: 'New major' } });
  const session = await db.session.create({ data: { title: 'Current semester', year: '2026/2027', semester: 'SEM1', default: true } });
  await db.student.create({ data: { id: 'student', indexno: 'INDEX-1', fname: 'Test', programId: old.id, semesterNum: 3 } });
  const data = { studentId: 'student', sessionId: session.id, newProgramId: target.id, newSemesterNum: 3, reason: 'Academic transfer' };
  let draft;
  await check('program changes validate destination, duration, session and status', async () => {
    assert.equal((await call('saveChange', { ...data, newProgramId: old.id })).code, 400);
    assert.equal((await call('saveChange', { ...data, newSemesterNum: 9 })).code, 400);
    assert.equal((await call('saveChange', { ...data, newSemesterNum: 2 })).code, 400);
    await db.student.update({ where: { id: 'student' }, data: { deferStatus: true } });
    assert.equal((await call('saveChange', data)).code, 400);
    await db.student.update({ where: { id: 'student' }, data: { deferStatus: false } });
    const made = await call('saveChange', { ...data, approved: true }); assert.equal(made.code, 201); assert.equal(made.body.approved, false); draft = version(made.body);
    assert.equal((await db.student.findUnique({ where: { id: 'student' } })).programId, old.id);
    assert.equal((await call('saveChange', data)).code, 409);
  });
  await check('drafts can be edited and deleted without changing the student', async () => {
    const updated = await call('saveChange', { ...draft, reason: 'Revised' }, { id: draft.id }); assert.equal(updated.code, 200);
    assert.equal((await call('deleteChange', draft, { id: draft.id })).code, 409);
    assert.equal((await call('deleteChange', version(updated.body), { id: draft.id })).code, 200);
    draft = version((await call('saveChange', data)).body);
    const list = await call('changes', {}, {}, { search: 'INDEX-1', status: 'draft' }); assert.equal(list.body.total, 1);
    assert.equal((await call('options')).code, 200);
  });
  await check('approval rejects stale student review, invalid major and duplicate approval; preserves index and history', async () => {
    const student = await db.student.findUnique({ where: { id: 'student' } });
    const body = { updatedAt: draft.updatedAt, studentSnapshot: student, majorId: major.id };
    assert.equal((await call('approveChange', { ...body, studentSnapshot: { ...student, semesterNum: 1 } }, { id: draft.id })).code, 409);
    assert.equal((await call('approveChange', { ...body, majorId: 'bad' }, { id: draft.id })).code, 400);
    const approved = await call('approveChange', body, { id: draft.id }); assert.equal(approved.code, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.approvedBy, 'registry');
    const after = await db.student.findUnique({ where: { id: 'student' } });
    assert.equal(after.programId, target.id); assert.equal(after.majorId, major.id); assert.equal(after.indexno, 'INDEX-1');
    assert.equal((await call('approveChange', body, { id: draft.id })).code, 409);
    assert.equal((await call('deleteChange', version(approved.body), { id: draft.id })).code, 409);
    assert.equal((await call('saveChange', { ...version(approved.body), newProgramId: old.id }, { id: draft.id })).code, 409);
    assert.equal(await db.log.count({ where: { action: 'PROGRAM_CHANGE_APPROVED' } }), 1);
  });
  await check('concurrent duplicate creates do not produce duplicate lookup records', async () => {
    const responses = await Promise.all([call('save', { title: 'Concurrent' }, { module: 'religion' }), call('save', { title: 'Concurrent' }, { module: 'religion' })]);
    assert.equal(responses.filter(r => r.code === 201).length, 1);
    assert.ok(responses.every(r => [201, 409].includes(r.code)));
    assert.equal(await db.religion.count({ where: { title: 'Concurrent' } }), 1);
  });
  await check('concurrent approvals apply a program change only once', async () => {
    const student = await db.student.create({ data: { id: 'race', indexno: 'RACE-1', programId: old.id, semesterNum: 3 } });
    const record = version((await call('saveChange', { ...data, studentId: student.id })).body);
    const body = { updatedAt: record.updatedAt, studentSnapshot: student, majorId: major.id };
    const responses = await Promise.all([call('approveChange', body, { id: record.id }), call('approveChange', body, { id: record.id })]);
    assert.equal(responses.filter(r => r.code === 200).length, 1);
    assert.ok(responses.every(r => [200, 409].includes(r.code)));
    assert.equal((await db.student.findUnique({ where: { id: student.id } })).programId, target.id);
    assert.equal(await db.log.count({ where: { action: 'PROGRAM_CHANGE_APPROVED' } }), 2);
  });
  console.log(`${checks} database checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (db) await db.$disconnect();
  if (connection) { await connection.query(`DROP DATABASE IF EXISTS \`${temp}\``); await connection.end(); }
});
