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
const client_1 = require("../prisma/client");
const auditLog_1 = require("../util/auditLog");
const sts_1 = require("../util/sts");
const studentSelect = { id: true, indexno: true, fname: true, mname: true, lname: true, semesterNum: true,
    programId: true, deferStatus: true, completeStatus: true, graduateStatus: true,
    program: { select: { id: true, longName: true, semesterTotal: true } } };
const include = { session: { select: { id: true, title: true, semester: true, default: true, status: true } },
    school: { select: { id: true, name: true, address: true, district: true, phone: true, active: true } },
    mentor: { select: { id: true, name: true, phone: true, email: true, active: true } } };
const nameOf = (s) => [s.fname, s.mname, s.lname].filter(Boolean).join(' ');
const idOf = (req) => (0, sts_1.textField)(req.params.id, 'Record ID', 191, true);
const plain = (v) => JSON.parse(JSON.stringify(v));
// All mutation failures are caught here, including transaction conflicts and missing migrations.
const handler = (fn) => (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        return yield fn(req, res);
    }
    catch (error) {
        if (error instanceof sts_1.STSError)
            return res.status(error.status).json({ message: error.message });
        if ((error === null || error === void 0 ? void 0 : error.code) === 'P2002')
            return res.status(409).json({ message: 'This school code or student/semester placement already exists. Refresh and edit the existing record.' });
        if ((error === null || error === void 0 ? void 0 : error.code) === 'P2003')
            return res.status(409).json({ message: 'This record is in use. Deactivate it to preserve placement history.' });
        if ((error === null || error === void 0 ? void 0 : error.code) === 'P2025')
            return res.status(404).json({ message: 'The requested STS record no longer exists.' });
        if ((error === null || error === void 0 ? void 0 : error.code) === 'P2034')
            return res.status(409).json({ message: 'Another update conflicted with this request. Refresh and try again.' });
        console.error('STS request failed:', (error === null || error === void 0 ? void 0 : error.code) || (error === null || error === void 0 ? void 0 : error.name));
        return res.status(500).json({ message: 'STS could not complete this request. Please try again or contact the administrator.' });
    }
});
function currentSession(tx, sessionId) {
    return __awaiter(this, void 0, void 0, function* () {
        // Lock the selected session so a concurrent calendar activation cannot change it mid-assignment.
        yield tx.$queryRaw `SELECT id FROM ais_session WHERE id = ${sessionId} FOR UPDATE`;
        const session = yield tx.session.findUnique({ where: { id: sessionId } });
        if (!(session === null || session === void 0 ? void 0 : session.default) || !session.status)
            throw new sts_1.STSError('New assignments and reassignments must use the active default academic semester.');
        return session;
    });
}
function placementData(tx, body) {
    return __awaiter(this, void 0, void 0, function* () {
        const studentId = (0, sts_1.textField)(body.studentId, 'Student', 191, true);
        const sessionId = (0, sts_1.textField)(body.sessionId, 'Semester', 191, true);
        const schoolId = (0, sts_1.textField)(body.schoolId, 'School', 191, true);
        const mentorId = (0, sts_1.textField)(body.mentorId, 'Mentor', 191, true);
        const session = yield currentSession(tx, sessionId);
        yield tx.$queryRaw `SELECT id FROM ais_student WHERE id = ${studentId} FOR UPDATE`;
        yield tx.$queryRaw `SELECT id FROM ais_sts_school WHERE id = ${schoolId} FOR UPDATE`;
        yield tx.$queryRaw `SELECT id FROM ais_sts_mentor WHERE id = ${mentorId} FOR UPDATE`;
        const student = yield tx.student.findUnique({ where: { id: studentId }, select: studentSelect });
        const error = (0, sts_1.eligibility)(student);
        if (error)
            throw new sts_1.STSError(error);
        if ((student.semesterNum % 2 === 1 ? 'SEM1' : 'SEM2') !== session.semester)
            throw new sts_1.STSError('The student semester does not match the active academic semester. Check student progression first.');
        const school = yield tx.stsSchool.findUnique({ where: { id: schoolId } });
        const mentor = yield tx.stsMentor.findUnique({ where: { id: mentorId } });
        if (!(school === null || school === void 0 ? void 0 : school.active))
            throw new sts_1.STSError('Choose an active school.');
        if (!(mentor === null || mentor === void 0 ? void 0 : mentor.active) || mentor.schoolId !== schoolId)
            throw new sts_1.STSError('Choose an active mentor at the selected school.');
        return { studentId, sessionId, schoolId, mentorId, semesterNum: student.semesterNum, yearGroup: Math.ceil(student.semesterNum / 2),
            programId: student.programId, programName: student.program.longName, studentName: nameOf(student), indexno: student.indexno,
            schoolName: school.name, mentorName: mentor.name };
    });
}
function assignmentWhere(req) {
    const q = req.query;
    const where = (0, sts_1.stsAdmin)(req) ? {} : (0, sts_1.stsMentorScope)(req);
    for (const key of ['sessionId', 'schoolId', 'mentorId', 'programId', 'studentId']) {
        if (q[key])
            where[key] = (0, sts_1.textField)(q[key], key, 191, true);
    }
    if (q.yearGroup) {
        const year = (0, sts_1.positiveInt)(q.yearGroup, 'Year');
        if (year > 4)
            throw new sts_1.STSError('Choose Year 1 to 4.');
        where.yearGroup = year;
    }
    if (q.status) {
        if (!['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(q.status))
            throw new sts_1.STSError('Invalid placement status.');
        where.status = q.status;
    }
    const search = (0, sts_1.textField)(q.search, 'Search', 100);
    if (search)
        where.OR = [{ studentName: { contains: search } }, { indexno: { contains: search } }, { studentId: { contains: search } }];
    return where;
}
class StsController {
    constructor() {
        this.options = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const admin = (0, sts_1.stsAdmin)(req);
            const [sessions, programs, schools] = yield Promise.all([
                client_1.prisma.session.findMany({ select: { id: true, title: true, semester: true, default: true, status: true }, orderBy: { createdAt: 'desc' } }),
                client_1.prisma.program.findMany({ select: { id: true, longName: true }, orderBy: { longName: 'asc' } }),
                client_1.prisma.stsSchool.findMany({ where: admin ? {} : { mentors: { some: { accountTag: req.userId, active: true } } },
                    include: { mentors: { where: admin ? {} : { accountTag: req.userId, active: true }, orderBy: { name: 'asc' } },
                        _count: { select: { assignments: true } } }, orderBy: { name: 'asc' } }),
            ]);
            return res.json({ sessions, programs, schools, canManage: admin });
        }));
        this.saveSchool = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const data = (0, sts_1.schoolData)(req.body);
            const row = req.params.id ? yield client_1.prisma.stsSchool.update({ where: { id: idOf(req) }, data }) : yield client_1.prisma.stsSchool.create({ data });
            yield (0, auditLog_1.logRecords)(req, 'STS_SCHOOL_SAVE', 'ais_sts_school', [row]);
            return res.status(req.params.id ? 200 : 201).json(row);
        }));
        this.deleteSchool = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const row = yield client_1.prisma.stsSchool.delete({ where: { id: idOf(req) } });
            yield (0, auditLog_1.logRecords)(req, 'STS_SCHOOL_DELETE', 'ais_sts_school', [row]);
            return res.json({ message: 'School deleted.' });
        }));
        this.saveMentor = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const data = (0, sts_1.mentorData)(req.body);
            const row = yield client_1.prisma.$transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                yield tx.$queryRaw `SELECT id FROM ais_sts_school WHERE id = ${data.schoolId} FOR UPDATE`;
                const school = yield tx.stsSchool.findUnique({ where: { id: data.schoolId } });
                if (!school || (data.active && !school.active))
                    throw new sts_1.STSError('Choose an active school for an active mentor.');
                if (data.accountTag) {
                    const account = yield tx.user.findUnique({ where: { tag: data.accountTag }, select: { status: true, groupId: true } });
                    if (!(account === null || account === void 0 ? void 0 : account.status) || account.groupId !== 2)
                        throw new sts_1.STSError('The linked account must be an active staff account.');
                }
                if (!req.params.id)
                    return tx.stsMentor.create({ data });
                const id = idOf(req);
                yield tx.$queryRaw `SELECT id FROM ais_sts_mentor WHERE id = ${id} FOR UPDATE`;
                const before = yield tx.stsMentor.findUnique({ where: { id }, include: { _count: { select: { assignments: true } } } });
                if (!before)
                    throw new sts_1.STSError('Mentor not found.', 404);
                if (before.schoolId !== data.schoolId && before._count.assignments)
                    throw new sts_1.STSError('This mentor has placement history. Deactivate this record and create a mentor record at the new school.', 409);
                return tx.stsMentor.update({ where: { id }, data });
            }));
            yield (0, auditLog_1.logRecords)(req, 'STS_MENTOR_SAVE', 'ais_sts_mentor', [row]);
            return res.status(req.params.id ? 200 : 201).json(row);
        }));
        this.deleteMentor = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const row = yield client_1.prisma.stsMentor.delete({ where: { id: idOf(req) } });
            yield (0, auditLog_1.logRecords)(req, 'STS_MENTOR_DELETE', 'ais_sts_mentor', [row]);
            return res.json({ message: 'Mentor deleted.' });
        }));
        this.candidates = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const search = (0, sts_1.textField)(req.query.search, 'Search', 100, true);
            if (search.length < 2)
                throw new sts_1.STSError('Enter at least two characters to search for a student.');
            const rows = yield client_1.prisma.student.findMany({ where: { OR: [{ id: { contains: search } }, { indexno: { contains: search } },
                        { fname: { contains: search } }, { lname: { contains: search } }] }, select: studentSelect, orderBy: { id: 'asc' }, take: 50 });
            return res.json(rows.map(s => (Object.assign(Object.assign({}, s), { name: nameOf(s), ineligibleReason: (0, sts_1.eligibility)(s) }))));
        }));
        this.assignments = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const where = assignmentWhere(req);
            const page = req.query.page ? (0, sts_1.positiveInt)(req.query.page, 'Page') : 1;
            const [rows, total, counts] = yield client_1.prisma.$transaction([
                client_1.prisma.stsAssignment.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 50 }),
                client_1.prisma.stsAssignment.count({ where }),
                client_1.prisma.stsAssignment.groupBy({ by: ['status'], orderBy: { status: 'asc' }, where, _count: { _all: true } }),
            ]);
            return res.json({ rows, total, page, pageSize: 50, counts });
        }));
        this.history = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const row = yield client_1.prisma.stsAssignment.findFirst({ where: Object.assign({ id: idOf(req) }, ((0, sts_1.stsAdmin)(req) ? {} : (0, sts_1.stsMentorScope)(req))),
                include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
            if (!row)
                throw new sts_1.STSError('Placement not found.', 404);
            return res.json(row.events);
        }));
        this.createAssignment = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const notes = (0, sts_1.textField)(req.body.notes, 'Notes', 5000);
            const row = yield client_1.prisma.$transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const data = yield placementData(tx, req.body);
                const created = yield tx.stsAssignment.create({ data: Object.assign(Object.assign({}, data), { notes, createdBy: req.userId }) });
                yield tx.stsAssignmentEvent.create({ data: { assignmentId: created.id, action: 'ASSIGNED', actor: req.userId, snapshot: plain(created) } });
                return created;
            }));
            return res.status(201).json(row);
        }));
        this.updateAssignment = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const id = idOf(req), version = (0, sts_1.positiveInt)(req.body.version, 'Version');
            const admin = (0, sts_1.stsAdmin)(req);
            const row = yield client_1.prisma.$transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const before = yield tx.stsAssignment.findFirst({ where: Object.assign({ id }, (admin ? {} : (0, sts_1.stsMentorScope)(req))) });
                if (!before)
                    throw new sts_1.STSError('Placement not found.', 404);
                if (before.version !== version)
                    throw new sts_1.STSError('This placement has changed. Refresh before saving.', 409);
                const reassign = req.body.schoolId !== undefined || req.body.mentorId !== undefined;
                if (!admin && (reassign || req.body.status === 'CANCELLED' || before.status === 'CANCELLED'))
                    throw new sts_1.STSError('Only an STS coordinator can reassign or cancel a placement.', 403);
                const reason = (0, sts_1.textField)(req.body.reason, 'Reason', 1000, reassign || req.body.status === 'CANCELLED');
                const data = { version: { increment: 1 } };
                if (reassign) {
                    // The student/session and academic snapshots of an existing placement never change.
                    const placement = yield placementData(tx, Object.assign(Object.assign({}, req.body), { studentId: before.studentId, sessionId: before.sessionId }));
                    if (placement.semesterNum !== before.semesterNum || placement.programId !== before.programId)
                        throw new sts_1.STSError('The student has progressed or changed programme since this placement. Start a new placement in the correct semester.');
                    Object.assign(data, { schoolId: placement.schoolId, mentorId: placement.mentorId, schoolName: placement.schoolName, mentorName: placement.mentorName, status: 'ACTIVE' });
                }
                if (req.body.status !== undefined) {
                    if (!['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(req.body.status))
                        throw new sts_1.STSError('Invalid placement status.');
                    if (before.status === 'CANCELLED' && !reassign && req.body.status !== 'CANCELLED')
                        throw new sts_1.STSError('Use Reassign to restore a cancelled placement.');
                    data.status = req.body.status;
                }
                if (req.body.notes !== undefined)
                    data.notes = (0, sts_1.textField)(req.body.notes, 'Notes', 5000);
                if (!reassign && req.body.notes === undefined && req.body.status === undefined)
                    throw new sts_1.STSError('No placement changes supplied.');
                const changed = yield tx.stsAssignment.updateMany({ where: Object.assign({ id, version }, (admin ? {} : (0, sts_1.stsMentorScope)(req))), data });
                if (!changed.count)
                    throw new sts_1.STSError('This placement has changed. Refresh before saving.', 409);
                const updated = yield tx.stsAssignment.findUniqueOrThrow({ where: { id } });
                yield tx.stsAssignmentEvent.create({ data: { assignmentId: id, action: reassign ? 'REASSIGNED' : req.body.status === 'CANCELLED' ? 'CANCELLED' : 'UPDATED',
                        actor: req.userId, reason, snapshot: plain(updated) } });
                return updated;
            }));
            return res.json(row);
        }));
        this.report = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const rows = yield client_1.prisma.stsAssignment.findMany({ where: assignmentWhere(req), include, orderBy: [{ sessionId: 'asc' }, { studentName: 'asc' }], take: 10001 });
            if (rows.length > 10000)
                throw new sts_1.STSError('This report exceeds 10,000 placements. Filter by semester, school or year and try again.', 413);
            const headings = ['Academic semester', 'Student ID', 'Index number', 'Student', 'Programme', 'Year', 'Student semester', 'School', 'Mentor', 'Status', 'Notes'];
            const lines = rows.map(r => [r.session.title, r.studentId, r.indexno, r.studentName, r.programName, r.yearGroup, r.semesterNum, r.schoolName, r.mentorName, r.status, r.notes]);
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="STS-placements.csv"');
            return res.send('\uFEFF' + [headings, ...lines].map(row => row.map(sts_1.csvCell).join(',')).join('\r\n'));
        }));
        this.current = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            if (Number(req.groupId) !== 1)
                throw new sts_1.STSError('This page is for student accounts.', 403);
            const session = yield client_1.prisma.session.findFirst({ where: { default: true, status: true },
                select: { id: true, title: true, semester: true }, orderBy: { createdAt: 'desc' } });
            if (!session)
                return res.json({ session: null, placement: null });
            const placement = yield client_1.prisma.stsAssignment.findFirst({ where: { studentId: req.userId, sessionId: session.id,
                    status: { in: ['ACTIVE', 'COMPLETED'] } }, include });
            return res.json({ session, placement });
        }));
        this.mine = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            if (Number(req.groupId) !== 1)
                throw new sts_1.STSError('This page is for student accounts.', 403);
            return res.json(yield client_1.prisma.stsAssignment.findMany({ where: { studentId: req.userId }, include, orderBy: { createdAt: 'desc' } }));
        }));
    }
}
exports.default = StsController;
