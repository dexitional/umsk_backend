export class ResidenceError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export const HALL_ROLES = ['hall::admin', 'student::admin', 'student::registry'];
export function text(value: unknown, label: string, max = 191, required = true): string | null {
  if (value == null || value === '') { if (required) throw new ResidenceError(`${label} is required.`); return null; }
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new ResidenceError(`${label} must be text of at most ${max} characters.`);
  return value.trim() || null;
}
export function positive(value: unknown, label: string): number {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new ResidenceError(`${label} must be a positive whole number.`);
  return Number(value);
}
export function genderOf(value: unknown): string | null {
  const gender = String(value || '').trim().toUpperCase();
  return ['M', 'MALE'].includes(gender) ? 'M' : ['F', 'FEMALE'].includes(gender) ? 'F' : null;
}
export function assertHallGender(student: any, hall: any) {
  if (!hall || !['M', 'F'].includes(hall.gender)) throw new ResidenceError('Set the hall gender in Hall Module before affiliating or assigning students.');
  const gender = genderOf(student?.gender);
  if (!gender) throw new ResidenceError('Record the student’s gender before selecting a hall.');
  if (gender !== hall.gender) throw new ResidenceError('The student’s gender does not match this hall.');
}
export function academicYear(session: any): string {
  const year = text(session?.year, 'Academic year', 50)!;
  // Formatting variations must not create a second allocation for the same year.
  const match = /^(\d{4})\s*[/\-]\s*(\d{4})$/.exec(year);
  if (!match || Number(match[2]) !== Number(match[1]) + 1) throw new ResidenceError('Set the academic calendar year as consecutive years, for example 2026/2027.');
  return `${match[1]}/${match[2]}`;
}
export function checkAssignmentStudent(student: any) {
  if (!student) throw new ResidenceError('Student not found.', 404);
  if (student.deferStatus || student.completeStatus || student.graduateStatus) throw new ResidenceError('Deferred, completed or graduated students cannot receive a room.');
  if (!Number.isInteger(student.semesterNum) || student.semesterNum < 1 || student.semesterNum % 2 !== 1) throw new ResidenceError('Room assignments are available in the first semester of each student year only.');
  if (!genderOf(student.gender)) throw new ResidenceError('Record the student’s gender before assigning a room.');
}
export const clean = (value: any) => JSON.parse(JSON.stringify(value));
export const studentInclude = { originalHall: true, currentHall: true };
export const assignmentInclude = { session: { select: { id: true, title: true, year: true, semester: true } } };
export const transactionOptions = { isolationLevel: 'ReadCommitted' as const, maxWait: 10000, timeout: 20000 };

