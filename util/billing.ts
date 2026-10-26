export class BillingError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export function groupCode(value: unknown, required = true): string {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!required && !code) return '';
  if (!/^[01]{4}$/.test(code) || (required && !code.includes('1'))) {
    throw new BillingError('Select at least one valid target year (Years 1–4).');
  }
  return code;
}

// A year includes both of its semesters, regardless of the billing session.
export function targetSemesters(code: string): number[] {
  return groupCode(code).split('').flatMap((bit, year) => bit === '1' ? [year * 2 + 1, year * 2 + 2] : []);
}

export function codesForSemester(value: number): string[] {
  if (!Number.isInteger(value) || value < 1 || value > 8) return [];
  const year = Math.ceil(value / 2) - 1;
  return Array.from({ length: 16 }, (_, n) => n.toString(2).padStart(4, '0')).filter(code => code[year] === '1');
}

export function billStudentWhere(bill: any) {
  return {
    programId: bill.programId, entryGroup: bill.type,
    semesterNum: { in: targetSemesters(bill.mainGroupCode) },
    deferStatus: false, completeStatus: false,
  };
}

export function validateBill(body: any) {
  const text = (key: string) => typeof body[key] === 'string' ? body[key].trim() : '';
  const amount = Number(body.amount);
  const discount = body.discount == null || body.discount === '' ? 0 : Number(body.discount);
  const quota = body.quota == null || body.quota === '' ? null : Number(body.quota);
  if (!text('narrative') || !text('programId') || !text('sessionId') || !text('bankaccId')) {
    throw new BillingError('Provide a bill title, programme, academic session and payment account.');
  }
  if (body.amount == null || body.amount === '' || !Number.isFinite(amount) || amount <= 0) throw new BillingError('Bill amount must be greater than zero.');
  if (!Number.isFinite(discount) || discount < 0 || discount > amount) throw new BillingError('Discount must be between zero and the bill amount.');
  if (quota !== null && (!Number.isFinite(quota) || quota < 0 || quota > 100)) throw new BillingError('Payment quota must be between 0 and 100 percent.');
  if (!['GH', 'INT'].includes(body.type)) throw new BillingError('Select a valid student category.');
  const mainGroupCode = groupCode(body.mainGroupCode);
  const discountGroupCode = groupCode(body.discountGroupCode, false);
  if (discount > 0 && !discountGroupCode.includes('1')) throw new BillingError('Select the years eligible for the discount.');
  if (discountGroupCode.split('').some((bit, i) => bit === '1' && mainGroupCode[i] !== '1')) throw new BillingError('Discount years must also be selected in the main target group.');
  return { narrative: text('narrative'), programId: text('programId'), sessionId: text('sessionId'), bankaccId: text('bankaccId'),
    type: body.type, amount, discount, quota, mainGroupCode, discountGroupCode: discountGroupCode || null, currency: 'GHC' as const };
}

export function studentBillAmount(bill: any, semesterNum: number | null) {
  const year = Math.ceil(Number(semesterNum) / 2) - 1;
  const discount = year >= 0 && year < 4 && bill.discountGroupCode?.[year] === '1' ? Number(bill.discount || 0) : 0;
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
export async function feeQuotaStatus(db: any, student: { id: string; flagPardon?: boolean | null }, sessionId: string) {
  const round = (n: number) => Math.round(n * 100) / 100;
  if (student.flagPardon) return { ok: true, pardoned: true };
  const bills = await db.studentAccount.findMany({ where: { studentId: student.id, billId: { not: null }, bill: { sessionId } }, select: { amount: true, bill: { select: { quota: true } } } });
  if (!bills.length) return { ok: true, billed: 0 };
  const billed = round(bills.reduce((sum: number, r: any) => sum + Number(r.amount || 0), 0));
  const required = round(bills.reduce((sum: number, r: any) => sum + Number(r.amount || 0) * Math.min(Math.max(Number(r.bill?.quota) || 0, 0), 100) / 100, 0));
  const ledger = await db.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId: student.id } });
  const balance = round(Number(ledger?._sum?.amount) || 0);
  const shortfall = round(Math.max(0, balance - (billed - required)));
  return { ok: shortfall <= 0, billed, required, balance, shortfall };
}

export const feeQuotaMessage = (q: any) =>
  `Fees quota not met: pay at least GHC ${Number(q.shortfall).toFixed(2)} more towards your fees to register courses this semester (required: GHC ${Number(q.required).toFixed(2)} of GHC ${Number(q.billed).toFixed(2)} billed, plus any arrears).`;

export function studentTags(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string' || !tag.trim())) throw new BillingError('The bill contains an invalid student inclusion or exclusion list.');
  return [...new Set(value.map(tag => tag.trim()))];
}
