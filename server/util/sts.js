"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stsMentorScope = exports.stsAdmin = exports.STS_ADMIN_ROLES = exports.STSError = void 0;
exports.textField = textField;
exports.positiveInt = positiveInt;
exports.eligibility = eligibility;
exports.schoolData = schoolData;
exports.mentorData = mentorData;
exports.csvCell = csvCell;
class STSError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
exports.STSError = STSError;
exports.STS_ADMIN_ROLES = ['sts::admin', 'student::admin', 'student::registry'];
const stsAdmin = (req) => Number(req.groupId) === 2 &&
    (req.roles || []).some((r) => exports.STS_ADMIN_ROLES.includes(r.role));
exports.stsAdmin = stsAdmin;
const stsMentorScope = (req) => ({ mentor: { accountTag: req.userId, active: true } });
exports.stsMentorScope = stsMentorScope;
function textField(value, label, max, required = false) {
    if (value == null || value === '') {
        if (required)
            throw new STSError(`${label} is required.`);
        return null;
    }
    if (typeof value !== 'string' || value.trim().length > max)
        throw new STSError(`${label} must be text of at most ${max} characters.`);
    const result = value.trim();
    if (required && !result)
        throw new STSError(`${label} is required.`);
    return result || null;
}
function positiveInt(value, label) {
    if (!/^[1-9]\d*$/.test(String(value)))
        throw new STSError(`${label} must be a positive whole number.`);
    const result = Number(value);
    if (!Number.isSafeInteger(result))
        throw new STSError(`${label} is invalid.`);
    return result;
}
function eligibility(student) {
    var _a;
    if (!student)
        return 'Student not found.';
    if (student.deferStatus || student.completeStatus || student.graduateStatus)
        return 'Deferred, completed or graduated students cannot be assigned.';
    const sem = student.semesterNum, total = (_a = student.program) === null || _a === void 0 ? void 0 : _a.semesterTotal;
    if (!Number.isInteger(sem) || sem < 1 || !Number.isInteger(total) || total < sem)
        return 'The student needs a valid semester and programme duration.';
    const year = Math.ceil(sem / 2);
    if (year > 4)
        return 'STS assignments are available for Years 1 to 4.';
    if (year === 4 && sem === total)
        return 'Year 4 students cannot be assigned in their final programme semester.';
    return null;
}
function schoolData(body) {
    var _a;
    if (body.active !== undefined && typeof body.active !== 'boolean')
        throw new STSError('Active must be true or false.');
    return { code: textField(body.code, 'School code', 50, true).toUpperCase(), name: textField(body.name, 'School name', 255, true),
        district: textField(body.district, 'District', 255), address: textField(body.address, 'Address', 500), phone: textField(body.phone, 'Phone', 30),
        active: (_a = body.active) !== null && _a !== void 0 ? _a : true };
}
function mentorData(body) {
    var _a;
    if (body.active !== undefined && typeof body.active !== 'boolean')
        throw new STSError('Active must be true or false.');
    const email = textField(body.email, 'Email', 255);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new STSError('Enter a valid mentor email address.');
    return { schoolId: textField(body.schoolId, 'School', 191, true), name: textField(body.name, 'Mentor name', 255, true),
        phone: textField(body.phone, 'Phone', 30), email, accountTag: textField(body.accountTag, 'Staff account tag', 50), active: (_a = body.active) !== null && _a !== void 0 ? _a : true };
}
function csvCell(value) {
    let text = String(value !== null && value !== void 0 ? value : '');
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))
        text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
}
