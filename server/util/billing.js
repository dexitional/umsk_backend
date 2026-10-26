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
exports.feeQuotaMessage = exports.BillingError = void 0;
exports.groupCode = groupCode;
exports.targetSemesters = targetSemesters;
exports.codesForSemester = codesForSemester;
exports.billStudentWhere = billStudentWhere;
exports.validateBill = validateBill;
exports.studentBillAmount = studentBillAmount;
exports.feeQuotaStatus = feeQuotaStatus;
exports.studentTags = studentTags;
class BillingError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
exports.BillingError = BillingError;
function groupCode(value, required = true) {
    const code = typeof value === 'string' ? value.trim() : '';
    if (!required && !code)
        return '';
    if (!/^[01]{4}$/.test(code) || (required && !code.includes('1'))) {
        throw new BillingError('Select at least one valid target year (Years 1–4).');
    }
    return code;
}
// A year includes both of its semesters, regardless of the billing session.
function targetSemesters(code) {
    return groupCode(code).split('').flatMap((bit, year) => bit === '1' ? [year * 2 + 1, year * 2 + 2] : []);
}
function codesForSemester(value) {
    if (!Number.isInteger(value) || value < 1 || value > 8)
        return [];
    const year = Math.ceil(value / 2) - 1;
    return Array.from({ length: 16 }, (_, n) => n.toString(2).padStart(4, '0')).filter(code => code[year] === '1');
}
function billStudentWhere(bill) {
    return {
        programId: bill.programId, entryGroup: bill.type,
        semesterNum: { in: targetSemesters(bill.mainGroupCode) },
        deferStatus: false, completeStatus: false,
    };
}
function validateBill(body) {
    const text = (key) => typeof body[key] === 'string' ? body[key].trim() : '';
    const amount = Number(body.amount);
    const discount = body.discount == null || body.discount === '' ? 0 : Number(body.discount);
    const quota = body.quota == null || body.quota === '' ? null : Number(body.quota);
    if (!text('narrative') || !text('programId') || !text('sessionId') || !text('bankaccId')) {
        throw new BillingError('Provide a bill title, programme, academic session and payment account.');
    }
    if (body.amount == null || body.amount === '' || !Number.isFinite(amount) || amount <= 0)
        throw new BillingError('Bill amount must be greater than zero.');
    if (!Number.isFinite(discount) || discount < 0 || discount > amount)
        throw new BillingError('Discount must be between zero and the bill amount.');
    if (quota !== null && (!Number.isFinite(quota) || quota < 0 || quota > 100))
        throw new BillingError('Payment quota must be between 0 and 100 percent.');
    if (!['GH', 'INT'].includes(body.type))
        throw new BillingError('Select a valid student category.');
    const mainGroupCode = groupCode(body.mainGroupCode);
    const discountGroupCode = groupCode(body.discountGroupCode, false);
    if (discount > 0 && !discountGroupCode.includes('1'))
        throw new BillingError('Select the years eligible for the discount.');
    if (discountGroupCode.split('').some((bit, i) => bit === '1' && mainGroupCode[i] !== '1'))
        throw new BillingError('Discount years must also be selected in the main target group.');
    return { narrative: text('narrative'), programId: text('programId'), sessionId: text('sessionId'), bankaccId: text('bankaccId'),
        type: body.type, amount, discount, quota, mainGroupCode, discountGroupCode: discountGroupCode || null, currency: 'GHC' };
}
function studentBillAmount(bill, semesterNum) {
    var _a;
    const year = Math.ceil(Number(semesterNum) / 2) - 1;
    const discount = year >= 0 && year < 4 && ((_a = bill.discountGroupCode) === null || _a === void 0 ? void 0 : _a[year]) === '1' ? Number(bill.discount || 0) : 0;
    return Math.round((Number(bill.amount) - discount) * 100) / 100;
}
// Course registration fee quota: of the bills posted to the student for
// this session, each bill's quota percentage must be paid before they can
// register. Measured against the live ledger balance (positive = owing),
// so arrears from earlier sessions must be cleared too and an existing
// credit counts towards the quota: the student may owe at most the unpaid
// remainder, sum(amount x (1 - quota%)). A bill without a quota requires
// nothing up front; no posted bills for the session, or a finance pardon,
// means no check.
function feeQuotaStatus(db, student, sessionId) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const round = (n) => Math.round(n * 100) / 100;
        if (student.flagPardon)
            return { ok: true, pardoned: true };
        const bills = yield db.studentAccount.findMany({ where: { studentId: student.id, billId: { not: null }, bill: { sessionId } }, select: { amount: true, bill: { select: { quota: true } } } });
        if (!bills.length)
            return { ok: true, billed: 0 };
        const billed = round(bills.reduce((sum, r) => sum + Number(r.amount || 0), 0));
        const required = round(bills.reduce((sum, r) => { var _a; return sum + Number(r.amount || 0) * Math.min(Math.max(Number((_a = r.bill) === null || _a === void 0 ? void 0 : _a.quota) || 0, 0), 100) / 100; }, 0));
        const ledger = yield db.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId: student.id } });
        const balance = round(Number((_a = ledger === null || ledger === void 0 ? void 0 : ledger._sum) === null || _a === void 0 ? void 0 : _a.amount) || 0);
        const shortfall = round(Math.max(0, balance - (billed - required)));
        return { ok: shortfall <= 0, billed, required, balance, shortfall };
    });
}
const feeQuotaMessage = (q) => `Fees quota not met: pay at least GHC ${Number(q.shortfall).toFixed(2)} more towards your fees to register courses this semester (required: GHC ${Number(q.required).toFixed(2)} of GHC ${Number(q.billed).toFixed(2)} billed, plus any arrears).`;
exports.feeQuotaMessage = feeQuotaMessage;
function studentTags(value) {
    if (value == null)
        return [];
    if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string' || !tag.trim()))
        throw new BillingError('The bill contains an invalid student inclusion or exclusion list.');
    return [...new Set(value.map(tag => tag.trim()))];
}
