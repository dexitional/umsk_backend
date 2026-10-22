import { Request, Response } from 'express';
import { prisma } from '../prisma/client';
import { ResidenceError, text, positive, academicYear, genderOf, clean, studentInclude, assignmentInclude, transactionOptions, lockStudent, initialAffiliation, assignRoom, releaseRoom } from '../util/residence';
import { csvCell } from '../util/sts';
const handler = (fn: (req: any, res: Response) => Promise<any>) => async (req: Request, res: Response) => {
  try { return await fn(req, res); }
  catch (e: any) {
    if (e instanceof ResidenceError) return res.status(e.status).json({ message: e.message });
    if (e?.code === 'P2002') return res.status(409).json({ message: 'This hall, room or student/year placement already exists. Refresh and edit the existing record.' });
    if (e?.code === 'P2003') return res.status(409).json({ message: 'This record is in use. Deactivate it to preserve affiliation and placement history.' });
    if (e?.code === 'P2025') return res.status(404).json({ message: 'Record not found. Refresh and try again.' });
    if (['P2034', 'P2028'].includes(e?.code)) return res.status(409).json({ message: 'Another change conflicted with this request. Refresh and try again.' });
    console.error('Hall module:', e);
    return res.status(500).json({ message: 'Hall records could not be processed. Please try again or contact the administrator.' });
  }
};
const idOf = (req: any) => text(req.params.id, 'Record ID')!;
const transaction = (fn: (tx: any) => Promise<any>) => prisma.$transaction(fn, transactionOptions);
const audit = (tx: any, req: any, action: string, meta: any) => tx.log.create({ data: { action, user: req.userId, meta: clean(meta) } });
function filters(query: any) {
  const where: any = {};
  for (const field of ['hallId', 'roomId', 'studentId']) if (query[field]) where[field] = text(query[field], field);
  if (query.academicYear) where.academicYear = academicYear({ year: query.academicYear });
  if (query.status) {
    if (!['ACTIVE', 'RELEASED'].includes(query.status)) throw new ResidenceError('Invalid placement status.');
    where.status = query.status;
  }
  const search = text(query.search, 'Search', 100, false);
  if (search) where.OR = ['studentName', 'studentId', 'indexno'].map(key => ({ [key]: { contains: search } }));
  return where;
}
export default class ResidenceController {
  options = handler(async (_req, res) => {
    const [halls, rooms, sessions] = await Promise.all([
      prisma.residenceHall.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { rooms: true, originalStudents: true, currentStudents: true } } } }),
      prisma.residenceRoom.findMany({ orderBy: [{ hallId: 'asc' }, { code: 'asc' }] }),
      prisma.session.findMany({ select: { id: true, title: true, year: true, semester: true, default: true, status: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
    ]);
    return res.json({ halls, rooms, sessions });
  });
  saveHall = handler(async (req, res) => {
    const id = req.params.id ? idOf(req) : null;
    if (req.body.active !== undefined && typeof req.body.active !== 'boolean') throw new ResidenceError('Active must be true or false.');
    const data = { code: text(req.body.code, 'Hall code', 50)!.toUpperCase(), name: text(req.body.name, 'Hall name', 350)!, active: req.body.active ?? true };
    const result = await transaction(async tx => {
      if (id) {
        await tx.$queryRaw`SELECT id FROM ais_hall WHERE id = ${id} FOR UPDATE`;
        const changed = await tx.residenceHall.updateMany({ where: { id, version: positive(req.body.version, 'Version') }, data: { ...data, version: { increment: 1 } } });
        if (!changed.count) throw new ResidenceError('The hall changed. Refresh before saving.', 409);
      }
      const record = id ? await tx.residenceHall.findUnique({ where: { id } }) : await tx.residenceHall.create({ data });
      await audit(tx, req, id ? 'HALL_UPDATED' : 'HALL_CREATED', record);
      return record;
    });
    return res.status(id ? 200 : 201).json(result);
  });
  saveRoom = handler(async (req, res) => {
    const id = req.params.id ? idOf(req) : null;
    const hallId = text(req.body.hallId, 'Hall')!;
    const gender = genderOf(req.body.gender);
    if (!gender) throw new ResidenceError('Choose Male or Female for the room.');
    if (req.body.active !== undefined && typeof req.body.active !== 'boolean') throw new ResidenceError('Active must be true or false.');
    const data = { hallId, code: text(req.body.code, 'Room number', 50)!.toUpperCase(), gender, capacity: positive(req.body.capacity, 'Capacity'), active: req.body.active ?? true };
    if (data.capacity > 10000) throw new ResidenceError('Capacity cannot exceed 10,000.');
    const result = await transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ais_hall WHERE id = ${hallId} FOR UPDATE`;
      const hall = await tx.residenceHall.findUnique({ where: { id: hallId } });
      if (!hall) throw new ResidenceError('Hall not found.', 404);
      if (id) {
        await tx.$queryRaw`SELECT id FROM ais_hall_room WHERE id = ${id} FOR UPDATE`;
        const before = await tx.residenceRoom.findUnique({ where: { id } });
        if (!before) throw new ResidenceError('Room not found.', 404);
        if ((before.hallId !== hallId || before.gender !== gender) && await tx.residenceAssignment.count({ where: { roomId: id } })) throw new ResidenceError('A room with placement history cannot change hall or gender. Create a new room instead.');
        const counts = await tx.residenceAssignment.groupBy({ by: ['academicYear'], where: { roomId: id, status: 'ACTIVE' }, _count: { _all: true } });
        if (counts.some((c: any) => c._count._all > data.capacity)) throw new ResidenceError('Capacity cannot be lower than the recorded occupancy in an academic year.');
        const changed = await tx.residenceRoom.updateMany({ where: { id, version: positive(req.body.version, 'Version') }, data: { ...data, version: { increment: 1 } } });
        if (!changed.count) throw new ResidenceError('The room changed. Refresh before saving.', 409);
      }
      const record = id ? await tx.residenceRoom.findUnique({ where: { id } }) : await tx.residenceRoom.create({ data });
      await audit(tx, req, id ? 'HALL_ROOM_UPDATED' : 'HALL_ROOM_CREATED', record);
      return record;
    });
    return res.status(id ? 200 : 201).json(result);
  });
  deleteHall = handler(async (req, res) => res.json(await transaction(async tx => {
    const record = await tx.residenceHall.delete({ where: { id: idOf(req) } }); await audit(tx, req, 'HALL_DELETED', record); return { deleted: true };
  })));
  deleteRoom = handler(async (req, res) => res.json(await transaction(async tx => {
    const record = await tx.residenceRoom.delete({ where: { id: idOf(req) } }); await audit(tx, req, 'HALL_ROOM_DELETED', record); return { deleted: true };
  })));
  candidates = handler(async (req, res) => {
    const search = text(req.query.search, 'Search', 100, false);
    if (!search || search.length < 2) return res.json([]);
    return res.json(await prisma.student.findMany({ where: { OR: ['id', 'indexno', 'fname', 'lname'].map(key => ({ [key]: { contains: search } })) },
      select: { id: true, indexno: true, fname: true, mname: true, lname: true, gender: true, semesterNum: true, deferStatus: true, completeStatus: true, graduateStatus: true,
        originalHallId: true, currentHallId: true, instituteAffliate: true, originalHallSource: true, originalHall: true, currentHall: true }, take: 50, orderBy: { id: 'asc' } }));
  });
  recordOriginal = handler(async (req, res) => res.json(await transaction(async tx => {
    const student = await lockStudent(tx, idOf(req));
    const hallId = text(req.body.hallId, 'Original hall')!;
    await tx.$queryRaw`SELECT id FROM ais_hall WHERE id = ${hallId} FOR UPDATE`;
    const hall = await tx.residenceHall.findUnique({ where: { id: hallId } });
    const reason = text(req.body.reason, 'Reason / source of original affiliation', 1000)!;
    return initialAffiliation(tx, student, hall, req.userId, student.semesterNum === 1 ? 'ADMISSION' : 'REGISTRY_HISTORY', reason);
  })));
  assignments = handler(async (req, res) => {
    const where = filters(req.query);
    const page = positive(req.query.page || 1, 'Page');
    const [rows, total] = await Promise.all([prisma.residenceAssignment.findMany({ where, include: assignmentInclude, orderBy: [{ academicYear: 'desc' }, { studentName: 'asc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 50 }), prisma.residenceAssignment.count({ where })]);
    return res.json({ rows, total, page });
  });
  occupancy = handler(async (req, res) => {
    const year = academicYear({ year: req.query.academicYear });
    const [rooms, counts] = await Promise.all([
      prisma.residenceRoom.findMany({ include: { hall: true }, orderBy: [{ hallId: 'asc' }, { code: 'asc' }] }),
      prisma.residenceAssignment.groupBy({ by: ['roomId'], where: { academicYear: year, status: 'ACTIVE' }, _count: { _all: true } }),
    ]);
    const used = new Map(counts.map(c => [c.roomId, c._count._all]));
    return res.json(rooms.map(room => ({ ...room, occupied: used.get(room.id) || 0, available: Math.max(0, room.capacity - (used.get(room.id) || 0)) })));
  });
  assign = handler(async (req, res) => res.status(req.params.id ? 200 : 201).json(await transaction(tx => assignRoom(tx, req.body, req.userId, req.params.id ? idOf(req) : undefined))));
  release = handler(async (req, res) => res.json(await transaction(tx => releaseRoom(tx, idOf(req), req.body, req.userId))));
  history = handler(async (req, res) => {
    const id = idOf(req);
    const student = await prisma.student.findUnique({ where: { id }, select: { id: true, instituteAffliate: true, originalHall: true, currentHall: true, originalHallSource: true } });
    if (!student) throw new ResidenceError('Student not found.', 404);
    const [assignments, affiliations] = await Promise.all([
      prisma.residenceAssignment.findMany({ where: { studentId: id }, include: { ...assignmentInclude, events: { orderBy: { createdAt: 'asc' } } }, orderBy: { academicYear: 'desc' } }),
      prisma.hallAffiliationEvent.findMany({ where: { studentId: id }, orderBy: { createdAt: 'asc' } }),
    ]);
    return res.json({ student, assignments, affiliations });
  });
  mine = handler(async (req, res) => {
    if (Number(req.groupId) !== 1) throw new ResidenceError('This page is for student accounts.', 403);
    const [student, session] = await Promise.all([
      prisma.student.findUnique({ where: { id: req.userId }, select: { instituteAffliate: true, originalHall: true, currentHall: true, originalHallSource: true } }),
      prisma.session.findFirst({ where: { default: true, status: true }, select: { title: true, year: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
    ]);
    if (!student) throw new ResidenceError('Student record not found.', 404);
    const year = session ? academicYear(session) : null;
    const placement = year ? await prisma.residenceAssignment.findUnique({ where: { studentId_academicYear: { studentId: req.userId, academicYear: year } }, select: { academicYear: true, hallName: true, roomCode: true, gender: true, status: true } }) : null;
    return res.json({ student, session, academicYear: year, placement });
  });
  report = handler(async (req, res) => {
    const where = filters(req.query);
    if (await prisma.residenceAssignment.count({ where }) > 20000) throw new ResidenceError('Narrow the report filters to 20,000 placements or fewer.');
    const rows = await prisma.residenceAssignment.findMany({ where, orderBy: [{ academicYear: 'desc' }, { studentName: 'asc' }], take: 20000 });
    const data: any[][] = [['Student ID', 'Index number', 'Student', 'Academic year', 'Semester at assignment', 'Original hall', 'Assigned hall', 'Room', 'Gender', 'Status'], ...rows.map(r => [r.studentId, r.indexno, r.studentName, r.academicYear, r.semesterNum, r.originalHallName, r.hallName, r.roomCode, r.gender, r.status])];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="hall-placements.csv"');
    return res.send('\uFEFF' + data.map(row => row.map(csvCell).join(',')).join('\r\n'));
  });
}
