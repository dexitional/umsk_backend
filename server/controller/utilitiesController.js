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
const utilities_1 = require("../util/utilities");
const handler = (fn) => (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        return yield fn(req, res);
    }
    catch (e) {
        if (e instanceof utilities_1.UtilityError)
            return res.status(e.status).json({ message: e.message });
        if ((e === null || e === void 0 ? void 0 : e.code) === 'P2002')
            return res.status(409).json({ message: 'A record with these details already exists.' });
        if ((e === null || e === void 0 ? void 0 : e.code) === 'P2003')
            return res.status(409).json({ message: 'This record is in use. Deactivate it instead of deleting it.' });
        if ((e === null || e === void 0 ? void 0 : e.code) === 'P2025')
            return res.status(404).json({ message: 'Record not found. Refresh and try again.' });
        if ((0, utilities_1.isWriteConflict)(e))
            return res.status(409).json({ message: 'Another update conflicted with this request. Refresh and try again.' });
        console.error('Utilities module:', e);
        return res.status(500).json({ message: 'The request could not be completed. Please try again or contact the administrator.' });
    }
});
const transaction = (fn) => client_1.prisma.$transaction(fn, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 20000 });
const audit = (tx, req, action, meta) => tx.log.create({ data: { action, user: req.userId, meta: JSON.parse(JSON.stringify(meta)) } });
const idOf = (req) => (0, utilities_1.text)(req.params.id, 'Record ID');
function existing(model, id, version, include) {
    return __awaiter(this, void 0, void 0, function* () {
        const record = yield model.findUnique(Object.assign({ where: { id } }, (include && { include })));
        if (!record)
            throw new utilities_1.UtilityError('Record not found.', 404);
        (0, utilities_1.checkVersion)(record, version);
        return record;
    });
}
function draft(tx, req) {
    return __awaiter(this, void 0, void 0, function* () {
        const id = idOf(req);
        yield tx.$queryRaw `SELECT id FROM ais_activity_progchange WHERE id = ${id} FOR UPDATE`;
        const record = yield existing(tx.activityProgchange, id, req.body.updatedAt);
        if (record.approved)
            throw new utilities_1.UtilityError('Approved changes are retained as history and cannot be edited or deleted.', 409);
        return record;
    });
}
class UtilitiesController {
    constructor() {
        this.options = handler((_req, res) => __awaiter(this, void 0, void 0, function* () {
            const [programs, sessions, majors] = yield Promise.all([
                client_1.prisma.program.findMany({ where: { status: true }, select: { id: true, longName: true, semesterTotal: true, hasMajor: true }, orderBy: { longName: 'asc' } }),
                client_1.prisma.session.findMany({ where: { status: true, default: true }, select: { id: true, title: true, semester: true } }),
                client_1.prisma.major.findMany({ where: { status: true }, select: { id: true, programId: true, longName: true, shortName: true } }),
            ]);
            return res.json({ modules: utilities_1.utilityModels, programs, sessions, majors });
        }));
        this.list = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const key = req.params.module, meta = (0, utilities_1.definition)(key), model = client_1.prisma[key];
            const search = (0, utilities_1.text)(req.query.search, 'Search', 100, false), page = (0, utilities_1.positive)(req.query.page || 1, 'Page');
            const where = {};
            if (search)
                where.OR = meta.fields.filter(f => f.type !== 'number').map(f => ({ [f.key]: { contains: search } }));
            if (req.query.status) {
                if (!['active', 'inactive'].includes(req.query.status))
                    throw new utilities_1.UtilityError('Invalid status filter.');
                where.status = req.query.status === 'active';
            }
            const [rows, total] = yield Promise.all([model.findMany({ where, orderBy: [{ [meta.order]: 'asc' }, { id: 'asc' }], skip: (page - 1) * 50, take: 50, include: { _count: true } }), model.count({ where })]);
            return res.json({ rows, total, page });
        }));
        this.save = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const key = req.params.module, meta = (0, utilities_1.definition)(key), data = (0, utilities_1.lookupData)(key, req.body), id = req.params.id ? idOf(req) : null;
            const record = yield transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const model = tx[key], before = id ? yield existing(model, id, req.body.updatedAt) : null;
                const duplicate = yield model.findFirst({ where: Object.assign(Object.assign({}, (id && { id: { not: id } })), { OR: meta.identity.filter(f => data[f] != null).map(f => ({ [f]: data[f] })) }) });
                if (duplicate)
                    throw new utilities_1.UtilityError('A record with this name or tag already exists. Edit or reactivate the existing record.', 409);
                const after = id ? yield model.update({ where: { id }, data: Object.assign(Object.assign({}, data), { updatedAt: (0, utilities_1.nextVersion)(before) }) }) : yield model.create({ data });
                yield audit(tx, req, 'UTILITY_' + (id ? 'UPDATED' : 'CREATED'), { module: key, before, after });
                return after;
            }));
            return res.status(id ? 200 : 201).json(record);
        }));
        this.remove = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const key = req.params.module;
            (0, utilities_1.definition)(key);
            return res.json(yield transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const model = tx[key], before = yield existing(model, idOf(req), req.body.updatedAt, { _count: true });
                if (Object.values(before._count).some(count => Number(count) > 0))
                    throw new utilities_1.UtilityError('This record is in use. Set it inactive to preserve existing records.', 409);
                yield model.delete({ where: { id: before.id } });
                yield audit(tx, req, 'UTILITY_DELETED', { module: key, before });
                return { deleted: true };
            })));
        }));
        this.students = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const search = (0, utilities_1.text)(req.query.search, 'Search', 100, false);
            if (!search || search.length < 2)
                return res.json([]);
            return res.json(yield client_1.prisma.student.findMany({ where: { OR: ['id', 'indexno', 'fname', 'lname'].map(f => ({ [f]: { contains: search } })) }, select: Object.assign(Object.assign({}, utilities_1.studentSelect), { program: { select: { longName: true } } }), take: 30, orderBy: { id: 'asc' } }));
        }));
        this.changes = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const page = (0, utilities_1.positive)(req.query.page || 1, 'Page'), search = (0, utilities_1.text)(req.query.search, 'Search', 100, false), where = {};
            if (req.query.status) {
                if (!['draft', 'approved'].includes(req.query.status))
                    throw new utilities_1.UtilityError('Invalid status filter.');
                where.approved = req.query.status === 'approved';
            }
            if (search)
                where.OR = [{ studentId: { contains: search } }, { oldIndexno: { contains: search } }, { newIndexno: { contains: search } }, { student: { fname: { contains: search } } }, { student: { lname: { contains: search } } }];
            const [rows, total] = yield Promise.all([client_1.prisma.activityProgchange.findMany({ where, include: utilities_1.changeInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 50, skip: (page - 1) * 50 }), client_1.prisma.activityProgchange.count({ where })]);
            return res.json({ rows, total, page });
        }));
        this.saveChange = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            const id = req.params.id ? idOf(req) : null;
            const data = { sessionId: (0, utilities_1.text)(req.body.sessionId, 'Academic session'), newProgramId: (0, utilities_1.text)(req.body.newProgramId, 'Destination program'), newSemesterNum: (0, utilities_1.positive)(req.body.newSemesterNum, 'Destination semester'), reason: (0, utilities_1.text)(req.body.reason, 'Reason', 255) };
            const record = yield transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const before = id ? yield draft(tx, req) : null;
                const studentId = (before === null || before === void 0 ? void 0 : before.studentId) || (0, utilities_1.text)(req.body.studentId, 'Student');
                const student = yield tx.student.findUnique({ where: { id: studentId } });
                yield (0, utilities_1.validateDestination)(tx, student, data);
                if (before && (before.oldProgramId !== student.programId || before.oldIndexno !== student.indexno))
                    throw new utilities_1.UtilityError('The student has changed program or index number. Delete this draft and create a new request.', 409);
                if (yield tx.activityProgchange.findFirst({ where: Object.assign({ studentId, approved: false }, (id && { id: { not: id } })) }))
                    throw new utilities_1.UtilityError('This student already has a draft program change. Edit that draft.', 409);
                const after = id ? yield tx.activityProgchange.update({ where: { id }, data: Object.assign(Object.assign({}, data), { updatedAt: (0, utilities_1.nextVersion)(before) }) }) : yield tx.activityProgchange.create({ data: Object.assign(Object.assign({}, data), { studentId, oldProgramId: student.programId, oldIndexno: student.indexno, newIndexno: student.indexno, approved: false }) });
                yield audit(tx, req, 'PROGRAM_CHANGE_' + (id ? 'UPDATED' : 'CREATED'), { before, after });
                return after;
            }));
            return res.status(id ? 200 : 201).json(record);
        }));
        this.deleteChange = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            return res.json(yield transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const before = yield draft(tx, req);
                yield tx.activityProgchange.delete({ where: { id: before.id } });
                yield audit(tx, req, 'PROGRAM_CHANGE_DELETED', before);
                return { deleted: true };
            })));
        }));
        this.approveChange = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            return res.json(yield transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                const record = yield draft(tx, req);
                // Locks also serialize this action against room assignment, affiliation and other student updates.
                yield tx.$queryRaw `SELECT id FROM ais_student WHERE id = ${record.studentId} FOR UPDATE`;
                const student = yield tx.student.findUnique({ where: { id: record.studentId } });
                if (!student || student.programId !== record.oldProgramId || student.indexno !== record.oldIndexno)
                    throw new utilities_1.UtilityError('The student changed after this request was created. Create a new draft.', 409);
                const snapshot = req.body.studentSnapshot;
                if (!snapshot || ['programId', 'majorId', 'semesterNum', 'indexno'].some(key => snapshot[key] !== student[key]))
                    throw new utilities_1.UtilityError('The student changed since this review was opened. Refresh before approving.', 409);
                if (record.newIndexno !== student.indexno)
                    throw new utilities_1.UtilityError('This legacy request changes the index number. Review it separately to preserve linked academic records.');
                const program = yield (0, utilities_1.validateDestination)(tx, student, record);
                let majorId = null;
                if (program.hasMajor) {
                    majorId = (0, utilities_1.text)(req.body.majorId, 'Destination major');
                    const major = yield tx.major.findUnique({ where: { id: majorId } });
                    if (!(major === null || major === void 0 ? void 0 : major.status) || major.programId !== program.id)
                        throw new utilities_1.UtilityError('Choose an active major in the destination program.');
                }
                const afterStudent = yield tx.student.update({ where: { id: student.id }, data: { programId: program.id, majorId, semesterNum: record.newSemesterNum } });
                const after = yield tx.activityProgchange.update({ where: { id: record.id }, data: { approved: true, approvedBy: req.userId, approvedAt: new Date(), updatedAt: (0, utilities_1.nextVersion)(record) } });
                yield audit(tx, req, 'PROGRAM_CHANGE_APPROVED', { before: record, after, studentBefore: { programId: student.programId, majorId: student.majorId, semesterNum: student.semesterNum }, studentAfter: { programId: afterStudent.programId, majorId: afterStudent.majorId, semesterNum: afterStudent.semesterNum } });
                return after;
            })));
        }));
    }
}
exports.default = UtilitiesController;
