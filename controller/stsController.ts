import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';
import { logRecords } from '../util/auditLog';
import { STSError, stsAdmin, stsMentorScope, textField, positiveInt, eligibility, schoolData, mentorData, csvCell } from '../util/sts';

const studentSelect = { id: true, indexno: true, fname: true, mname: true, lname: true, semesterNum: true,
  programId: true, deferStatus: true, completeStatus: true, graduateStatus: true,
  program: { select: { id: true, longName: true, semesterTotal: true } } } as const;
const include = { session: { select: { id: true, title: true, semester: true, default: true, status: true } },
  school: { select: { id: true, name: true, address: true, district: true, phone: true, active: true } },
  mentor: { select: { id: true, name: true, phone: true, email: true, active: true } } } as const;
const nameOf = (s: any) => [s.fname, s.mname, s.lname].filter(Boolean).join(' ');
const idOf = (req: Request) => textField(req.params.id, 'Record ID', 191, true)!;
const plain = (v: any) => JSON.parse(JSON.stringify(v));

// All mutation failures are caught here, including transaction conflicts and missing migrations.
const handler = (fn: (req: any, res: Response) => Promise<any>) => async (req: Request, res: Response) => {
  try { return await fn(req, res); }
  catch (error: any) {
    if (error instanceof STSError) return res.status(error.status).json({ message: error.message });
    if (error?.code === 'P2002') return res.status(409).json({ message: 'This school code or student/semester placement already exists. Refresh and edit the existing record.' });
    if (error?.code === 'P2003') return res.status(409).json({ message: 'This record is in use. Deactivate it to preserve placement history.' });
    if (error?.code === 'P2025') return res.status(404).json({ message: 'The requested STS record no longer exists.' });
    if (error?.code === 'P2034') return res.status(409).json({ message: 'Another update conflicted with this request. Refresh and try again.' });
    console.error('STS request failed:', error?.code || error?.name);
    return res.status(500).json({ message: 'STS could not complete this request. Please try again or contact the administrator.' });
  }
};

async function currentSession(tx: Prisma.TransactionClient, sessionId: string) {
  // Lock the selected session so a concurrent calendar activation cannot change it mid-assignment.
  await tx.$queryRaw`SELECT id FROM ais_session WHERE id = ${sessionId} FOR UPDATE`;
  const session = await tx.session.findUnique({ where: { id: sessionId } });
  if (!session?.default || !session.status) throw new STSError('New assignments and reassignments must use the active default academic semester.');
  return session;
}
async function placementData(tx: Prisma.TransactionClient, body: any) {
  const studentId = textField(body.studentId, 'Student', 191, true)!;
  const sessionId = textField(body.sessionId, 'Semester', 191, true)!;
  const schoolId = textField(body.schoolId, 'School', 191, true)!;
  const mentorId = textField(body.mentorId, 'Mentor', 191, true)!;
  const session = await currentSession(tx, sessionId);
  await tx.$queryRaw`SELECT id FROM ais_student WHERE id = ${studentId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM ais_sts_school WHERE id = ${schoolId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM ais_sts_mentor WHERE id = ${mentorId} FOR UPDATE`;
  const student = await tx.student.findUnique({ where: { id: studentId }, select: studentSelect });
  const error = eligibility(student);
  if (error) throw new STSError(error);
  if ((student!.semesterNum! % 2 === 1 ? 'SEM1' : 'SEM2') !== session.semester)
    throw new STSError('The student semester does not match the active academic semester. Check student progression first.');
  const school = await tx.stsSchool.findUnique({ where: { id: schoolId } });
  const mentor = await tx.stsMentor.findUnique({ where: { id: mentorId } });
  if (!school?.active) throw new STSError('Choose an active school.');
  if (!mentor?.active || mentor.schoolId !== schoolId) throw new STSError('Choose an active mentor at the selected school.');
  return { studentId, sessionId, schoolId, mentorId, semesterNum: student!.semesterNum!, yearGroup: Math.ceil(student!.semesterNum! / 2),
    programId: student!.programId!, programName: student!.program!.longName, studentName: nameOf(student), indexno: student!.indexno,
    schoolName: school.name, mentorName: mentor.name };
}

