import { Request, Response } from 'express';
import { prisma } from '../prisma/client';
import { UtilityError, isWriteConflict, utilityModels, definition, lookupData, text, positive, checkVersion, nextVersion, studentSelect, changeInclude, validateDestination } from '../util/utilities';

const handler = (fn: (req: any, res: Response) => Promise<any>) => async (req: Request, res: Response) => {
  try { return await fn(req, res); }
  catch (e: any) {
    if (e instanceof UtilityError) return res.status(e.status).json({ message: e.message });
    if (e?.code === 'P2002') return res.status(409).json({ message: 'A record with these details already exists.' });
    if (e?.code === 'P2003') return res.status(409).json({ message: 'This record is in use. Deactivate it instead of deleting it.' });
    if (e?.code === 'P2025') return res.status(404).json({ message: 'Record not found. Refresh and try again.' });
    if (isWriteConflict(e)) return res.status(409).json({ message: 'Another update conflicted with this request. Refresh and try again.' });
    console.error('Utilities module:', e);
    return res.status(500).json({ message: 'The request could not be completed. Please try again or contact the administrator.' });
  }
};
const transaction = (fn: (tx: any) => Promise<any>) => prisma.$transaction(fn, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 20000 });
const audit = (tx: any, req: any, action: string, meta: any) => tx.log.create({ data: { action, user: req.userId, meta: JSON.parse(JSON.stringify(meta)) } });
const idOf = (req: any) => text(req.params.id, 'Record ID')!;
async function existing(model: any, id: string, version: unknown, include?: any) {
  const record = await model.findUnique({ where: { id }, ...(include && { include }) });
  if (!record) throw new UtilityError('Record not found.', 404);
  checkVersion(record, version); return record;
}
async function draft(tx: any, req: any) {
  const id = idOf(req);
  await tx.$queryRaw`SELECT id FROM ais_activity_progchange WHERE id = ${id} FOR UPDATE`;
  const record = await existing(tx.activityProgchange, id, req.body.updatedAt);
  if (record.approved) throw new UtilityError('Approved changes are retained as history and cannot be edited or deleted.', 409);
  return record;
}
export default class UtilitiesController {
  options = handler(async (_req, res) => {
    const [programs, sessions, majors] = await Promise.all([
      prisma.program.findMany({ where: { status: true }, select: { id: true, longName: true, semesterTotal: true, hasMajor: true }, orderBy: { longName: 'asc' } }),
      prisma.session.findMany({ where: { status: true, default: true }, select: { id: true, title: true, semester: true } }),
      prisma.major.findMany({ where: { status: true }, select: { id: true, programId: true, longName: true, shortName: true } }),
    ]);
    return res.json({ modules: utilityModels, programs, sessions, majors });
  });
  list = handler(async (req, res) => {
    const key = req.params.module, meta = definition(key), model = (prisma as any)[key];
    const search = text(req.query.search, 'Search', 100, false), page = positive(req.query.page || 1, 'Page');
    const where: any = {};
    if (search) where.OR = meta.fields.filter(f => f.type !== 'number').map(f => ({ [f.key]: { contains: search } }));
    if (req.query.status) {
      if (!['active', 'inactive'].includes(req.query.status)) throw new UtilityError('Invalid status filter.');
      where.status = req.query.status === 'active';
    }
    const [rows, total] = await Promise.all([model.findMany({ where, orderBy: [{ [meta.order]: 'asc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 50, include: { _count: true } }), model.count({ where })]);
    return res.json({ rows, total, page });
  });
  save = handler(async (req, res) => {
    const key = req.params.module, meta = definition(key), data = lookupData(key, req.body), id = req.params.id ? idOf(req) : null;
    const record = await transaction(async tx => {
      const model = tx[key], before = id ? await existing(model, id, req.body.updatedAt) : null;
      const duplicate = await model.findFirst({ where: { ...(id && { id: { not: id } }), OR: meta.identity.filter(f => data[f] != null).map(f => ({ [f]: data[f] })) } });
      if (duplicate) throw new UtilityError('A record with this name or tag already exists. Edit or reactivate the existing record.', 409);
      const after = id ? await model.update({ where: { id }, data: { ...data, updatedAt: nextVersion(before) } }) : await model.create({ data });
      await audit(tx, req, 'UTILITY_' + (id ? 'UPDATED' : 'CREATED'), { module: key, before, after });
      return after;
    });
    return res.status(id ? 200 : 201).json(record);
  });
  remove = handler(async (req, res) => {
    const key = req.params.module; definition(key);
    return res.json(await transaction(async tx => {
      const model = tx[key], before = await existing(model, idOf(req), req.body.updatedAt, { _count: true });
      if (Object.values(before._count).some(count => Number(count) > 0)) throw new UtilityError('This record is in use. Set it inactive to preserve existing records.', 409);
      await model.delete({ where: { id: before.id } }); await audit(tx, req, 'UTILITY_DELETED', { module: key, before }); return { deleted: true };
    }));
  });
  students = handler(async (req, res) => {
    const search = text(req.query.search, 'Search', 100, false);
    if (!search || search.length < 2) return res.json([]);
    return res.json(await prisma.student.findMany({ where: { OR: ['id', 'indexno', 'fname', 'lname'].map(f => ({ [f]: { contains: search } })) }, select: { ...studentSelect, program: { select: { longName: true } } }, take: 30, orderBy: { id: 'asc' } }));
  });
  changes = handler(async (req, res) => {
    const page = positive(req.query.page || 1, 'Page'), search = text(req.query.search, 'Search', 100, false), where: any = {};
    if (req.query.status) {
      if (!['draft', 'approved'].includes(req.query.status)) throw new UtilityError('Invalid status filter.');
      where.approved = req.query.status === 'approved';
    }
    if (search) where.OR = [{ studentId: { contains: search } }, { oldIndexno: { contains: search } }, { newIndexno: { contains: search } }, { student: { fname: { contains: search } } }, { student: { lname: { contains: search } } }];
    const [rows, total] = await Promise.all([prisma.activityProgchange.findMany({ where, include: changeInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 50, skip: (page - 1) * 50 }), prisma.activityProgchange.count({ where })]);
    return res.json({ rows, total, page });
  });
  saveChange = handler(async (req, res) => {
    const id = req.params.id ? idOf(req) : null;
    const data = { sessionId: text(req.body.sessionId, 'Academic session')!, newProgramId: text(req.body.newProgramId, 'Destination program')!, newSemesterNum: positive(req.body.newSemesterNum, 'Destination semester'), reason: text(req.body.reason, 'Reason', 255)! };
    const record = await transaction(async tx => {
      const before = id ? await draft(tx, req) : null;
      const studentId = before?.studentId || text(req.body.studentId, 'Student')!;
      const student = await tx.student.findUnique({ where: { id: studentId } });
      await validateDestination(tx, student, data);
      if (before && (before.oldProgramId !== student.programId || before.oldIndexno !== student.indexno)) throw new UtilityError('The student has changed program or index number. Delete this draft and create a new request.', 409);
      if (await tx.activityProgchange.findFirst({ where: { studentId, approved: false, ...(id && { id: { not: id } }) } })) throw new UtilityError('This student already has a draft program change. Edit that draft.', 409);
      const after = id ? await tx.activityProgchange.update({ where: { id }, data: { ...data, updatedAt: nextVersion(before) } }) : await tx.activityProgchange.create({ data: { ...data, studentId, oldProgramId: student.programId, oldIndexno: student.indexno, newIndexno: student.indexno, approved: false } });
      await audit(tx, req, 'PROGRAM_CHANGE_' + (id ? 'UPDATED' : 'CREATED'), { before, after }); return after;
    });
    return res.status(id ? 200 : 201).json(record);
  });
  deleteChange = handler(async (req, res) => res.json(await transaction(async tx => {
    const before = await draft(tx, req); await tx.activityProgchange.delete({ where: { id: before.id } }); await audit(tx, req, 'PROGRAM_CHANGE_DELETED', before); return { deleted: true };
  })));
  approveChange = handler(async (req, res) => res.json(await transaction(async tx => {
    const record = await draft(tx, req);
    // Locks also serialize this action against room assignment, affiliation and other student updates.
    await tx.$queryRaw`SELECT id FROM ais_student WHERE id = ${record.studentId} FOR UPDATE`;
    const student = await tx.student.findUnique({ where: { id: record.studentId } });
    if (!student || student.programId !== record.oldProgramId || student.indexno !== record.oldIndexno) throw new UtilityError('The student changed after this request was created. Create a new draft.', 409);
    const snapshot = req.body.studentSnapshot;
    if (!snapshot || ['programId', 'majorId', 'semesterNum', 'indexno'].some(key => snapshot[key] !== student[key])) throw new UtilityError('The student changed since this review was opened. Refresh before approving.', 409);
    if (record.newIndexno !== student.indexno) throw new UtilityError('This legacy request changes the index number. Review it separately to preserve linked academic records.');
    const program = await validateDestination(tx, student, record);
    let majorId: string | null = null;
    if (program.hasMajor) {
      majorId = text(req.body.majorId, 'Destination major')!;
      const major = await tx.major.findUnique({ where: { id: majorId } });
      if (!major?.status || major.programId !== program.id) throw new UtilityError('Choose an active major in the destination program.');
    }
    const afterStudent = await tx.student.update({ where: { id: student.id }, data: { programId: program.id, majorId, semesterNum: record.newSemesterNum } });
    const after = await tx.activityProgchange.update({ where: { id: record.id }, data: { approved: true, approvedBy: req.userId, approvedAt: new Date(), updatedAt: nextVersion(record) } });
    await audit(tx, req, 'PROGRAM_CHANGE_APPROVED', { before: record, after, studentBefore: { programId: student.programId, majorId: student.majorId, semesterNum: student.semesterNum }, studentAfter: { programId: afterStudent.programId, majorId: afterStudent.majorId, semesterNum: afterStudent.semesterNum } });
    return after;
  })));
}
