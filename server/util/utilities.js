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
exports.changeInclude = exports.studentSelect = exports.nextVersion = exports.utilityModels = exports.UtilityError = exports.UTILITY_ROLES = void 0;
exports.isWriteConflict = isWriteConflict;
exports.definition = definition;
exports.text = text;
exports.positive = positive;
exports.lookupData = lookupData;
exports.checkVersion = checkVersion;
exports.validateDestination = validateDestination;
exports.UTILITY_ROLES = ['utilities::admin', 'student::admin', 'student::registry'];
class UtilityError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
exports.UtilityError = UtilityError;
function isWriteConflict(error) {
    var _a, _b, _c, _d;
    const cause = (_b = (_a = error === null || error === void 0 ? void 0 : error.meta) === null || _a === void 0 ? void 0 : _a.driverAdapterError) === null || _b === void 0 ? void 0 : _b.cause;
    return ['P2034', 'P2028'].includes(error === null || error === void 0 ? void 0 : error.code) || ((error === null || error === void 0 ? void 0 : error.code) === 'P2010' && ((cause === null || cause === void 0 ? void 0 : cause.kind) === 'TransactionWriteConflict' || [1205, 1213].includes(Number((_c = cause === null || cause === void 0 ? void 0 : cause.code) !== null && _c !== void 0 ? _c : (_d = error === null || error === void 0 ? void 0 : error.meta) === null || _d === void 0 ? void 0 : _d.code))));
}
const named = (title) => ({ title, fields: [{ key: 'title', label: 'Name', max: 255, required: true }], identity: ['title'], order: 'title' });
exports.utilityModels = {
    religion: named('Religion'),
    region: { title: 'Region', fields: [{ key: 'tag', label: 'Tag', max: 50, required: true }, { key: 'title', label: 'Name', max: 255, required: true }], identity: ['tag', 'title'], order: 'title' },
    disability: named('Disability'),
    title: { title: 'Title', fields: [{ key: 'tag', label: 'Tag', max: 50, required: true }, { key: 'label', label: 'Label', max: 50, required: true }], identity: ['tag', 'label'], order: 'label' },
    country: { title: 'Country', fields: [{ key: 'code', label: 'Country code', type: 'number' }, { key: 'shortName', label: 'Short name', max: 10 }, { key: 'longName', label: 'Country name', max: 255, required: true }, { key: 'nationality', label: 'Nationality', max: 300 }], identity: ['shortName', 'longName'], order: 'longName' },
    marital: named('Marital status'),
    relation: named('Relation'),
};
function definition(key) {
    if (!Object.prototype.hasOwnProperty.call(exports.utilityModels, key))
        throw new UtilityError('Unknown utility module.', 404);
    return exports.utilityModels[key];
}
function text(value, label, max = 255, required = true) {
    if (value === undefined || value === null || value === '') {
        if (!required)
            return null;
        throw new UtilityError(`${label} is required.`);
    }
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
        throw new UtilityError(`${label} must contain 1–${max} characters.`);
    return value.trim();
}
function positive(value, label) {
    if (!['string', 'number'].includes(typeof value) || String(value).trim() === '')
        throw new UtilityError(`${label} must be a positive whole number.`);
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647)
        throw new UtilityError(`${label} must be a positive whole number.`);
    return n;
}
function lookupData(key, body) {
    var _a;
    const meta = definition(key);
    const data = {};
    for (const field of meta.fields) {
        const value = body[field.key];
        data[field.key] = field.type === 'number' ? (value === '' || value == null ? null : positive(value, field.label)) : text(value, field.label, field.max, !!field.required);
    }
    if (body.status !== undefined && typeof body.status !== 'boolean')
        throw new UtilityError('Status must be true or false.');
    data.status = (_a = body.status) !== null && _a !== void 0 ? _a : true;
    return data;
}
function checkVersion(record, value) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
        throw new UtilityError('Reload this record before saving.');
    if (new Date(record.updatedAt).getTime() !== Date.parse(value))
        throw new UtilityError('This record changed. Refresh before trying again.', 409);
}
// Ensure two rapid edits cannot share the same millisecond version.
const nextVersion = (record) => new Date(Math.max(Date.now(), new Date(record.updatedAt).getTime() + 1));
exports.nextVersion = nextVersion;
exports.studentSelect = { id: true, indexno: true, fname: true, mname: true, lname: true, programId: true, majorId: true, semesterNum: true, deferStatus: true, completeStatus: true, graduateStatus: true };
exports.changeInclude = { student: { select: exports.studentSelect }, oldprogram: { select: { id: true, longName: true } }, newprogram: { select: { id: true, longName: true, hasMajor: true } }, session: { select: { id: true, title: true } } };
function validateDestination(tx, student, data) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!(student === null || student === void 0 ? void 0 : student.indexno) || !student.programId)
            throw new UtilityError('The student must have a program and index number.');
        if (student.completeStatus || student.graduateStatus || student.deferStatus)
            throw new UtilityError('Completed, graduated or deferred students cannot change program.');
        if (student.programId === data.newProgramId)
            throw new UtilityError('Choose a different destination program.');
        const program = yield tx.program.findUnique({ where: { id: data.newProgramId } });
        if (!(program === null || program === void 0 ? void 0 : program.status))
            throw new UtilityError('Choose an active destination program.');
        if (!program.semesterTotal || data.newSemesterNum > program.semesterTotal)
            throw new UtilityError('The semester must be within the destination program duration.');
        const session = yield tx.session.findUnique({ where: { id: data.sessionId } });
        if (!(session === null || session === void 0 ? void 0 : session.status) || !session.default)
            throw new UtilityError('Choose the active current academic session.');
        if ((data.newSemesterNum % 2 === 1 ? 'SEM1' : 'SEM2') !== session.semester)
            throw new UtilityError('The destination semester must match the academic session.');
        return program;
    });
}
