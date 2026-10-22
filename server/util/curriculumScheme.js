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
exports.CurriculumSchemeError = void 0;
exports.selectCurriculum = selectCurriculum;
exports.curriculumRows = curriculumRows;
exports.registrationCourses = registrationCourses;
exports.curriculumClassMeta = curriculumClassMeta;
exports.curriculumSchemeId = curriculumSchemeId;
class CurriculumSchemeError extends Error {
    constructor() {
        super(...arguments);
        this.status = 400;
        this.code = 'CURRICULUM_SCHEME';
    }
}
exports.CurriculumSchemeError = CurriculumSchemeError;
// A major-specific mount overrides a common mount of the same course.
// Never resolve conflicting duplicate mounts by database row order.
function selectCurriculum(rows, courseId, majorId) {
    const candidates = rows.filter(r => r.courseId === courseId && (!r.majorId || r.majorId === majorId));
    const exact = majorId ? candidates.filter(r => r.majorId === majorId) : [];
    const matches = exact.length ? exact : candidates.filter(r => !r.majorId);
    if (!matches.length)
        throw new CurriculumSchemeError(`Course ${courseId} is not in the student's curriculum.`);
    if (matches.some(r => !r.schemeId))
        throw new CurriculumSchemeError(`Select a grading scheme on the curriculum for ${courseId} before registration.`);
    if (new Set(matches.map(r => r.schemeId)).size > 1)
        throw new CurriculumSchemeError(`Conflicting curriculum grading schemes for ${courseId}. Please contact Registry.`);
    return matches[0];
}
function curriculumRows(db, student, semesterNum) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!(student === null || student === void 0 ? void 0 : student.programId) || !Number.isInteger(semesterNum) || semesterNum < 1)
            throw new CurriculumSchemeError('A valid student programme and semester are required.');
        return db.structure.findMany({ where: { programId: student.programId, semesterNum, status: true,
                OR: [{ majorId: null }, ...(student.majorId ? [{ majorId: student.majorId }] : [])] },
            include: { course: { select: { title: true, creditHour: true } }, major: { select: { shortName: true } } } });
    });
}
function registrationCourses(db_1, student_1, courses_1, sessionId_1) {
    return __awaiter(this, arguments, void 0, function* (db, student, courses, sessionId, useCurrentSemester = true) {
        if (!(student === null || student === void 0 ? void 0 : student.indexno))
            throw new CurriculumSchemeError('Student with an index number not found.');
        const result = [];
        const cache = new Map();
        for (const course of courses) {
            const semesterNum = useCurrentSemester ? student.semesterNum : Number(course.semesterNum);
            if (!cache.has(semesterNum))
                cache.set(semesterNum, yield curriculumRows(db, student, semesterNum));
            const code = course.code || course.courseId;
            const mount = selectCurriculum(cache.get(semesterNum), code, student.majorId);
            // Ignore client-supplied scheme/credit/index/session values.
            result.push({ courseId: code, sessionId, schemeId: mount.schemeId, credit: mount.course.creditHour,
                semesterNum, indexno: student.indexno, type: 'N' });
        }
        if (new Set(result.map(r => r.courseId)).size !== result.length)
            throw new CurriculumSchemeError('A course can only be selected once.');
        return result;
    });
}
function curriculumClassMeta(db, student) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!(student === null || student === void 0 ? void 0 : student.programId))
            throw new CurriculumSchemeError('Student programme is missing.');
        const rows = yield db.structure.findMany({ where: { programId: student.programId, status: true,
                OR: [{ majorId: null }, ...(student.majorId ? [{ majorId: student.majorId }] : [])] }, include: { scheme: { select: { classMeta: true } } } });
        if (!rows.length || rows.some((r) => { var _a; return !((_a = r.scheme) === null || _a === void 0 ? void 0 : _a.classMeta); }))
            throw new CurriculumSchemeError('Curriculum classification scheme is missing.');
        // Course grade bands may differ; award classification bands must agree.
        const canonical = (value) => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object'
            ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
        const bands = new Set(rows.map((r) => canonical(r.scheme.classMeta)));
        if (bands.size !== 1)
            throw new CurriculumSchemeError('Curriculum schemes have conflicting award classifications. Review before importing graduation results.');
        return rows[0].scheme.classMeta;
    });
}
function curriculumSchemeId(db, body) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const value = (_a = body.schemeId) !== null && _a !== void 0 ? _a : body.scheme_id;
        if (typeof value !== 'string' || !value.trim())
            throw new CurriculumSchemeError('Select a grading scheme for this curriculum.');
        const scheme = yield db.scheme.findUnique({ where: { id: value.trim() }, select: { id: true } });
        if (!scheme)
            throw new CurriculumSchemeError('The selected grading scheme does not exist.');
        return scheme.id;
    });
}
