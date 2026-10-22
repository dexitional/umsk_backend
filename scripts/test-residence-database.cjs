// HALL_TEST_DATABASE=1 node scripts/test-residence-database.cjs
// Creates an isolated temporary database on the configured LOCAL server, then drops it.
// No student records or schema in the application database are changed by this test.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const mysql = require('mysql2/promise');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
const rules = require('../util/residence.ts');
const url = new URL(process.env.UMS_URL || process.env.DATABASE_URL);
const cfg = process.env.MYSQL_HOST ? { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASS, database: process.env.MYSQL_DB }
  : { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) };
if (process.env.HALL_TEST_DATABASE !== '1' || !['localhost', '127.0.0.1', '::1'].includes(cfg.host)) throw new Error('Select a local database and HALL_TEST_DATABASE=1.');
const temp = 'umsk_hall_test_' + randomUUID().replaceAll('-', '');
let connection, db, checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name); };
const res = () => ({ code: 200, headers: {}, status(c) { this.code = c; return this; }, json(body) { this.body = body; return this; }, setHeader(k,v) { this.headers[k] = v; }, send(body) { this.body = body; return this; } });
function loadController() {
  const filename = path.resolve(__dirname, '../controller/residenceController.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, require: id => id === '../prisma/client' ? { prisma: db } : id === '../util/residence' ? rules : id === '../util/sts' ? require('../util/sts.ts') : require(id) });
  return new module.exports.default();
}
(async () => {
  connection = await mysql.createConnection({ ...cfg, multipleStatements: true });
  await connection.query(`CREATE DATABASE \`${temp}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await connection.query(`USE \`${temp}\``);
  for (const name of ['ais_student', 'ais_session', 'sso_app', 'sso_amodule', 'sso_arole', 'log']) {
    await connection.query(`CREATE TABLE \`${name}\` LIKE ${mysql.escapeId(cfg.database)}.\`${name}\``);
  }
  // Allow repeated runs after the application migration has been applied.
  const [columns] = await connection.query('SHOW COLUMNS FROM ais_student');
  for (const field of ['originalHallId', 'currentHallId', 'originalHallSource']) if (columns.some(c => c.Field === field)) await connection.query(`ALTER TABLE ais_student DROP COLUMN \`${field}\``);
  await connection.query(`INSERT INTO sso_app SELECT * FROM ${mysql.escapeId(cfg.database)}.sso_app WHERE tag = 'ais'`);
  await connection.query("INSERT INTO ais_student (id, fname, gender, semesterNum, instituteAffliate) VALUES ('legacy', 'Legacy', 'M', 3, 'Legacy Hall')");
  await connection.query(fs.readFileSync(path.resolve(__dirname, '../prisma/sql/2026-10-22_hall_management.sql'), 'utf8'));
  db = new PrismaClient({ adapter: new PrismaMariaDb({ ...cfg, database: temp, connectionLimit: 10 }) });
  const tx = work => db.$transaction(work, rules.transactionOptions);
  const c = loadController();
  const call = async (method, body = {}, params = {}, query = {}, identity = {}) => { const response = res(); await c[method]({ userId: 'registry', groupId: 2, body, params, query, ...identity }, response); return response; };
  let hallA, hallB, roomA, roomB, female, session, first;
  await check('migration preserves legacy original/current hall and records provenance', async () => {
    const s = await db.student.findUnique({ where: { id: 'legacy' } });
    assert.ok(s.originalHallId); assert.equal(s.currentHallId, s.originalHallId); assert.equal(s.originalHallSource, 'LEGACY');
    assert.equal(await db.hallAffiliationEvent.count({ where: { studentId: s.id } }), 1);
    const [roles] = await connection.query("SELECT r.id FROM sso_arole r JOIN sso_amodule m ON m.id=r.appModuleId WHERE m.tag='hall' AND r.title='admin'"); assert.equal(roles.length, 1);
  });
  await check('hall and room CRUD validate gender, capacity and stale edits', async () => {
    hallA = (await call('saveHall', { code: 'A', name: 'Hall A' })).body;
    hallB = (await call('saveHall', { code: 'B', name: 'Hall B' })).body;
    const make = data => call('saveRoom', data);
    roomA = (await make({ hallId: hallA.id, code: 'A1', gender: 'M', capacity: 1 })).body;
    roomB = (await make({ hallId: hallB.id, code: 'B1', gender: 'M', capacity: 2 })).body;
    female = (await make({ hallId: hallA.id, code: 'F1', gender: 'F', capacity: 2 })).body;
    assert.ok(roomA.id); assert.equal((await make({ hallId: hallA.id, code: 'BAD', gender: 'X', capacity: 1 })).code, 400);
    assert.equal((await make({ hallId: hallA.id, code: 'BAD', gender: 'M', capacity: 0 })).code, 400);
    assert.equal((await call('saveRoom', { ...roomA, version: 99 }, { id: roomA.id })).code, 409);
    session = await db.session.create({ data: { title: '2026/2027 First Semester', year: '2026/2027', semester: 'SEM1', default: true } });
    for (const [id, gender] of [['s1','M'],['s2','M'],['s3','F'],['s4','M']]) await db.student.create({ data: { id, fname: id, gender, semesterNum: 1 } });
  });
  const body = (id, room = roomA, extra = {}) => ({ studentId: id, sessionId: session.id, roomId: room.id, ...extra });
  await check('concurrent attempts at the last bed admit exactly one student', async () => {
    const results = await Promise.allSettled(['s1','s2'].map(id => tx(t => rules.assignRoom(t, body(id), 'registry'))));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected' && /full/.test(r.reason.message)).length, 1);
    first = results.find(r => r.status === 'fulfilled').value;
    assert.equal(await db.residenceAssignment.count({ where: { roomId: roomA.id, status: 'ACTIVE' } }), 1);
  });
  await check('wrong gender, duplicate year and non-first-semester assignments are rejected', async () => {
    await assert.rejects(tx(t => rules.assignRoom(t, body('s3'), 'registry')), /gender/);
    await assert.rejects(tx(t => rules.assignRoom(t, body(first.studentId), 'registry')), /already exists/);
    await db.session.update({ where: { id: session.id }, data: { semester: 'SEM2' } });
    await assert.rejects(tx(t => rules.assignRoom(t, body('s4', roomB), 'registry')), /first semester/);
    await db.session.update({ where: { id: session.id }, data: { semester: 'SEM1' } });
    await db.student.update({ where: { id: 's4' }, data: { semesterNum: 2 } });
    await assert.rejects(tx(t => rules.assignRoom(t, body('s4', roomB), 'registry')), /first semester/);
    await db.student.update({ where: { id: 's4' }, data: { semesterNum: 1, deferStatus: true } });
    await assert.rejects(tx(t => rules.assignRoom(t, body('s4', roomB), 'registry')), /Deferred/);
    await db.student.update({ where: { id: 's4' }, data: { deferStatus: false } });
  });
  await check('re-affiliation is explicit, atomic and keeps original hall and old placement snapshots', async () => {
    const data = body(first.studentId, roomB, { version: first.version, reason: 'Annual room transfer' });
    await assert.rejects(tx(t => rules.assignRoom(t, data, 'registry', first.id)), /Confirm re-affiliation/);
    await assert.rejects(tx(t => rules.assignRoom(t, { ...data, reaffiliate: true, expectedHallId: 'stale' }, 'registry', first.id)), /current hall changed/);
    const next = await tx(t => rules.assignRoom(t, { ...data, reaffiliate: true, expectedHallId: hallA.id }, 'registry', first.id));
    const s = await db.student.findUnique({ where: { id: first.studentId } });
    assert.equal(s.originalHallId, hallA.id); assert.equal(s.currentHallId, hallB.id); assert.equal(s.instituteAffliate, 'Hall A');
    const events = await db.residenceAssignmentEvent.findMany({ where: { assignmentId: next.id }, orderBy: { createdAt: 'asc' } });
    assert.equal(events.length, 2); assert.equal(events[1].snapshot.before.roomId, roomA.id); assert.equal(events[1].snapshot.after.roomId, roomB.id);
    assert.equal(await db.hallAffiliationEvent.count({ where: { studentId: s.id } }), 2);
    await assert.rejects(tx(t => rules.assignRoom(t, { ...data, reaffiliate: true, expectedHallId: hallB.id }, 'registry', first.id)), /placement changed/);
    first = next;
  });
  await check('audit failure rolls back both room transfer and current affiliation', async () => {
    await assert.rejects(tx(async t => {
      const failed = { ...t, residenceAssignmentEvent: { create: async () => { throw new Error('Audit write failed'); } } };
      return rules.assignRoom(failed, body(first.studentId, roomA, { version: first.version, reason: 'Rollback check', reaffiliate: true, expectedHallId: hallB.id }), 'registry', first.id);
    }), /Audit write failed/);
    assert.equal((await db.student.findUnique({ where: { id: first.studentId } })).currentHallId, hallB.id);
    assert.equal((await db.residenceAssignment.findUnique({ where: { id: first.id } })).roomId, roomB.id);
  });
  await check('occupied capacity cannot shrink and referenced rooms/halls cannot be deleted', async () => {
    await tx(t => rules.assignRoom(t, body('s4', roomB), 'registry'));
    assert.equal((await call('saveRoom', { ...roomB, capacity: 1 }, { id: roomB.id })).code, 400);
    assert.equal((await call('saveRoom', { ...roomB, gender: 'F' }, { id: roomB.id })).code, 400);
    assert.equal((await call('deleteRoom', {}, { id: roomB.id })).code, 409);
    assert.equal((await call('deleteHall', {}, { id: hallB.id })).code, 409);
    assert.equal((await call('recordOriginal', { hallId: hallA.id, reason: 'Try overwrite' }, { id: first.studentId })).code, 409);
  });
  await check('second-semester portal shows own annual placement; release frees capacity without changing hall', async () => {
    await db.session.update({ where: { id: session.id }, data: { semester: 'SEM2' } });
    const mine = await call('mine', {}, {}, { studentId: 's4' }, { userId: first.studentId, groupId: 1 });
    assert.equal(mine.body.placement.roomCode, 'B1'); assert.equal(mine.body.student.instituteAffliate, 'Hall A');
    assert.equal((await call('mine')).code, 403);
    first = await tx(t => rules.releaseRoom(t, first.id, { sessionId: session.id, version: first.version, reason: 'Moved out' }, 'registry'));
    assert.equal(first.status, 'RELEASED'); assert.equal((await db.student.findUnique({ where: { id: first.studentId } })).currentHallId, hallB.id);
    const rooms = await call('occupancy', {}, {}, { academicYear: '2026/2027' });
    assert.equal(rooms.body.find(r => r.id === roomB.id).available, 1);
  });
  await check('next academic year has a separate placement and capacity pool; prior year remains immutable', async () => {
    await db.session.update({ where: { id: session.id }, data: { default: false } });
    session = await db.session.create({ data: { title: '2027/2028 First Semester', year: '2027 / 2028', semester: 'SEM1', default: true } });
    await db.student.update({ where: { id: first.studentId }, data: { semesterNum: 3 } });
    const next = await tx(t => rules.assignRoom(t, body(first.studentId, roomB), 'registry'));
    assert.notEqual(first.id, next.id); assert.equal(next.academicYear, '2027/2028');
    await assert.rejects(tx(t => rules.releaseRoom(t, first.id, { sessionId: session.id, version: first.version, reason: 'Historical' }, 'registry')), /Historical/);
    const history = await call('history', {}, { id: first.studentId }); assert.equal(history.body.assignments.length, 2);
    const list = await call('assignments', {}, {}, { academicYear: '2027/2028' }); assert.equal(list.body.total, 1);
    const csv = await call('report', {}, {}, { academicYear: '2027/2028' }); assert.match(csv.body, /Hall A/); assert.match(csv.body, /Hall B/);
  });
  await check('inactive rooms and missing original affiliations cannot receive assignments', async () => {
    await db.student.update({ where: { id: 'legacy' }, data: { originalHallId: null, currentHallId: null } });
    await assert.rejects(tx(t => rules.assignRoom(t, body('legacy', roomA), 'registry')), /original affiliation/);
    assert.equal((await call('recordOriginal', { hallId: hallA.id, reason: 'Verified admission record' }, { id: 'legacy' })).code, 200);
    await db.residenceRoom.update({ where: { id: female.id }, data: { active: false } });
    await assert.rejects(tx(t => rules.assignRoom(t, body('s3', female), 'registry')), /active room/);
  });
  console.log(`${checks} residence database checks passed; isolated database will be removed.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (db) await db.$disconnect();
  if (connection) { try { await connection.query(`DROP DATABASE IF EXISTS \`${temp}\``); } finally { await connection.end(); } }
});
