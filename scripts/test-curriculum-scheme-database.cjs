// Explicit local integration check. All synthetic records are rolled back.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const host = process.env.MYSQL_HOST || new URL(process.env.UMS_URL || process.env.DATABASE_URL).hostname;
if (process.env.CURRICULUM_TEST_DATABASE !== '1' || !['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Select a local database and set CURRICULUM_TEST_DATABASE=1.');
const { prismaBase: db } = require('../server/prisma/client');
const { registrationCourses } = require('../util/curriculumScheme.ts');
const key = 'curr-' + randomUUID();
const rollback = new Error('ROLLBACK_CURRICULUM_TEST');
(async () => {
  try {
    await db.$transaction(async tx => {
      const common = { gradeMeta: [{ min: 0, max: 100, grade: 'A', gradepoint: 4 }], classMeta: [{ min: 0, max: 4, class: 'First' }], scoreRange: {}, passMark: 50 };
      const oldScheme = await tx.scheme.create({ data: { ...common, title: key + '-old' } });
      const curriculumScheme = await tx.scheme.create({ data: { ...common, title: key + '-curriculum' } });
      const program = await tx.program.create({ data: { code: key, shortName: 'Test', longName: key, category: 'UG', semesterTotal: 8, schemeId: oldScheme.id } });
      const course = await tx.course.create({ data: { id: key, title: key, creditHour: 3 } });
      const mount = await tx.structure.create({ data: { programId: program.id, courseId: course.id, semesterNum: 1, type: 'C', schemeId: curriculumScheme.id } });
      const student = await tx.student.create({ data: { id: key, indexno: key, programId: program.id, semesterNum: 1 } });
      const session = await tx.session.create({ data: { title: key, semester: 'SEM1' } });
      const [entry] = await registrationCourses(tx, student, [{ code: course.id, schemeId: oldScheme.id }], session.id);
      assert.equal(entry.schemeId, curriculumScheme.id);
      const result = await tx.assessment.create({ data: entry });
      await tx.structure.update({ where: { id: mount.id }, data: { schemeId: oldScheme.id } });
      const retained = await tx.assessment.findUnique({ where: { id: result.id }, include: { scheme: true } });
      assert.equal(retained.schemeId, curriculumScheme.id);
      const mapped = await tx.$queryRaw`SELECT scheme_id FROM ais_structure WHERE id = ${mount.id}`;
      assert.equal(mapped[0].scheme_id, oldScheme.id);
      await assert.rejects(tx.structure.update({ where: { id: mount.id }, data: { schemeId: 'not-a-scheme' } }), e => e.code === 'P2003');
      throw rollback;
    }, { timeout: 15000 });
  } catch (error) { if (error !== rollback) throw error; }
  assert.equal(await db.student.count({ where: { id: key } }), 0);
  console.log('Curriculum scheme mapping, registration resolution, historical assessment preservation, foreign key and rollback passed. No fixture data retained.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
