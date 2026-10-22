"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.numeric = numeric;
exports.gradeBand = gradeBand;
exports.assessmentGrade = assessmentGrade;
exports.academicTotals = academicTotals;
exports.transcriptGroups = transcriptGroups;
// Shared by transcripts and graduation processing. Stored scores are never rounded.
function numeric(value) {
    if (value == null || (typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '')
        return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
function gradeBand(score, grades) {
    var _a;
    const value = numeric(score);
    if (value == null || !Array.isArray(grades))
        return null;
    const bands = grades.map((band) => (Object.assign(Object.assign({}, band), { min: numeric(band.min), max: numeric(band.max), gradepoint: numeric(band.gradepoint) })))
        .sort((a, b) => a.min - b.min);
    if (!bands.length || bands.some((b) => b.min == null || b.max == null || b.min > b.max || b.gradepoint == null || b.gradepoint < 0 || !b.grade))
        return null;
    // Adjacent whole-mark bands such as 50–54 and 55–59 cover decimals up to 55.
    // Do not bridge genuinely missing bands or extend beyond the scheme's maximum.
    return (_a = bands.find((band, i) => {
        const next = bands[i + 1];
        const continuous = next && next.min > band.max && next.min <= band.max + 1;
        return value >= band.min && (continuous ? value < next.min : value <= band.max);
    })) !== null && _a !== void 0 ? _a : null;
}
function assessmentGrade(row) {
    var _a;
    const incomplete = row.totalScore == null;
    const band = gradeBand(row.totalScore, (_a = row.scheme) === null || _a === void 0 ? void 0 : _a.gradeMeta);
    const credit = numeric(row.credit);
    const valid = !incomplete && !!band && !['I', 'IC'].includes(String(band.grade).toUpperCase()) && credit != null && credit >= 0;
    const exclusionReason = incomplete ? 'Incomplete' : !valid ? 'Invalid grade or credit' : row.status !== true ? 'Unpublished' : null;
    return {
        grade: incomplete ? 'I' : valid ? band.grade : 'Invalid',
        gradepoint: valid ? band.gradepoint : null,
        validGrade: valid,
        includedInGpa: exclusionReason == null,
        exclusionReason,
    };
}
function academicTotals(rows) {
    var _a;
    let credit = 0, gradepoint = 0, incomplete = 0, invalid = 0, unpublished = 0;
    const failed = new Set(), passed = new Set();
    for (const row of rows) {
        const result = assessmentGrade(row);
        if (row.totalScore == null)
            incomplete++;
        else if (!result.validGrade)
            invalid++;
        if (row.status !== true)
            unpublished++;
        if (!result.includedInGpa)
            continue;
        credit += Number(row.credit);
        gradepoint += Number(row.credit) * result.gradepoint;
        const passMark = numeric((_a = row.scheme) === null || _a === void 0 ? void 0 : _a.passMark);
        if (passMark != null && row.courseId) {
            const course = String(row.courseId).trim().toUpperCase();
            (Number(row.totalScore) >= passMark ? passed : failed).add(course);
        }
    }
    const cgpa = credit ? Number((gradepoint / credit).toFixed(2)) : null;
    return { credit, gradepoint, gpa: cgpa, cgpa, incomplete, invalid, unpublished,
        failedCourses: [...failed].filter(course => !passed.has(course)).length };
}
function transcriptGroups(rows) {
    var _a, _b, _c, _d;
    const groups = new Map();
    for (const row of rows) {
        // Sessions with the same display title must still have separate totals.
        const key = row.sessionId;
        const group = (_a = groups.get(key)) !== null && _a !== void 0 ? _a : { title: (_c = (_b = row.session) === null || _b === void 0 ? void 0 : _b.title) !== null && _c !== void 0 ? _c : 'none', rows: [] };
        group.rows.push(Object.assign(Object.assign(Object.assign({}, row), assessmentGrade(row)), { classes: (_d = row.scheme) === null || _d === void 0 ? void 0 : _d.classMeta }));
        groups.set(key, group);
    }
    const cumulative = [];
    return [...groups.values()].map(({ title, rows }) => {
        cumulative.push(...rows);
        const semester = academicTotals(rows), total = academicTotals(cumulative);
        return [title, rows, Object.assign(Object.assign({}, semester), { cgpa: total.cgpa, cumulativeCredit: total.credit, cumulativeGradepoint: total.gradepoint, cumulativeIncomplete: total.incomplete, cumulativeInvalid: total.invalid, cumulativeUnpublished: total.unpublished, failedCourses: total.failedCourses })];
    });
}
