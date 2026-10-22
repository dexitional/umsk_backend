// Optional local integration check: STS_TEST_DATABASE=1 node scripts/test-sts-database.cjs
// All fixture writes are in one transaction which is deliberately rolled back.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const connectionUrl = process.env.UMS_URL || process.env.DATABASE_URL;
const host = process.env.MYSQL_HOST || (connectionUrl && new URL(connectionUrl).hostname);
if (process.env.STS_TEST_DATABASE !== '1' || !['localhost', '127.0.0.1', '::1'].includes(host)) {
  throw new Error('Run only against an explicitly selected local database with STS_TEST_DATABASE=1.');
}
const { prismaBase: db } = require('../server/prisma/client');
const rollback = new Error('ROLLBACK_STS_TEST');
const key = 'sts-test-' + randomUUID();
(async () => {
  try {
    await db.$transaction(async tx => {
      const school = await tx.stsSchool.create({ data: { code: key, name: 'STS integration fixture' } });
      const mentor = await tx.stsMentor.create({ data: { schoolId: school.id, name: 'Fixture mentor' } });
      const program = await tx.program.create({ data: { code: key, shortName: 'STS TEST', longName: 'STS integration fixture', category: 'UG', semesterTotal: 8 } });
      const student = await tx.student.create({ data: { id: key, fname: 'STS', lname: 'Fixture', programId: program.id, semesterNum: 1 } });
      const session = await tx.session.create({ data: { title: key, semester: 'SEM1' } });
      const data = { studentId: student.id, sessionId: session.id, schoolId: school.id, mentorId: mentor.id, semesterNum: 1, yearGroup: 1,
        programId: program.id, programName: program.longName, studentName: 'STS Fixture', schoolName: school.name, mentorName: mentor.name, createdBy: key };
      const assignment = await tx.stsAssignment.create({ data });
      await tx.stsAssignmentEvent.create({ data: { assignmentId: assignment.id, action: 'ASSIGNED', actor: key, snapshot: data } });
      await assert.rejects(tx.stsAssignment.create({ data }), e => e.code === 'P2002');
      await assert.rejects(tx.stsMentor.delete({ where: { id: mentor.id } }), e => e.code === 'P2003');
      await assert.rejects(tx.stsSchool.delete({ where: { id: school.id } }), e => e.code === 'P2003');
      await assert.rejects(tx.stsAssignment.delete({ where: { id: assignment.id } }), e => e.code === 'P2003');
      assert.equal((await tx.stsAssignment.updateMany({ where: { id: assignment.id, version: 1 }, data: { version: { increment: 1 }, notes: 'Visited' } })).count, 1);
      assert.equal((await tx.stsAssignment.updateMany({ where: { id: assignment.id, version: 1 }, data: { notes: 'Stale write' } })).count, 0);
      const own = await tx.stsAssignment.findMany({ where: { studentId: student.id }, include: { session: true, school: true, mentor: true, events: true } });
      assert.equal(own.length, 1); assert.equal(own[0].events.length, 1);
      await tx.stsAssignment.groupBy({ by: ['status'], orderBy: { status: 'asc' }, where: { studentId: student.id }, _count: { _all: true } });
      throw rollback;
    }, { timeout: 15000 });
  } catch (error) { if (error !== rollback) throw error; }
  assert.equal(await db.student.count({ where: { id: key } }), 0);
  assert.equal(await db.stsSchool.count({ where: { code: key } }), 0);
  console.log('STS database constraints, relations, version checks and transaction rollback passed. No fixture data retained.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