export async function lockStudent(tx: any, id: string) {
  await tx.$queryRaw`SELECT id FROM ais_student WHERE id = ${id} FOR UPDATE`;
  const student = await tx.student.findUnique({ where: { id }, include: studentInclude });
  if (!student) throw new ResidenceError('Student not found.', 404);
  return student;
}
export async function initialAffiliation(tx: any, student: any, hall: any, actor: string, source: string, reason?: string | null) {
  if (student.originalHallId) throw new ResidenceError('The original hall has already been recorded and cannot be replaced.', 409);
  if (!hall?.id) throw new ResidenceError('Choose an active hall.');
  const lockedHalls = await tx.$queryRaw`SELECT id, name, gender, active FROM ais_hall WHERE id = ${hall.id} FOR UPDATE`;
  hall = lockedHalls[0];
  if (!hall?.active) throw new ResidenceError('Choose an active hall.');
  assertHallGender(student, hall);
  const result = await tx.student.update({ where: { id: student.id }, data: {
    originalHallId: hall.id, currentHallId: hall.id, instituteAffliate: hall.name, originalHallSource: source,
  }, include: studentInclude });
  await tx.hallAffiliationEvent.create({ data: { studentId: student.id, action: 'ORIGINAL_RECORDED', actor, reason: reason || null,
    snapshot: { originalHallId: hall.id, originalHallName: hall.name, currentHallId: hall.id, source } } });
  return result;
}
// Admissions/imports use only the managed hall register; freshers without a hall
// may choose one in their profile or be affiliated by the Hall Module later.
export async function recordAdmissionHall(tx: any, student: any, actor: string) {
  if (!student.instituteAffliate?.trim()) return student;
  const hall = await tx.residenceHall.findUnique({ where: { name: student.instituteAffliate.trim() } });
  if (!hall?.active) throw new ResidenceError(`Hall "${student.instituteAffliate}" is not active in the Hall Module.`);
  return initialAffiliation(tx, student, hall, actor, student.semesterNum === 1 ? 'ADMISSION' : 'LEGACY_IMPORT', 'Hall provided on student admission/import');
}
export async function currentSession(tx: any, sessionId?: string, firstSemester = false) {
  const session = await tx.session.findFirst({ where: { default: true, status: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
  if (!session) throw new ResidenceError('Set an active default semester in Academic Calendar first.');
  if (sessionId && session.id !== sessionId) throw new ResidenceError('The academic semester has changed. Refresh before saving.', 409);
  if (firstSemester && session.semester !== 'SEM1') throw new ResidenceError('Rooms can only be assigned or reassigned in the first semester of the academic year.');
  academicYear(session);
  return session;
}
export async function assignRoom(tx: any, body: any, actor: string, id?: string) {
  const session = await currentSession(tx, text(body.sessionId, 'Semester')!, true);
  const year = academicYear(session);
  // Student and room locks serialize duplicate placements, transfers and capacity checks.
  let student = await lockStudent(tx, text(body.studentId, 'Student')!);
  checkAssignmentStudent(student);
  const previous = await tx.residenceAssignment.findUnique({ where: { studentId_academicYear: { studentId: student.id, academicYear: year } } });
  if (id && (!previous || previous.id !== id)) throw new ResidenceError('This placement does not belong to this student and academic year.', 404);
  if (!id && previous) throw new ResidenceError('A placement already exists for this student and academic year. Reassign the existing record.', 409);
  if (previous && positive(body.version, 'Version') !== previous.version) throw new ResidenceError('The placement changed. Refresh before saving.', 409);
  const reason = text(body.reason, 'Reason', 1000, !!previous);
  const roomId = text(body.roomId, 'Room')!;
  const roomRef = await tx.residenceRoom.findUnique({ where: { id: roomId }, select: { hallId: true } });
  if (!roomRef) throw new ResidenceError('Room not found.', 404);
  await tx.$queryRaw`SELECT id FROM ais_hall WHERE id = ${roomRef.hallId} FOR UPDATE`;
  // A fixed order prevents two transfers between the same pair of rooms deadlocking.
  for (const key of [...new Set([roomId, previous?.roomId].filter(Boolean))].sort()) {
    await tx.$queryRaw`SELECT id FROM ais_hall_room WHERE id = ${key} FOR UPDATE`;
  }
  const room = await tx.residenceRoom.findUnique({ where: { id: roomId }, include: { hall: true } });
  if (!room?.active || !room.hall.active || room.hallId !== roomRef.hallId) throw new ResidenceError('Choose an active room in an active hall.');
  assertHallGender(student, room.hall);
  if (room.gender !== room.hall.gender) throw new ResidenceError('This room’s gender does not match its hall. Contact the hall administrator.');
  if (genderOf(student.gender) !== room.gender) throw new ResidenceError('The student’s gender does not match this room.');
  const occupied = await tx.residenceAssignment.count({ where: { roomId, academicYear: year, status: 'ACTIVE', ...(previous ? { id: { not: previous.id } } : {}) } });
  if (occupied >= room.capacity) throw new ResidenceError('This room is full for the academic year. Choose another room.', 409);
  if (!student.originalHallId) {
    if (student.semesterNum !== 1 || student.instituteAffliate?.trim()) throw new ResidenceError('Record the student’s original affiliation in the Hall Module before assigning a room.');
    student = await initialAffiliation(tx, student, room.hall, actor, 'ADMISSION', reason);
  }
  if (student.currentHallId !== room.hallId) {
    if (body.reaffiliate !== true || !reason) throw new ResidenceError('This room belongs to another hall. Confirm re-affiliation and provide a reason.');
    if (body.expectedHallId !== student.currentHallId) throw new ResidenceError('The student’s current hall changed. Refresh before re-affiliating.', 409);
    await tx.hallAffiliationEvent.create({ data: { studentId: student.id, action: 'REAFFILIATED', actor, reason,
      snapshot: { academicYear: year, sessionId: session.id, originalHallId: student.originalHallId, originalHallName: student.instituteAffliate,
        fromHallId: student.currentHallId, fromHallName: student.currentHall?.name || null, currentHallId: room.hallId, currentHallName: room.hall.name } } });
    await tx.student.update({ where: { id: student.id }, data: { currentHallId: room.hallId } });
  }
  const data = { studentId: student.id, sessionId: session.id, academicYear: year, hallId: room.hallId, roomId,
    semesterNum: student.semesterNum, studentName: [student.fname, student.mname, student.lname].filter(Boolean).join(' ') || student.id,
    indexno: student.indexno, originalHallName: student.instituteAffliate || student.originalHall.name,
    hallName: room.hall.name, roomCode: room.code, gender: room.gender, status: 'ACTIVE' };
  const result = previous
    ? await tx.residenceAssignment.update({ where: { id: previous.id }, data: { ...data, version: { increment: 1 } } })
    : await tx.residenceAssignment.create({ data: { ...data, createdBy: actor } });
  await tx.residenceAssignmentEvent.create({ data: { assignmentId: result.id, action: previous ? 'REASSIGNED' : 'ASSIGNED', actor, reason,
    snapshot: clean({ before: previous || null, after: result }) } });
  return result;
}
export async function releaseRoom(tx: any, id: string, body: any, actor: string) {
  const session = await currentSession(tx, text(body.sessionId, 'Semester')!);
  let record = await tx.residenceAssignment.findUnique({ where: { id } });
  if (!record) throw new ResidenceError('Placement not found.', 404);
  await lockStudent(tx, record.studentId);
  record = await tx.residenceAssignment.findUnique({ where: { id } });
  await tx.$queryRaw`SELECT id FROM ais_hall_room WHERE id = ${record.roomId} FOR UPDATE`;
  if (record.academicYear !== academicYear(session)) throw new ResidenceError('Historical academic-year placements cannot be changed.');
  const reason = text(body.reason, 'Release reason', 1000)!;
  const count = await tx.residenceAssignment.updateMany({ where: { id, version: positive(body.version, 'Version'), status: 'ACTIVE' }, data: { status: 'RELEASED', version: { increment: 1 } } });
  if (!count.count) throw new ResidenceError('The placement changed or is already released. Refresh and try again.', 409);
  const result = await tx.residenceAssignment.findUnique({ where: { id } });
  await tx.residenceAssignmentEvent.create({ data: { assignmentId: id, action: 'RELEASED', actor, reason, snapshot: clean({ before: record, after: result }) } });
  return result;
}
