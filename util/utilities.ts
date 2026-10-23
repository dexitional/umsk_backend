export const UTILITY_ROLES = ['utilities::admin', 'student::admin', 'student::registry'];
export class UtilityError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function isWriteConflict(error: any) {
  const cause = error?.meta?.driverAdapterError?.cause;
  return ['P2034', 'P2028'].includes(error?.code) || (error?.code === 'P2010' && (
    cause?.kind === 'TransactionWriteConflict' || [1205, 1213].includes(Number(cause?.code ?? error?.meta?.code))
  ));
}
type Field = { key: string; label: string; max?: number; required?: boolean; type?: 'number' };
type Definition = { title: string; fields: Field[]; identity: string[]; order: string };
const named = (title: string): Definition => ({ title, fields: [{ key: 'title', label: 'Name', max: 255, required: true }], identity: ['title'], order: 'title' });
export const utilityModels: Record<string, Definition> = {
  religion: named('Religion'),
  region: { title: 'Region', fields: [{ key: 'tag', label: 'Tag', max: 50, required: true }, { key: 'title', label: 'Name', max: 255, required: true }], identity: ['tag', 'title'], order: 'title' },
  disability: named('Disability'),
  title: { title: 'Title', fields: [{ key: 'tag', label: 'Tag', max: 50, required: true }, { key: 'label', label: 'Label', max: 50, required: true }], identity: ['tag', 'label'], order: 'label' },
  country: { title: 'Country', fields: [{ key: 'code', label: 'Country code', type: 'number' }, { key: 'shortName', label: 'Short name', max: 10 }, { key: 'longName', label: 'Country name', max: 255, required: true }, { key: 'nationality', label: 'Nationality', max: 300 }], identity: ['shortName', 'longName'], order: 'longName' },
  marital: named('Marital status'),
  relation: named('Relation'),
};
export function definition(key: string) {
  if (!Object.prototype.hasOwnProperty.call(utilityModels, key)) throw new UtilityError('Unknown utility module.', 404);
  return utilityModels[key];
}
export function text(value: unknown, label: string, max = 255, required = true): string | null {
  if (value === undefined || value === null || value === '') { if (!required) return null; throw new UtilityError(`${label} is required.`); }
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new UtilityError(`${label} must contain 1–${max} characters.`);
  return value.trim();
}
export function positive(value: unknown, label: string): number {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') throw new UtilityError(`${label} must be a positive whole number.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647) throw new UtilityError(`${label} must be a positive whole number.`);
  return n;
}
export function lookupData(key: string, body: any) {
  const meta = definition(key);
  const data: any = {};
  for (const field of meta.fields) {
    const value = body[field.key];
    data[field.key] = field.type === 'number' ? (value === '' || value == null ? null : positive(value, field.label)) : text(value, field.label, field.max, !!field.required);
  }
  if (body.status !== undefined && typeof body.status !== 'boolean') throw new UtilityError('Status must be true or false.');
  data.status = body.status ?? true;
  return data;
}
export function checkVersion(record: any, value: unknown) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new UtilityError('Reload this record before saving.');
  if (new Date(record.updatedAt).getTime() !== Date.parse(value)) throw new UtilityError('This record changed. Refresh before trying again.', 409);
}
// Ensure two rapid edits cannot share the same millisecond version.
export const nextVersion = (record: any) => new Date(Math.max(Date.now(), new Date(record.updatedAt).getTime() + 1));
export const studentSelect = { id: true, indexno: true, fname: true, mname: true, lname: true, programId: true, majorId: true, semesterNum: true, deferStatus: true, completeStatus: true, graduateStatus: true };
export const changeInclude = { student: { select: studentSelect }, oldprogram: { select: { id: true, longName: true } }, newprogram: { select: { id: true, longName: true, hasMajor: true } }, session: { select: { id: true, title: true } } };
export async function validateDestination(tx: any, student: any, data: any) {
  if (!student?.indexno || !student.programId) throw new UtilityError('The student must have a program and index number.');
  if (student.completeStatus || student.graduateStatus || student.deferStatus) throw new UtilityError('Completed, graduated or deferred students cannot change program.');
  if (student.programId === data.newProgramId) throw new UtilityError('Choose a different destination program.');
  const program = await tx.program.findUnique({ where: { id: data.newProgramId } });
  if (!program?.status) throw new UtilityError('Choose an active destination program.');
  if (!program.semesterTotal || data.newSemesterNum > program.semesterTotal) throw new UtilityError('The semester must be within the destination program duration.');
  const session = await tx.session.findUnique({ where: { id: data.sessionId } });
  if (!session?.status || !session.default) throw new UtilityError('Choose the active current academic session.');
  if ((data.newSemesterNum % 2 === 1 ? 'SEM1' : 'SEM2') !== session.semester) throw new UtilityError('The destination semester must match the academic session.');
  return program;
}
