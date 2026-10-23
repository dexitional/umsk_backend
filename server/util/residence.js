"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.transactionOptions = exports.assignmentInclude = exports.studentInclude = exports.clean = exports.HALL_ROLES = exports.ResidenceError = void 0;
exports.text = text;
exports.positive = positive;
exports.genderOf = genderOf;
exports.assertHallGender = assertHallGender;
exports.academicYear = academicYear;
exports.checkAssignmentStudent = checkAssignmentStudent;
exports.lockStudent = lockStudent;
exports.initialAffiliation = initialAffiliation;
exports.recordAdmissionHall = recordAdmissionHall;
exports.currentSession = currentSession;
exports.assignRoom = assignRoom;
exports.releaseRoom = releaseRoom;
class ResidenceError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
exports.ResidenceError = ResidenceError;
exports.HALL_ROLES = ['hall::admin', 'student::admin', 'student::registry'];
function text(value, label, max = 191, required = true) {
    if (value == null || value === '') {
        if (required)
            throw new ResidenceError(`${label} is required.`);
        return null;
    }
    if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim()))
        throw new ResidenceError(`${label} must be text of at most ${max} characters.`);
    return value.trim() || null;
}
function positive(value, label) {
    if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
        throw new ResidenceError(`${label} must be a positive whole number.`);
    return Number(value);
}
function genderOf(value) {
    const gender = String(value || '').trim().toUpperCase();
    return ['M', 'MALE'].includes(gender) ? 'M' : ['F', 'FEMALE'].includes(gender) ? 'F' : null;
}
function assertHallGender(student, hall) {
    if (!hall || !['M', 'F'].includes(hall.gender))
        throw new ResidenceError('Set the hall gender in Hall Module before affiliating or assigning students.');
    const gender = genderOf(student === null || student === void 0 ? void 0 : student.gender);
    if (!gender)
        throw new ResidenceError('Record the student’s gender before selecting a hall.');
    if (gender !== hall.gender)
        throw new ResidenceError('The student’s gender does not match this hall.');
}
function academicYear(session) {
    const year = text(session === null || session === void 0 ? void 0 : session.year, 'Academic year', 50);
    // Formatting variations must not create a second allocation for the same year.
    const match = /^(\d{4})\s*[/\-]\s*(\d{4})$/.exec(year);
    if (!match || Number(match[2]) !== Number(match[1]) + 1)
        throw new ResidenceError('Set the academic calendar year as consecutive years, for example 2026/2027.');
    return `${match[1]}/${match[2]}`;
}
function checkAssignmentStudent(student) {
    if (!student)
        throw new ResidenceError('Student not found.', 404);
    if (student.deferStatus || student.completeStatus || student.graduateStatus)
        throw new ResidenceError('Deferred, completed or graduated students cannot receive a room.');
    if (!Number.isInteger(student.semesterNum) || student.semesterNum < 1 || student.semesterNum % 2 !== 1)
        throw new ResidenceError('Room assignments are available in the first semester of each student year only.');
    if (!genderOf(student.gender))
        throw new ResidenceError('Record the student’s gender before assigning a room.');
}
const clean = (value) => JSON.parse(JSON.stringify(value));
exports.clean = clean;
exports.studentInclude = { originalHall: true, currentHall: true };
exports.assignmentInclude = { session: { select: { id: true, title: true, year: true, semester: true } } };
exports.transactionOptions = { isolationLevel: 'ReadCommitted', maxWait: 10000, timeout: 20000 };
function lockStudent(tx, id) {
    return __awaiter(this, void 0, void 0, function* () {
        yield tx.$queryRaw `SELECT id FROM ais_student WHERE id = ${id} FOR UPDATE`;
        const student = yield tx.student.findUnique({ where: { id }, include: exports.studentInclude });
        if (!student)
            throw new ResidenceError('Student not found.', 404);
        return student;
    });
}
function initialAffiliation(tx, student, hall, actor, source, reason) {
    return __awaiter(this, void 0, void 0, function* () {
        if (student.originalHallId)
            throw new ResidenceError('The original hall has already been recorded and cannot be replaced.', 409);
        if (!(hall === null || hall === void 0 ? void 0 : hall.id))
            throw new ResidenceError('Choose an active hall.');
        const lockedHalls = yield tx.$queryRaw `SELECT id, name, gender, active FROM ais_hall WHERE id = ${hall.id} FOR UPDATE`;
        hall = lockedHalls[0];
        if (!(hall === null || hall === void 0 ? void 0 : hall.active))
            throw new ResidenceError('Choose an active hall.');
        assertHallGender(student, hall);
        const result = yield tx.student.update({ where: { id: student.id }, data: {
                originalHallId: hall.id, currentHallId: hall.id, instituteAffliate: hall.name, originalHallSource: source,
            }, include: exports.studentInclude });
        yield tx.hallAffiliationEvent.create({ data: { studentId: student.id, action: 'ORIGINAL_RECORDED', actor, reason: reason || null,
                snapshot: { originalHallId: hall.id, originalHallName: hall.name, currentHallId: hall.id, source } } });
        return result;
    });
}
// Admissions/imports use only the managed hall register; freshers without a hall
// may choose one in their profile or be affiliated by the Hall Module later.
function recordAdmissionHall(tx, student, actor) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        if (!((_a = student.instituteAffliate) === null || _a === void 0 ? void 0 : _a.trim()))
            return student;
        const hall = yield tx.residenceHall.findUnique({ where: { name: student.instituteAffliate.trim() } });
        if (!(hall === null || hall === void 0 ? void 0 : hall.active))
            throw new ResidenceError(`Hall "${student.instituteAffliate}" is not active in the Hall Module.`);
        return initialAffiliation(tx, student, hall, actor, student.semesterNum === 1 ? 'ADMISSION' : 'LEGACY_IMPORT', 'Hall provided on student admission/import');
    });
}
function currentSession(tx_1, sessionId_1) {
    return __awaiter(this, arguments, void 0, function* (tx, sessionId, firstSemester = false) {
        const session = yield tx.session.findFirst({ where: { default: true, status: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
        if (!session)
            throw new ResidenceError('Set an active default semester in Academic Calendar first.');
        if (sessionId && session.id !== sessionId)
            throw new ResidenceError('The academic semester has changed. Refresh before saving.', 409);
        if (firstSemester && session.semester !== 'SEM1')
            throw new ResidenceError('Rooms can only be assigned or reassigned in the first semester of the academic year.');
        academicYear(session);
        return session;
    });
}
function assignRoom(tx, body, actor, id) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const session = yield currentSession(tx, text(body.sessionId, 'Semester'), true);
        const year = academicYear(session);
        // Student and room locks serialize duplicate placements, transfers and capacity checks.
        let student = yield lockStudent(tx, text(body.studentId, 'Student'));
        checkAssignmentStudent(student);
        const previous = yield tx.residenceAssignment.findUnique({ where: { studentId_academicYear: { studentId: student.id, academicYear: year } } });
        if (id && (!previous || previous.id !== id))
            throw new ResidenceError('This placement does not belong to this student and academic year.', 404);
        if (!id && previous)
            throw new ResidenceError('A placement already exists for this student and academic year. Reassign the existing record.', 409);
        if (previous && positive(body.version, 'Version') !== previous.version)
            throw new ResidenceError('The placement changed. Refresh before saving.', 409);
        const reason = text(body.reason, 'Reason', 1000, !!previous);
        const roomId = text(body.roomId, 'Room');
        const roomRef = yield tx.residenceRoom.findUnique({ where: { id: roomId }, select: { hallId: true } });
        if (!roomRef)
            throw new ResidenceError('Room not found.', 404);
        yield tx.$queryRaw `SELECT id FROM ais_hall WHERE id = ${roomRef.hallId} FOR UPDATE`;
        // A fixed order prevents two transfers between the same pair of rooms deadlocking.
        for (const key of [...new Set([roomId, previous === null || previous === void 0 ? void 0 : previous.roomId].filter(Boolean))].sort()) {
            yield tx.$queryRaw `SELECT id FROM ais_hall_room WHERE id = ${key} FOR UPDATE`;
        }
        const room = yield tx.residenceRoom.findUnique({ where: { id: roomId }, include: { hall: true } });
        if (!(room === null || room === void 0 ? void 0 : room.active) || !room.hall.active || room.hallId !== roomRef.hallId)
            throw new ResidenceError('Choose an active room in an active hall.');
        assertHallGender(student, room.hall);
        if (room.gender !== room.hall.gender)
            throw new ResidenceError('This room’s gender does not match its hall. Contact the hall administrator.');
        if (genderOf(student.gender) !== room.gender)
            throw new ResidenceError('The student’s gender does not match this room.');
        const occupied = yield tx.residenceAssignment.count({ where: Object.assign({ roomId, academicYear: year, status: 'ACTIVE' }, (previous ? { id: { not: previous.id } } : {})) });
        if (occupied >= room.capacity)
            throw new ResidenceError('This room is full for the academic year. Choose another room.', 409);
        if (!student.originalHallId) {
            if (student.semesterNum !== 1 || ((_a = student.instituteAffliate) === null || _a === void 0 ? void 0 : _a.trim()))
                throw new ResidenceError('Record the student’s original affiliation in the Hall Module before assigning a room.');
            student = yield initialAffiliation(tx, student, room.hall, actor, 'ADMISSION', reason);
        }
        if (student.currentHallId !== room.hallId) {
            if (body.reaffiliate !== true || !reason)
                throw new ResidenceError('This room belongs to another hall. Confirm re-affiliation and provide a reason.');
            if (body.expectedHallId !== student.currentHallId)
                throw new ResidenceError('The student’s current hall changed. Refresh before re-affiliating.', 409);
            yield tx.hallAffiliationEvent.create({ data: { studentId: student.id, action: 'REAFFILIATED', actor, reason,
                    snapshot: { academicYear: year, sessionId: session.id, originalHallId: student.originalHallId, originalHallName: student.instituteAffliate,
                        fromHallId: student.currentHallId, fromHallName: ((_b = student.currentHall) === null || _b === void 0 ? void 0 : _b.name) || null, currentHallId: room.hallId, currentHallName: room.hall.name } } });
            yield tx.student.update({ where: { id: student.id }, data: { currentHallId: room.hallId } });
        }
        const data = { studentId: student.id, sessionId: session.id, academicYear: year, hallId: room.hallId, roomId,
            semesterNum: student.semesterNum, studentName: [student.fname, student.mname, student.lname].filter(Boolean).join(' ') || student.id,
            indexno: student.indexno, originalHallName: student.instituteAffliate || student.originalHall.name,
            hallName: room.hall.name, roomCode: room.code, gender: room.gender, status: 'ACTIVE' };
        const result = previous
            ? yield tx.residenceAssignment.update({ where: { id: previous.id }, data: Object.assign(Object.assign({}, data), { version: { increment: 1 } }) })
            : yield tx.residenceAssignment.create({ data: Object.assign(Object.assign({}, data), { createdBy: actor }) });
        yield tx.residenceAssignmentEvent.create({ data: { assignmentId: result.id, action: previous ? 'REASSIGNED' : 'ASSIGNED', actor, reason,
                snapshot: (0, exports.clean)({ before: previous || null, after: result }) } });
        return result;
    });
}
function releaseRoom(tx, id, body, actor) {
    return __awaiter(this, void 0, void 0, function* () {
        const session = yield currentSession(tx, text(body.sessionId, 'Semester'));
        let record = yield tx.residenceAssignment.findUnique({ where: { id } });
        if (!record)
            throw new ResidenceError('Placement not found.', 404);
        yield lockStudent(tx, record.studentId);
        record = yield tx.residenceAssignment.findUnique({ where: { id } });
        yield tx.$queryRaw `SELECT id FROM ais_hall_room WHERE id = ${record.roomId} FOR UPDATE`;
        if (record.academicYear !== academicYear(session))
            throw new ResidenceError('Historical academic-year placements cannot be changed.');
        const reason = text(body.reason, 'Release reason', 1000);
        const count = yield tx.residenceAssignment.updateMany({ where: { id, version: positive(body.version, 'Version'), status: 'ACTIVE' }, data: { status: 'RELEASED', version: { increment: 1 } } });
        if (!count.count)
            throw new ResidenceError('The placement changed or is already released. Refresh and try again.', 409);
        const result = yield tx.residenceAssignment.findUnique({ where: { id } });
        yield tx.residenceAssignmentEvent.create({ data: { assignmentId: id, action: 'RELEASED', actor, reason, snapshot: (0, exports.clean)({ before: record, after: result }) } });
        return result;
    });
}
