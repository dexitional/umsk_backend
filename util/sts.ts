export class STSError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export const STS_ADMIN_ROLES = ['sts::admin', 'student::admin', 'student::registry'];
export const stsAdmin = (req: any) => Number(req.groupId) === 2 &&
  (req.roles || []).some((r: any) => STS_ADMIN_ROLES.includes(r.role));
export const stsMentorScope = (req: any) => ({ mentor: { accountTag: req.userId, active: true } });
export function textField(value: unknown, label: string, max: number, required = false): string | null {
  if (value == null || value === '') { if (required) throw new STSError(`${label} is required.`); return null; }
  if (typeof value !== 'string' || value.trim().length > max) throw new STSError(`${label} must be text of at most ${max} characters.`);
  const result = value.trim();
  if (required && !result) throw new STSError(`${label} is required.`);
  return result || null;
}
export function positiveInt(value: unknown, label: string): number {
  if (!/^[1-9]\d*$/.test(String(value))) throw new STSError(`${label} must be a positive whole number.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new STSError(`${label} is invalid.`);
  return result;
}
export function eligibility(student: any): string | null {
  if (!student) return 'Student not found.';
  if (student.deferStatus || student.completeStatus || student.graduateStatus) return 'Deferred, completed or graduated students cannot be assigned.';
  const sem = student.semesterNum, total = student.program?.semesterTotal;
  if (!Number.isInteger(sem) || sem < 1 || !Number.isInteger(total) || total < sem) return 'The student needs a valid semester and programme duration.';
  const year = Math.ceil(sem / 2);
  if (year > 4) return 'STS assignments are available for Years 1 to 4.';
  if (year === 4 && sem === total) return 'Year 4 students cannot be assigned in their final programme semester.';
  return null;
}
export function schoolData(body: any) {
  if (body.active !== undefined && typeof body.active !== 'boolean') throw new STSError('Active must be true or false.');
  return { code: textField(body.code, 'School code', 50, true)!.toUpperCase(), name: textField(body.name, 'School name', 255, true)!,
    district: textField(body.district, 'District', 255), address: textField(body.address, 'Address', 500), phone: textField(body.phone, 'Phone', 30),
    active: body.active ?? true };
}
export function mentorData(body: any) {
  if (body.active !== undefined && typeof body.active !== 'boolean') throw new STSError('Active must be true or false.');
  const email = textField(body.email, 'Email', 255);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new STSError('Enter a valid mentor email address.');
  return { schoolId: textField(body.schoolId, 'School', 191, true)!, name: textField(body.name, 'Mentor name', 255, true)!,
    phone: textField(body.phone, 'Phone', 30), email, accountTag: textField(body.accountTag, 'Staff account tag', 50), active: body.active ?? true };
}
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
