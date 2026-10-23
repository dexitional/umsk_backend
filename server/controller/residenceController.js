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
const residence_1 = require("../util/residence");
const sts_1 = require("../util/sts");
const handler = (fn) => (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        return yield fn(req, res);
    }
    catch (e) {
        if (e instanceof residence_1.ResidenceError)
            return res.status(e.status).json({ message: e.message });
        if ((e === null || e === void 0 ? void 0 : e.code) === 'P2002')
            return res.status(409).json({ message: 'This hall, room or student/year placement already exists. Refresh and edit the existing record.' });
        if ((e === null || e === void 0 ? void 0 : e.code) === 'P2003')
            return res.status(409).json({ message: 'This record is in use. Deactivate it to preserve affiliation and placement history.' });
        if ((e === null || e === void 0 ? void 0 : e.code) === 'P2025')
            return res.status(404).json({ message: 'Record not found. Refresh and try again.' });
        if (['P2034', 'P2028'].includes(e === null || e === void 0 ? void 0 : e.code))
            return res.status(409).json({ message: 'Another change conflicted with this request. Refresh and try again.' });
        console.error('Hall module:', e);
        return res.status(500).json({ message: 'Hall records could not be processed. Please try again or contact the administrator.' });
    }
});
const idOf = (req) => (0, residence_1.text)(req.params.id, 'Record ID');
const transaction = (fn) => client_1.prisma.$transaction(fn, residence_1.transactionOptions);
const audit = (tx, req, action, meta) => tx.log.create({ data: { action, user: req.userId, meta: (0, residence_1.clean)(meta) } });
function filters(query) {
    const where = {};
    for (const field of ['hallId', 'roomId', 'studentId'])
        if (query[field])
            where[field] = (0, residence_1.text)(query[field], field);
    if (query.academicYear)
        where.academicYear = (0, residence_1.academicYear)({ year: query.academicYear });
    if (query.status) {
        if (!['ACTIVE', 'RELEASED'].includes(query.status))
            throw new residence_1.ResidenceError('Invalid placement status.');
        where.status = query.status;
    }
    const search = (0, residence_1.text)(query.search, 'Search', 100, false);
    if (search)
        where.OR = ['studentName', 'studentId', 'indexno'].map(key => ({ [key]: { contains: search } }));
    return where;
}
class ResidenceController {
    constructor() {
        this.options = handler((_req, res) => __awaiter(this, void 0, void 0, function* () {
            const [halls, rooms, sessions, affiliations] = yield Promise.all([
                client_1.prisma.residenceHall.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { rooms: true, originalStudents: true, currentStudents: true } } } }),
                client_1.prisma.residenceRoom.findMany({ orderBy: [{ hallId: 'asc' }, { code: 'asc' }] }),
                client_1.prisma.session.findMany({ select: { id: true, title: true, year: true, semester: true, default: true, status: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
                client_1.prisma.student.groupBy({ by: ['currentHallId', 'gender'], where: { currentHallId: { not: null } }, _count: { _all: true } }),
            ]);
            return res.json({ halls: halls.map(h => (Object.assign(Object.assign({}, h), { genderConflicts: h.gender ? affiliations.filter(a => a.currentHallId === h.id && (0, residence_1.genderOf)(a.gender) !== h.gender).reduce((sum, a) => sum + a._count._all, 0) : 0, roomGenderConflicts: h.gender ? rooms.filter(r => r.hallId === h.id && r.gender !== h.gender).length : 0 }))), rooms, sessions });
        }));
        this.saveHall = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            var _a;
            const id = req.params.id ? idOf(req) : null;
            if (req.body.active !== undefined && typeof req.body.active !== 'boolean')
                throw new residence_1.ResidenceError('Active must be true or false.');
            const gender = (0, residence_1.genderOf)(req.body.gender);
            if (!gender)
                throw new residence_1.ResidenceError('Choose Male or Female for the hall.');
            const data = { gender, code: (0, residence_1.text)(req.body.code, 'Hall code', 50).toUpperCase(), name: (0, residence_1.text)(req.body.name, 'Hall name', 350), active: (_a = req.body.active) !== null && _a !== void 0 ? _a : true };
            const result = yield transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                if (id) {
                    yield tx.$queryRaw `SELECT id FROM ais_hall WHERE id = ${id} FOR UPDATE`;
                    const before = yield tx.residenceHall.findUnique({ where: { id }, include: { _count: { select: { rooms: true, originalStudents: true, currentStudents: true, assignments: true } } } });
                    if (!before)
                        throw new residence_1.ResidenceError('Hall not found.', 404);
                    if (before.gender && before.gender !== gender && Object.values(before._count).some((count) => count > 0))
                        throw new residence_1.ResidenceError('The gender of a hall with affiliations, rooms or placement history cannot be changed.');
                    const changed = yield tx.residenceHall.updateMany({ where: { id, version: (0, residence_1.positive)(req.body.version, 'Version') }, data: Object.assign(Object.assign({}, data), { version: { increment: 1 } }) });
                    if (!changed.count)
                        throw new residence_1.ResidenceError('The hall changed. Refresh before saving.', 409);
                }
                const record = id ? yield tx.residenceHall.findUnique({ where: { id } }) : yield tx.residenceHall.create({ data });
                yield audit(tx, req, id ? 'HALL_UPDATED' : 'HALL_CREATED', record);
                return record;
            }));
            return res.status(id ? 200 : 201).json(result);
        }));
        this.saveRoom = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            var _a;
            const id = req.params.id ? idOf(req) : null;
            const hallId = (0, residence_1.text)(req.body.hallId, 'Hall');
            const gender = (0, residence_1.genderOf)(req.body.gender);
            if (!gender)
                throw new residence_1.ResidenceError('Choose Male or Female for the room.');
            if (req.body.active !== undefined && typeof req.body.active !== 'boolean')
                throw new residence_1.ResidenceError('Active must be true or false.');
            const data = { hallId, code: (0, residence_1.text)(req.body.code, 'Room number', 50).toUpperCase(), gender, capacity: (0, residence_1.positive)(req.body.capacity, 'Capacity'), active: (_a = req.body.active) !== null && _a !== void 0 ? _a : true };
            if (data.capacity > 10000)
                throw new residence_1.ResidenceError('Capacity cannot exceed 10,000.');
            const result = yield transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                yield tx.$queryRaw `SELECT id FROM ais_hall WHERE id = ${hallId} FOR UPDATE`;
                const hall = yield tx.residenceHall.findUnique({ where: { id: hallId } });
                if (!hall)
                    throw new residence_1.ResidenceError('Hall not found.', 404);
                if (!hall.gender)
                    throw new residence_1.ResidenceError('Set the hall gender before adding or editing rooms.');
                if (hall.gender !== gender)
                    throw new residence_1.ResidenceError('The room gender must match its hall.');
                if (id) {
                    yield tx.$queryRaw `SELECT id FROM ais_hall_room WHERE id = ${id} FOR UPDATE`;
                    const before = yield tx.residenceRoom.findUnique({ where: { id } });
                    if (!before)
                        throw new residence_1.ResidenceError('Room not found.', 404);
                    if ((before.hallId !== hallId || before.gender !== gender) && (yield tx.residenceAssignment.count({ where: { roomId: id } })))
                        throw new residence_1.ResidenceError('A room with placement history cannot change hall or gender. Create a new room instead.');
                    const counts = yield tx.residenceAssignment.groupBy({ by: ['academicYear'], where: { roomId: id, status: 'ACTIVE' }, _count: { _all: true } });
                    if (counts.some((c) => c._count._all > data.capacity))
                        throw new residence_1.ResidenceError('Capacity cannot be lower than the recorded occupancy in an academic year.');
                    const changed = yield tx.residenceRoom.updateMany({ where: { id, version: (0, residence_1.positive)(req.body.version, 'Version') }, data: Object.assign(Object.assign({}, data), { version: { increment: 1 } }) });
                    if (!changed.count)
                        throw new residence_1.ResidenceError('The room changed. Refresh before saving.', 409);
                }
                const record = id ? yield tx.residenceRoom.findUnique({ where: { id } }) : yield tx.residenceRoom.create({ data });
                yield audit(tx, req, id ? 'HALL_ROOM_UPDATED' : 'HALL_ROOM_CREATED', record);
                return record;
            }));
            return res.status(id ? 200 : 201).json(result);
        }));
        this.deleteHall = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            return res.json(yield transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const record = yield tx.residenceHall.delete({ where: { id: idOf(req) } });
                yield audit(tx, req, 'HALL_DELETED', record);
                return { deleted: true };
            })));
        }));
        this.deleteRoom = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            return res.json(yield transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const record = yield tx.residenceRoom.delete({ where: { id: idOf(req) } });
                yield audit(tx, req, 'HALL_ROOM_DELETED', record);
                return { deleted: true };
            })));
        }));
        this.candidates = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const search = (0, residence_1.text)(req.query.search, 'Search', 100, false);
            if (!search || search.length < 2)
                return res.json([]);
            return res.json(yield client_1.prisma.student.findMany({ where: { OR: ['id', 'indexno', 'fname', 'lname'].map(key => ({ [key]: { contains: search } })) },
                select: { id: true, indexno: true, fname: true, mname: true, lname: true, gender: true, semesterNum: true, deferStatus: true, completeStatus: true, graduateStatus: true,
                    originalHallId: true, currentHallId: true, instituteAffliate: true, originalHallSource: true, originalHall: true, currentHall: true }, take: 50, orderBy: { id: 'asc' } }));
        }));
        this.recordOriginal = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            return res.json(yield transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const student = yield (0, residence_1.lockStudent)(tx, idOf(req));
                const hallId = (0, residence_1.text)(req.body.hallId, 'Original hall');
                yield tx.$queryRaw `SELECT id FROM ais_hall WHERE id = ${hallId} FOR UPDATE`;
                const hall = yield tx.residenceHall.findUnique({ where: { id: hallId } });
                const reason = (0, residence_1.text)(req.body.reason, 'Reason / source of original affiliation', 1000);
                return (0, residence_1.initialAffiliation)(tx, student, hall, req.userId, student.semesterNum === 1 ? 'ADMISSION' : 'REGISTRY_HISTORY', reason);
            })));
        }));
        this.assignments = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const where = filters(req.query);
            const page = (0, residence_1.positive)(req.query.page || 1, 'Page');
            const [rows, total] = yield Promise.all([client_1.prisma.residenceAssignment.findMany({ where, include: residence_1.assignmentInclude, orderBy: [{ academicYear: 'desc' }, { studentName: 'asc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 50 }), client_1.prisma.residenceAssignment.count({ where })]);
            return res.json({ rows, total, page });
        }));
        this.occupancy = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const year = (0, residence_1.academicYear)({ year: req.query.academicYear });
            const [rooms, counts] = yield Promise.all([
                client_1.prisma.residenceRoom.findMany({ include: { hall: true }, orderBy: [{ hallId: 'asc' }, { code: 'asc' }] }),
                client_1.prisma.residenceAssignment.groupBy({ by: ['roomId'], where: { academicYear: year, status: 'ACTIVE' }, _count: { _all: true } }),
            ]);
            const used = new Map(counts.map(c => [c.roomId, c._count._all]));
            return res.json(rooms.map(room => (Object.assign(Object.assign({}, room), { occupied: used.get(room.id) || 0, available: Math.max(0, room.capacity - (used.get(room.id) || 0)) }))));
        }));
        this.assign = handler((req, res) => __awaiter(this, void 0, void 0, function* () { return res.status(req.params.id ? 200 : 201).json(yield transaction(tx => (0, residence_1.assignRoom)(tx, req.body, req.userId, req.params.id ? idOf(req) : undefined))); }));
        this.release = handler((req, res) => __awaiter(this, void 0, void 0, function* () { return res.json(yield transaction(tx => (0, residence_1.releaseRoom)(tx, idOf(req), req.body, req.userId))); }));
        this.history = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const id = idOf(req);
            const student = yield client_1.prisma.student.findUnique({ where: { id }, select: { id: true, instituteAffliate: true, originalHall: true, currentHall: true, originalHallSource: true } });
            if (!student)
                throw new residence_1.ResidenceError('Student not found.', 404);
            const [assignments, affiliations] = yield Promise.all([
                client_1.prisma.residenceAssignment.findMany({ where: { studentId: id }, include: Object.assign(Object.assign({}, residence_1.assignmentInclude), { events: { orderBy: { createdAt: 'asc' } } }), orderBy: { academicYear: 'desc' } }),
                client_1.prisma.hallAffiliationEvent.findMany({ where: { studentId: id }, orderBy: { createdAt: 'asc' } }),
            ]);
            return res.json({ student, assignments, affiliations });
        }));
        this.mine = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            if (Number(req.groupId) !== 1)
                throw new residence_1.ResidenceError('This page is for student accounts.', 403);
            const [student, session] = yield Promise.all([
                client_1.prisma.student.findUnique({ where: { id: req.userId }, select: { instituteAffliate: true, originalHall: true, currentHall: true, originalHallSource: true } }),
                client_1.prisma.session.findFirst({ where: { default: true, status: true }, select: { title: true, year: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
            ]);
            if (!student)
                throw new residence_1.ResidenceError('Student record not found.', 404);
            const year = session ? (0, residence_1.academicYear)(session) : null;
            const placement = year ? yield client_1.prisma.residenceAssignment.findUnique({ where: { studentId_academicYear: { studentId: req.userId, academicYear: year } }, select: { academicYear: true, hallName: true, roomCode: true, gender: true, status: true } }) : null;
            return res.json({ student, session, academicYear: year, placement });
        }));
        this.report = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const where = filters(req.query);
            if ((yield client_1.prisma.residenceAssignment.count({ where })) > 20000)
                throw new residence_1.ResidenceError('Narrow the report filters to 20,000 placements or fewer.');
            const rows = yield client_1.prisma.residenceAssignment.findMany({ where, orderBy: [{ academicYear: 'desc' }, { studentName: 'asc' }], take: 20000 });
            const data = [['Student ID', 'Index number', 'Student', 'Academic year', 'Semester at assignment', 'Original hall', 'Assigned hall', 'Room', 'Gender', 'Status'], ...rows.map(r => [r.studentId, r.indexno, r.studentName, r.academicYear, r.semesterNum, r.originalHallName, r.hallName, r.roomCode, r.gender, r.status])];
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="hall-placements.csv"');
            return res.send('\uFEFF' + data.map(row => row.map(sts_1.csvCell).join(',')).join('\r\n'));
        }));
    }
}
exports.default = ResidenceController;