function assignmentWhere(req: any): Prisma.stsAssignmentWhereInput {
  const q = req.query;
  const where: Prisma.stsAssignmentWhereInput = stsAdmin(req) ? {} : stsMentorScope(req);
  for (const key of ['sessionId', 'schoolId', 'mentorId', 'programId', 'studentId'] as const) {
    if (q[key]) where[key] = textField(q[key], key, 191, true)!;
  }
  if (q.yearGroup) { const year = positiveInt(q.yearGroup, 'Year'); if (year > 4) throw new STSError('Choose Year 1 to 4.'); where.yearGroup = year; }
  if (q.status) {
    if (!['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(q.status)) throw new STSError('Invalid placement status.');
    where.status = q.status;
  }
  const search = textField(q.search, 'Search', 100);
  if (search) where.OR = [{ studentName: { contains: search } }, { indexno: { contains: search } }, { studentId: { contains: search } }];
  return where;
}

export default class StsController {
  options = handler(async (req, res) => {
    const admin = stsAdmin(req);
    const [sessions, programs, schools] = await Promise.all([
      prisma.session.findMany({ select: { id: true, title: true, semester: true, default: true, status: true }, orderBy: { createdAt: 'desc' } }),
      prisma.program.findMany({ select: { id: true, longName: true }, orderBy: { longName: 'asc' } }),
      prisma.stsSchool.findMany({ where: admin ? {} : { mentors: { some: { accountTag: req.userId, active: true } } },
        include: { mentors: { where: admin ? {} : { accountTag: req.userId, active: true }, orderBy: { name: 'asc' } },
          _count: { select: { assignments: true } } }, orderBy: { name: 'asc' } }),
    ]);
    return res.json({ sessions, programs, schools, canManage: admin });
  });

  saveSchool = handler(async (req, res) => {
    const data = schoolData(req.body);
    const row = req.params.id ? await prisma.stsSchool.update({ where: { id: idOf(req) }, data }) : await prisma.stsSchool.create({ data });
    await logRecords(req, 'STS_SCHOOL_SAVE', 'ais_sts_school', [row]);
    return res.status(req.params.id ? 200 : 201).json(row);
  });
  deleteSchool = handler(async (req, res) => {
    const row = await prisma.stsSchool.delete({ where: { id: idOf(req) } });
    await logRecords(req, 'STS_SCHOOL_DELETE', 'ais_sts_school', [row]);
    return res.json({ message: 'School deleted.' });
  });
  saveMentor = handler(async (req, res) => {
    const data = mentorData(req.body);
    const row = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ais_sts_school WHERE id = ${data.schoolId} FOR UPDATE`;
      const school = await tx.stsSchool.findUnique({ where: { id: data.schoolId } });
      if (!school || (data.active && !school.active)) throw new STSError('Choose an active school for an active mentor.');
      if (data.accountTag) {
        const account = await tx.user.findUnique({ where: { tag: data.accountTag }, select: { status: true, groupId: true } });
        if (!account?.status || account.groupId !== 2) throw new STSError('The linked account must be an active staff account.');
      }
      if (!req.params.id) return tx.stsMentor.create({ data });
      const id = idOf(req);
      await tx.$queryRaw`SELECT id FROM ais_sts_mentor WHERE id = ${id} FOR UPDATE`;
      const before = await tx.stsMentor.findUnique({ where: { id }, include: { _count: { select: { assignments: true } } } });
      if (!before) throw new STSError('Mentor not found.', 404);
      if (before.schoolId !== data.schoolId && before._count.assignments) throw new STSError('This mentor has placement history. Deactivate this record and create a mentor record at the new school.', 409);
      return tx.stsMentor.update({ where: { id }, data });
    });
    await logRecords(req, 'STS_MENTOR_SAVE', 'ais_sts_mentor', [row]);
    return res.status(req.params.id ? 200 : 201).json(row);
  });
  deleteMentor = handler(async (req, res) => {
    const row = await prisma.stsMentor.delete({ where: { id: idOf(req) } });
    await logRecords(req, 'STS_MENTOR_DELETE', 'ais_sts_mentor', [row]);
    return res.json({ message: 'Mentor deleted.' });
  });

  candidates = handler(async (req, res) => {
    const search = textField(req.query.search, 'Search', 100, true)!;
    if (search.length < 2) throw new STSError('Enter at least two characters to search for a student.');
    const rows = await prisma.student.findMany({ where: { OR: [{ id: { contains: search } }, { indexno: { contains: search } },
      { fname: { contains: search } }, { lname: { contains: search } }] }, select: studentSelect, orderBy: { id: 'asc' }, take: 50 });
    return res.json(rows.map(s => ({ ...s, name: nameOf(s), ineligibleReason: eligibility(s) })));
  });

  assignments = handler(async (req, res) => {
    const where = assignmentWhere(req);
    const page = req.query.page ? positiveInt(req.query.page, 'Page') : 1;
    const [rows, total, counts] = await prisma.$transaction([
      prisma.stsAssignment.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 50 }),
      prisma.stsAssignment.count({ where }),
      prisma.stsAssignment.groupBy({ by: ['status'], orderBy: { status: 'asc' }, where, _count: { _all: true } }),
    ]);
    return res.json({ rows, total, page, pageSize: 50, counts });
  });
  history = handler(async (req, res) => {
    const row = await prisma.stsAssignment.findFirst({ where: { id: idOf(req), ...(stsAdmin(req) ? {} : stsMentorScope(req)) },
      include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
    if (!row) throw new STSError('Placement not found.', 404);
    return res.json(row.events);
  });
  createAssignment = handler(async (req, res) => {
    const notes = textField(req.body.notes, 'Notes', 5000);
    const row = await prisma.$transaction(async tx => {
      const data = await placementData(tx, req.body);
      const created = await tx.stsAssignment.create({ data: { ...data, notes, createdBy: req.userId } });
      await tx.stsAssignmentEvent.create({ data: { assignmentId: created.id, action: 'ASSIGNED', actor: req.userId, snapshot: plain(created) } });
      return created;
    });
    return res.status(201).json(row);
  });
  updateAssignment = handler(async (req, res) => {
    const id = idOf(req), version = positiveInt(req.body.version, 'Version');
    const admin = stsAdmin(req);
    const row = await prisma.$transaction(async tx => {
      const before = await tx.stsAssignment.findFirst({ where: { id, ...(admin ? {} : stsMentorScope(req)) } });
      if (!before) throw new STSError('Placement not found.', 404);
      if (before.version !== version) throw new STSError('This placement has changed. Refresh before saving.', 409);
      const reassign = req.body.schoolId !== undefined || req.body.mentorId !== undefined;
      if (!admin && (reassign || req.body.status === 'CANCELLED' || before.status === 'CANCELLED')) throw new STSError('Only an STS coordinator can reassign or cancel a placement.', 403);
      const reason = textField(req.body.reason, 'Reason', 1000, reassign || req.body.status === 'CANCELLED');
      const data: Prisma.stsAssignmentUncheckedUpdateManyInput = { version: { increment: 1 } };
      if (reassign) {
        // The student/session and academic snapshots of an existing placement never change.
        const placement = await placementData(tx, { ...req.body, studentId: before.studentId, sessionId: before.sessionId });
        if (placement.semesterNum !== before.semesterNum || placement.programId !== before.programId)
          throw new STSError('The student has progressed or changed programme since this placement. Start a new placement in the correct semester.');
        Object.assign(data, { schoolId: placement.schoolId, mentorId: placement.mentorId, schoolName: placement.schoolName, mentorName: placement.mentorName, status: 'ACTIVE' });
      }
      if (req.body.status !== undefined) {
        if (!['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(req.body.status)) throw new STSError('Invalid placement status.');
        if (before.status === 'CANCELLED' && !reassign && req.body.status !== 'CANCELLED') throw new STSError('Use Reassign to restore a cancelled placement.');
        data.status = req.body.status;
      }
      if (req.body.notes !== undefined) data.notes = textField(req.body.notes, 'Notes', 5000);
      if (!reassign && req.body.notes === undefined && req.body.status === undefined) throw new STSError('No placement changes supplied.');
      const changed = await tx.stsAssignment.updateMany({ where: { id, version, ...(admin ? {} : stsMentorScope(req)) }, data });
      if (!changed.count) throw new STSError('This placement has changed. Refresh before saving.', 409);
      const updated = await tx.stsAssignment.findUniqueOrThrow({ where: { id } });
      await tx.stsAssignmentEvent.create({ data: { assignmentId: id, action: reassign ? 'REASSIGNED' : req.body.status === 'CANCELLED' ? 'CANCELLED' : 'UPDATED',
        actor: req.userId, reason, snapshot: plain(updated) } });
      return updated;
    });
    return res.json(row);
  });
  report = handler(async (req, res) => {
    const rows = await prisma.stsAssignment.findMany({ where: assignmentWhere(req), include, orderBy: [{ sessionId: 'asc' }, { studentName: 'asc' }], take: 10001 });
    if (rows.length > 10000) throw new STSError('This report exceeds 10,000 placements. Filter by semester, school or year and try again.', 413);
    const headings = ['Academic semester', 'Student ID', 'Index number', 'Student', 'Programme', 'Year', 'Student semester', 'School', 'Mentor', 'Status', 'Notes'];
    const lines = rows.map(r => [r.session.title, r.studentId, r.indexno, r.studentName, r.programName, r.yearGroup, r.semesterNum, r.schoolName, r.mentorName, r.status, r.notes]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="STS-placements.csv"');
    return res.send('\uFEFF' + [headings, ...lines].map(row => row.map(csvCell).join(',')).join('\r\n'));
  });
  current = handler(async (req, res) => {
    if (Number(req.groupId) !== 1) throw new STSError('This page is for student accounts.', 403);
    const session = await prisma.session.findFirst({ where: { default: true, status: true },
      select: { id: true, title: true, semester: true }, orderBy: { createdAt: 'desc' } });
    if (!session) return res.json({ session: null, placement: null });
    const placement = await prisma.stsAssignment.findFirst({ where: { studentId: req.userId, sessionId: session.id,
      status: { in: ['ACTIVE', 'COMPLETED'] } }, include });
    return res.json({ session, placement });
  });
  mine = handler(async (req, res) => {
    if (Number(req.groupId) !== 1) throw new STSError('This page is for student accounts.', 403);
    return res.json(await prisma.stsAssignment.findMany({ where: { studentId: req.userId }, include, orderBy: { createdAt: 'desc' } }));
  });
}
