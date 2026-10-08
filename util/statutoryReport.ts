// GTEC statutory return tables. Each table is generated on its own and
// downloaded as a single Excel file from the AIS Reports page
// (POST /ais/report/statutory).
//
// Layout comes straight from GTEC's sample return (templates/gtec-return.xlsx,
// an .xlsx copy of public/report-format.xls): each table's title/header rows
// and the styling of its row blocks and TOTAL block are copied cell-for-cell
// from the template, so the output looks exactly like the sample. Only the
// counts are ours -- with the template's formulas for T rows and totals.
//
// Student tables are a snapshot of current enrolment (students not
// completed, graduated or deferred) labelled with the default session's
// academic year. Anything the data can't place in a table (missing gender,
// unmapped rank, ...) goes on a separate "DATA NOTES" sheet, keeping the
// table sheet itself identical to the template.
import fs from "fs";
import path from "path";
import moment from "moment";
import { prisma } from "../prisma/client";
const ExcelJS = require('exceljs');

const ais: any = prisma;
const INSTITUTION = process.env.UMS_INSTITUTION || 'AKATSI COLLEGE OF EDUCATION';

export class StatutoryReportError extends Error {}

type GenderBlock = { label: string; M: number[]; F: number[] };
type FlatRow = { label: string; values: number[] };
type ReportData = {
   file: string;
   year: string;
   blocks?: GenderBlock[];
   rows?: FlatRow[];
   gaps: string[];
};

// Where each table sits in the template. `top`..`headerEnd` are copied as
// is; `firstBlock` is the first 3-row (M/F/T) block -- or, for 'flat', the
// first data row -- and `total` is the TOTAL block/row. `footer` rows (notes
// under the table) are copied after the TOTAL block. `labelRow` (0-2) is
// the block row holding an unmerged label, when the template's first block
// has none to go by. `yearText` is the academic year printed in the
// template, replaced with ours.
type TemplateSpec = { sheet: string; from: string; to: string; top: number; headerEnd: number; firstBlock: number; total: number; footer?: [number, number]; labelRow?: number; layout: 'gender' | 'flat'; yearText: string };
const TEMPLATES: Record<string, TemplateSpec> = {
   t03: { sheet: 'STUDENT DATA', from: 'C', to: 'F', top: 4, headerEnd: 8, firstBlock: 9, total: 24, layout: 'gender', yearText: '2025/2026' },
   t04: { sheet: 'STUDENT DATA', from: 'I', to: 'L', top: 4, headerEnd: 8, firstBlock: 9, total: 24, layout: 'gender', yearText: '2025/2026' },
   t05: { sheet: 'STUDENT DATA', from: 'O', to: 'R', top: 4, headerEnd: 8, firstBlock: 9, total: 24, layout: 'gender', yearText: '2025/2026' },
   t06: { sheet: 'STUDENT DATA', from: 'U', to: 'X', top: 4, headerEnd: 8, firstBlock: 9, total: 24, layout: 'gender', yearText: '2025/2026' },
   t07: { sheet: 'STUDENT DATA', from: 'AA', to: 'AH', top: 3, headerEnd: 8, firstBlock: 9, total: 24, layout: 'gender', yearText: '2025/2026' },
   t08: { sheet: 'STUDENT DATA', from: 'AK', to: 'AN', top: 4, headerEnd: 8, firstBlock: 9, total: 26, layout: 'flat', yearText: '2025/2026' },
   t09: { sheet: 'STUDENT DATA', from: 'AQ', to: 'AW', top: 3, headerEnd: 8, firstBlock: 9, total: 24, layout: 'gender', yearText: '2025/2026' },
   t10: { sheet: 'STUDENT DATA', from: 'BA', to: 'BG', top: 3, headerEnd: 8, firstBlock: 9, total: 24, layout: 'gender', yearText: '2025/2026' },
   t11: { sheet: 'STUDENT DATA', from: 'BK', to: 'BQ', top: 3, headerEnd: 8, firstBlock: 9, total: 24, layout: 'gender', yearText: '2025/2026' },
   t12: { sheet: 'STAFF DATA', from: 'B', to: 'AA', top: 3, headerEnd: 7, firstBlock: 8, total: 44, layout: 'gender', yearText: '2025/2026' },
   t13: { sheet: 'STAFF DATA', from: 'AD', to: 'AK', top: 3, headerEnd: 7, firstBlock: 8, total: 44, layout: 'gender', yearText: '2025/2026' },
   t14: { sheet: 'STAFF DATA', from: 'AN', to: 'BM', top: 3, headerEnd: 7, firstBlock: 8, total: 44, footer: [47, 48], labelRow: 1, layout: 'gender', yearText: '2025/2026' },
   t15: { sheet: 'STAFF DATA', from: 'BP', to: 'BX', top: 3, headerEnd: 7, firstBlock: 8, total: 44, footer: [47, 60], layout: 'gender', yearText: '2025/2026' },
   t16: { sheet: 'STAFF DATA', from: 'CA', to: 'CI', top: 3, headerEnd: 7, firstBlock: 8, total: 44, footer: [47, 60], labelRow: 0, layout: 'gender', yearText: '2025/2026' },
   t17: { sheet: 'GRADUATE OUTPUT', from: 'B', to: 'L', top: 3, headerEnd: 10, firstBlock: 11, total: 26, layout: 'gender', yearText: '2024/2025' },
};

/* ---------- shared helpers ---------- */

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const zeros = (n: number) => Array.from({ length: n }, () => 0);
const genderOf = (g?: string | null): 'M' | 'F' | null => {
   const c = (g || '').trim().toUpperCase()[0];
   return c === 'M' || c === 'F' ? c : null;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tally = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const tallyText = (m: Map<string, number>) => [...m.entries()].map(([k, n]) => `${k} (${n})`).join(', ');
const fileYear = (y: string) => y.replace(/\//g, '-');

async function academicYear() {
   const s = await ais.session.findFirst({ where: { default: true }, select: { year: true } });
   return s?.year || `${moment().year()}/${moment().year() + 1}`;
}

async function programmes() {
   return ais.program.findMany({ where: { status: true }, select: { id: true, longName: true, category: true, semesterTotal: true }, orderBy: { longName: 'asc' } });
}

// Currently enrolled students -- not completed, graduated or deferred.
async function enrolledStudents() {
   return ais.student.findMany({
      where: { completeStatus: false, graduateStatus: false, deferStatus: false, programId: { not: null } },
      select: {
         gender: true, semesterNum: true, programId: true,
         program: { select: { category: true, semesterTotal: true } },
         disability: { select: { title: true } },
         nationality: { select: { longName: true, shortName: true, code: true } },
      },
   });
}

const yearOf = (semesterNum?: number | null) => Math.max(1, Math.ceil((semesterNum || 1) / 2));
const yearsOf = (semesterTotal?: number | null) => Math.max(1, Math.ceil((semesterTotal || 8) / 2));

// One M/F block per programme, filled by `col(student)` (column index, or
// null to leave the student out).
function programmeBlocks(progs: any[], students: any[], width: number, col: (s: any) => number | null) {
   const blocks = new Map<string, GenderBlock>(progs.map((p: any) => [p.id, { label: p.longName?.toUpperCase(), M: zeros(width), F: zeros(width) }]));
   let noGender = 0;
   for (const s of students) {
      const c = col(s);
      if (c == null) continue;
      const g = genderOf(s.gender);
      if (!g) { noGender++; continue; }
      const b = blocks.get(s.programId);
      if (b) b[g][c]++;
   }
   return { blocks: [...blocks.values()], noGender };
}

const noGenderGap = (n: number, who = 'student') => (n ? [`${plural(n, who)} with no gender recorded are not included.`] : []);

/* ---------- student tables ---------- */

// Tables 3-5 (applications, qualified, admission offered). umsk holds no
// applicant data, so all three are derived from current, uncompleted
// students admitted in the report year (deferred students included) -- the
// three tables therefore carry the same figures. The admission year comes
// from the date of admission (entryDate), else the "YY" prefix of the
// index number, else of the student ID (e.g. 2301151 = 2023).
const ADMISSION_TABLES: Record<string, { num: number; name: string }> = {
   t03: { num: 3, name: 'Applications for Admission' },
   t04: { num: 4, name: 'Applications Qualified for Admission' },
   t05: { num: 5, name: 'Admission Offered' },
};
const admissionYearOf = (s: any): number | null => {
   if (s.entryDate) return new Date(s.entryDate).getUTCFullYear();
   for (const v of [s.indexno, s.id]) {
      const m = String(v || '').match(/^(\d{2})/);
      const y = m ? 2000 + Number(m[1]) : 0;
      if (y && y <= new Date().getUTCFullYear()) return y;
   }
   return null;
};

async function admissionTable(key: string): Promise<ReportData> {
   const cfg = ADMISSION_TABLES[key];
   const year = await academicYear();
   const startYear = Number(year.slice(0, 4));
   const students = await ais.student.findMany({
      where: { completeStatus: false, graduateStatus: false, programId: { not: null } },
      select: { id: true, indexno: true, entryDate: true, gender: true, programId: true },
   });
   let unknownYear = 0;
   const { blocks, noGender } = programmeBlocks(await programmes(), students, 1, (s) => {
      const y = admissionYearOf(s);
      if (y == null) { unknownYear++; return null; }
      return y === startYear ? 0 : null;
   });
   return {
      file: `Table ${cfg.num} - ${cfg.name} ${fileYear(year)}`, year, blocks,
      gaps: [
         `Derived from current, uncompleted students admitted in ${startYear} (no applicant records are held), so Tables 3, 4 and 5 show the same figures. Admission year from the date of admission, else the 2-digit year prefix of the index number or student ID.`,
         ...(unknownYear ? [`${plural(unknownYear, 'student')} with no admission year could not be placed.`] : []),
         ...noGenderGap(noGender),
      ],
   };
}

async function t06(): Promise<ReportData> {
   const year = await academicYear();
   const { blocks, noGender } = programmeBlocks(await programmes(), await enrolledStudents(), 1, (s) => (yearOf(s.semesterNum) === 1 ? 0 : null));
   return { file: `Table 6 - New Entrants ${fileYear(year)}`, year, blocks, gaps: ['New entrants are enrolled Year 1 students.', ...noGenderGap(noGender)] };
}

async function t07(): Promise<ReportData> {
   const year = await academicYear();
   let beyondYr4 = 0;
   // Columns: Yr. 1 .. Yr. 4, EXT. (beyond the programme's duration).
   const { blocks, noGender } = programmeBlocks(await programmes(), await enrolledStudents(), 5, (s) => {
      const y = yearOf(s.semesterNum);
      if (y > yearsOf(s.program?.semesterTotal)) return 4;
      if (y > 4) { beyondYr4++; return null; }
      return y - 1;
   });
   return {
      file: `Table 7 - Student Enrolment ${fileYear(year)}`, year, blocks,
      gaps: [
         'Excludes deferred, completed and graduated students.',
         ...(beyondYr4 ? [`${plural(beyondYr4, 'student')} in Year 5+ of a longer programme are not included (the template has Yr. 1-4 only).`] : []),
         ...noGenderGap(noGender),
      ],
   };
}

async function t08(): Promise<ReportData> {
   const year = await academicYear();
   const byCountry = new Map<string, FlatRow>();
   let noNationality = 0, noGender = 0;
   for (const s of await enrolledStudents()) {
      const n = s.nationality;
      if (!n) { noNationality++; continue; }
      if (n.code === 233 || n.shortName?.toUpperCase() === 'GH') continue; // Ghanaian
      const g = genderOf(s.gender);
      if (!g) { noGender++; continue; }
      const row = byCountry.get(n.longName) ?? { label: n.longName, values: [0, 0] };
      row.values[g === 'M' ? 0 : 1]++;
      byCountry.set(n.longName, row);
   }
   return {
      file: `Table 8 - Foreign Students ${fileYear(year)}`, year,
      rows: [...byCountry.values()].sort((a, b) => a.label.localeCompare(b.label)),
      gaps: [
         ...(noNationality ? [`${plural(noNationality, 'student')} with no nationality recorded could not be checked.`] : []),
         ...noGenderGap(noGender, 'foreign student'),
      ],
   };
}

// Disability titles are free text (e.g. "CRIPPLED IN THE LEFT LEG"), so
// they're grouped by keyword. Hearing/speech is checked first: per the
// template, dual-sensory (DeafBlind, DeafDumb) belongs in Table 11, and so
// does speech impairment.
type DisabilityGroup = 'mobility' | 'vision' | 'hearing';
const disabilityGroupOf = (title?: string | null): DisabilityGroup | null => {
   const t = (title || '').toUpperCase();
   if (/DEAF|HEARING|DUAL ?SENSORY|SPEECH|DUMB|MUTE/.test(t)) return 'hearing';
   if (/BLIND|VISION|VISUAL|SIGHT|EYE/.test(t)) return 'vision';
   if (/CRIPPL|LIMB|MOBIL|LEG|ARM|AMPUT|WHEEL|LAME|PHYSICAL/.test(t)) return 'mobility';
   return null;
};
const DISABILITY_TABLES: Record<string, { group: DisabilityGroup; num: number; name: string }> = {
   t09: { group: 'mobility', num: 9, name: 'Mobility Impairment' },
   t10: { group: 'vision', num: 10, name: 'Vision Impairment' },
   t11: { group: 'hearing', num: 11, name: 'Hearing and Speech Impairment' },
};

async function disabilityTable(key: string): Promise<ReportData> {
   const cfg = DISABILITY_TABLES[key];
   const year = await academicYear();
   const unmapped = new Map<string, number>();
   let otherLevel = 0, withDisability = 0;
   // Columns: Diploma (within, ext), Bachelor (within, ext).
   const { blocks, noGender } = programmeBlocks(await programmes(), await enrolledStudents(), 4, (s) => {
      const title = s.disability?.title?.trim();
      if (!title || /^NO(NE| DISABILITY)?$/i.test(title)) return null;
      withDisability++;
      const group = disabilityGroupOf(title);
      if (!group) { tally(unmapped, title); return null; }
      if (group !== cfg.group) return null;
      const cat = s.program?.category;
      if (!['DP', 'CP', 'UG'].includes(cat)) { otherLevel++; return null; }
      const ext = yearOf(s.semesterNum) > yearsOf(s.program?.semesterTotal) ? 1 : 0;
      return (cat === 'UG' ? 2 : 0) + ext;
   });
   return {
      file: `Table ${cfg.num} - ${cfg.name} ${fileYear(year)}`, year, blocks,
      gaps: [
         ...(!withDisability ? ['No enrolled student has a disability recorded.'] : []),
         ...(unmapped.size ? [`Disabilities not placed in Tables 9-11: ${tallyText(unmapped)}.`] : []),
         ...(otherLevel ? [`${plural(otherLevel, 'student')} on non-diploma/bachelor programmes are not included.`] : []),
         ...noGenderGap(noGender),
      ],
   };
}

/* ---------- staff tables ---------- */

// Current staff (exited, retired and deceased staff left out).
async function currentStaff() {
   return ais.staff.findMany({
      where: { status: true, staffStatus: { notIn: ['DEAD', 'RETIRED', 'EXITED'] } },
      select: {
         gender: true, dob: true, qualification: true, staffStatus: true,
         job: { select: { title: true, type: true, staffCategory: true, dutyType: true } },
         promotion: { select: { job: { select: { title: true } } } },
         unit: { select: { id: true, title: true, type: true, levelNum: true, level1: { select: { id: true, title: true, type: true } } } },
      },
   });
}
const isPartTime = (s: any) => s.staffStatus === 'PARTTIME';

// Teaching departments are the level-1 academic units; staff in a
// sub-unit roll up to its level-1 parent, including a non-academic unit
// that sits under an academic department (e.g. CATERING).
async function academicDepartments() {
   return ais.unit.findMany({ where: { type: 'ACADEMIC', levelNum: 1, status: true }, select: { id: true, title: true }, orderBy: { title: 'asc' } });
}
const departmentOf = (unit: any) => {
   if (!unit) return null;
   if (unit.type === 'ACADEMIC') return unit.levelNum === 1 ? unit : unit.level1;
   return unit.level1?.type === 'ACADEMIC' ? unit.level1 : null;
};
// Central administration and support units: non-academic units that
// aren't part of a teaching department.
async function supportUnits() {
   const units = await ais.unit.findMany({ where: { type: 'NON_ACADEMIC', status: true }, select: { id: true, title: true, level1: { select: { type: true } } }, orderBy: { title: 'asc' } });
   return units.filter((u: any) => u.level1?.type !== 'ACADEMIC');
}

// Teaching = academic job type, non-teaching = non-academic job type.
// Staff with no job can't be classed either way.
async function staffByJobType(type: 'ACADEMIC' | 'NON_ACADEMIC') {
   const staff = await currentStaff();
   const noJob = staff.filter((s: any) => !s.job).length;
   return { staff: staff.filter((s: any) => s.job?.type === type), noJob };
}
const noJobGap = (n: number) => (n ? [`${plural(n, 'staff member')} with no job/rank assigned could not be classed as teaching or non-teaching and are not included.`] : []);

// One M/F block per row unit; `keyOf` picks a staff member's row (unit id),
// anything else lands in a trailing `unsetLabel` block.
function unitBlocks(units: any[], staff: any[], width: number, keyOf: (s: any) => string | null | undefined, unsetLabel: string, col: (s: any) => number | null) {
   const blocks = new Map<string, GenderBlock>(units.map((u: any) => [u.id, { label: u.title?.trim()?.toUpperCase(), M: zeros(width), F: zeros(width) }]));
   let noGender = 0;
   for (const s of staff) {
      const c = col(s);
      if (c == null) continue;
      const g = genderOf(s.gender);
      if (!g) { noGender++; continue; }
      const k = keyOf(s);
      const key = k && blocks.has(k) ? k : unsetLabel;
      if (!blocks.has(key)) blocks.set(key, { label: unsetLabel, M: zeros(width), F: zeros(width) });
      blocks.get(key)![g][c]++;
   }
   return { blocks: [...blocks.values()], noGender };
}
const NO_DEPARTMENT = 'DEPARTMENT NOT SET';
const departmentBlocks = (depts: any[], staff: any[], width: number, col: (s: any) => number | null) =>
   unitBlocks(depts, staff, width, (s) => departmentOf(s.unit)?.id, NO_DEPARTMENT, col);

// GTEC ranks, in template order. Job titles are free text, so match by
// keyword.
const LECTURER = 3;
const rankOf = (title?: string | null) => {
   const t = (title || '').toUpperCase().replace(/\s+/g, ' ');
   if (/ASSOC/.test(t) && /PROF/.test(t)) return 1;
   if (/PROF/.test(t)) return 0;
   if (/SENIOR LECTURER/.test(t)) return 2;
   if (/ASSISTANT LECTURER/.test(t)) return 4;
   if (/LECTURER/.test(t)) return LECTURER;
   if (/TUTOR/.test(t)) return 5;
   return -1;
};
// A title that isn't a rank (HOD, PRINCIPAL INSTRUCTOR, ...) takes the rank
// of the staff member's latest promotion, else counts as Lecturer.
const staffRankOf = (s: any, defaulted: Map<string, number>) => {
   const r = rankOf(s.job?.title);
   if (r >= 0) return r;
   const pr = rankOf(s.promotion?.job?.title);
   if (pr >= 0) return pr;
   tally(defaulted, s.job?.title?.trim() || 'NO TITLE');
   return LECTURER;
};

// Highest qualification from the free-text field, e.g. "M.Phil. (Music)".
type Qual = 'PHD' | 'MPHIL' | 'MASTERS' | 'OTHERS';
const qualificationOf = (text?: string | null): Qual | null => {
   if (!text?.trim()) return null;
   const tokens = text.toUpperCase().replace(/\./g, '').split(/[^A-Z]+/);
   if (tokens.some((t) => ['PHD', 'DPHIL', 'DOCTOR', 'DOCTORATE', 'EDD'].includes(t))) return 'PHD';
   if (tokens.includes('MPHIL')) return 'MPHIL';
   if (tokens.some((t) => ['MSC', 'MA', 'MED', 'MBA', 'MCOM', 'MPA', 'MTECH', 'MFA', 'LLM', 'MASTER', 'MASTERS'].includes(t))) return 'MASTERS';
   return 'OTHERS';
};
// Column offsets per rank: 4 qualification columns each, except TUTOR
// which has no PhD column in the template.
const RANK_COLS = [0, 4, 8, 12, 16, 20];
const QUAL_COL: Record<Qual, number> = { PHD: 0, MPHIL: 1, MASTERS: 2, OTHERS: 3 };

// Tables 12 (full-time) and 14 (part-time, staffStatus PARTTIME).
async function academicStaffTable(partTime: boolean): Promise<ReportData> {
   const year = await academicYear();
   const { staff, noJob } = await staffByJobType('ACADEMIC');
   const defaulted = new Map<string, number>();
   let noQual = 0, tutorPhd = 0;
   const { blocks, noGender } = departmentBlocks(await academicDepartments(), staff.filter((s: any) => isPartTime(s) === partTime), 23, (s) => {
      const r = staffRankOf(s, defaulted);
      let q = qualificationOf(s.qualification);
      if (!q) { noQual++; q = 'OTHERS'; }
      if (r === 5) {
         if (q === 'PHD') { tutorPhd++; q = 'OTHERS'; }
         return RANK_COLS[5] + QUAL_COL[q] - 1;
      }
      return RANK_COLS[r] + QUAL_COL[q];
   });
   const [num, kind] = partTime ? [14, 'Part-time'] : [12, 'Full-time'];
   return {
      file: `Table ${num} - ${kind} Academic Staff ${fileYear(year)}`, year, blocks,
      gaps: [
         partTime ? 'Part-time staff are those with staff status PART-TIME.' : 'Full-time staff are all current academic staff except those with staff status PART-TIME.',
         ...(defaulted.size ? [`Job titles that aren't a GTEC rank, with no ranked promotion on record, counted as Lecturer: ${tallyText(defaulted)}.`] : []),
         ...(noQual ? [`${plural(noQual, 'staff member')} with no qualification recorded counted under Others.`] : []),
         ...(tutorPhd ? [`${plural(tutorPhd, 'tutor')} with a PhD counted under Others (the template has no PhD column for tutors).`] : []),
         ...noJobGap(noJob),
         ...noGenderGap(noGender, 'staff member'),
      ],
   };
}

const ageBandOf = (age: number) => (age < 30 ? 0 : age <= 40 ? 1 : age <= 50 ? 2 : age <= 60 ? 3 : 4);

async function t13(): Promise<ReportData> {
   const year = await academicYear();
   const { staff, noJob } = await staffByJobType('ACADEMIC');
   let noDob = 0;
   const { blocks, noGender } = departmentBlocks(await academicDepartments(), staff.filter((s: any) => !isPartTime(s)), 5, (s) => {
      if (!s.dob) { noDob++; return null; }
      return ageBandOf(moment().diff(moment(s.dob), 'years'));
   });
   return {
      file: `Table 13 - Academic Staff Age ${fileYear(year)}`, year, blocks,
      gaps: [
         `Age as at ${moment().format('D MMMM YYYY')}. Full-time staff only.`,
         ...(noDob ? [`${plural(noDob, 'staff member')} with no date of birth recorded are not included.`] : []),
         ...noJobGap(noJob),
         ...noGenderGap(noGender, 'staff member'),
      ],
   };
}

// Tables 15 (central administration / support units) and 16 (teaching
// departments): non-teaching staff by category (job.staffCategory) and
// duty type (job.dutyType). Columns: SM tech, SM non-tech, SS tech, SS
// non-tech, JS tech, JS non-tech.
const CATEGORY_COL: Record<string, number> = { SM: 0, SS: 2, JS: 4 };

async function nonTeachingTable(inDepartments: boolean): Promise<ReportData> {
   const year = await academicYear();
   const { staff, noJob } = await staffByJobType('NON_ACADEMIC');
   const here = staff.filter((s: any) => !!departmentOf(s.unit) === inDepartments);
   const noCategory = new Map<string, number>(), noDuty = new Map<string, number>();
   const col = (s: any) => {
      const cat = CATEGORY_COL[s.job?.staffCategory];
      if (cat == null) { tally(noCategory, s.job?.title?.trim() || 'NO TITLE'); return null; }
      if (!s.job?.dutyType) { tally(noDuty, s.job?.title?.trim() || 'NO TITLE'); return null; }
      return cat + (s.job.dutyType === 'TECHNICAL' ? 0 : 1);
   };
   const { blocks, noGender } = inDepartments
      ? departmentBlocks(await academicDepartments(), here, 6, col)
      : unitBlocks(await supportUnits(), here, 6, (s) => s.unit?.id, 'UNIT NOT SET', col);
   const [num, kind] = inDepartments ? [16, 'Non-teaching Staff in Departments'] : [15, 'Non-teaching Staff in Admin and Support'];
   return {
      file: `Table ${num} - ${kind} ${fileYear(year)}`, year, blocks,
      gaps: [
         ...(noCategory.size ? [`Jobs with no staff category (SM/SS/JS) set, not included: ${tallyText(noCategory)}.`] : []),
         ...(noDuty.size ? [`Jobs with no duty type (Technical/Non-technical) set, not included: ${tallyText(noDuty)}.`] : []),
         ...noJobGap(noJob),
         ...noGenderGap(noGender, 'staff member'),
      ],
   };
}

/* ---------- graduate output ---------- */

// Class labels come from the grading scheme, e.g. "Second Class (Upper
// Division)"; diploma programmes use Distinction / Credit / Pass.
const classColOf = (cls: string | null | undefined, diploma: boolean) => {
   const c = (cls || '').toUpperCase();
   if (diploma) return /DISTINCT/.test(c) ? 0 : /CREDIT/.test(c) ? 1 : /^PASS/.test(c) ? 2 : -1;
   if (/FIRST|1ST/.test(c)) return 3;
   if (/UPPER/.test(c)) return 4;
   if (/LOWER/.test(c)) return 5;
   if (/THIRD|3RD/.test(c)) return 6;
   if (/^PASS/.test(c)) return 7;
   return -1;
};

async function t17(gsession?: string): Promise<ReportData> {
   const session = gsession
      ? await ais.graduateSession.findUnique({ where: { id: gsession } })
      : await ais.graduateSession.findFirst({ where: { default: true } });
   if (!session) throw new StatutoryReportError('Choose a graduation session.');
   const grads = await ais.graduate.findMany({ where: { graduateSessionId: session.id }, select: { class: true, student: { select: { gender: true, programId: true, program: { select: { category: true } } } } } });
   const unmapped = new Map<string, number>();
   const { blocks, noGender } = programmeBlocks(await programmes(), grads.map((g: any) => ({ ...g.student, class: g.class })), 8, (s) => {
      const col = classColOf(s.class, ['DP', 'CP'].includes(s.program?.category));
      if (col < 0) { tally(unmapped, s.class || 'NO CLASS'); return null; }
      return col;
   });
   const year = session.title.match(/\d{4}\s*\/\s*\d{4}/)?.[0]?.replace(/\s/g, '') || session.title;
   return {
      file: `Table 17 - Graduating Students ${fileYear(session.title)}`.replace(/[\\:*?"<>|]/g, '-'), year, blocks,
      gaps: [
         `Graduation session: ${session.title}.`,
         ...(unmapped.size ? [`Graduates with a class not in the template, not included: ${tallyText(unmapped)}.`] : []),
         ...noGenderGap(noGender, 'graduate'),
      ],
   };
}

async function buildData(table: string, opts: { gsession?: string }): Promise<ReportData> {
   switch (table) {
      case 't03': case 't04': case 't05': return admissionTable(table);
      case 't06': return t06();
      case 't07': return t07();
      case 't08': return t08();
      case 't09': case 't10': case 't11': return disabilityTable(table);
      case 't12': return academicStaffTable(false);
      case 't13': return t13();
      case 't14': return academicStaffTable(true);
      case 't15': return nonTeachingTable(false);
      case 't16': return nonTeachingTable(true);
      case 't17': return t17(opts.gsession);
      default: throw new StatutoryReportError('Unknown statutory report table.');
   }
}

/* ---------- Excel rendering from the template ---------- */

// Compiled code runs from server/util, ts-node/tsx from util.
const TEMPLATE_PATHS = [path.join(__dirname, '../../templates/gtec-return.xlsx'), path.join(__dirname, '../templates/gtec-return.xlsx')];
let templateBook: Promise<any> | null = null;
function loadTemplate() {
   if (!templateBook) {
      const file = TEMPLATE_PATHS.find((p) => fs.existsSync(p));
      if (!file) throw new Error('GTEC report template (templates/gtec-return.xlsx) not found.');
      const wb = new ExcelJS.Workbook();
      const loading: Promise<any> = wb.xlsx.readFile(file).then(() => wb);
      loading.catch(() => (templateBook = null)); // retry on the next request
      templateBook = loading;
   }
   return templateBook!;
}

const clone = (o: any) => (o == null ? o : JSON.parse(JSON.stringify(o)));
const mapText = (v: any, fn: (s: string) => string) => {
   if (typeof v === 'string') return fn(v);
   if (v?.richText) return { richText: v.richText.map((r: any) => ({ ...clone(r), text: fn(r.text) })) };
   return clone(v);
};
const textOf = (v: any) => (typeof v === 'string' ? v : v?.richText ? v.richText.map((r: any) => r.text).join('') : '');

export async function buildStatutoryReport(table: string, opts: { gsession?: string } = {}) {
   const spec = TEMPLATES[table];
   if (!spec) throw new StatutoryReportError('Unknown statutory report table.');
   const data = await buildData(table, opts);
   const tpl = (await loadTemplate()).getWorksheet(spec.sheet);

   const c0 = tpl.getColumn(spec.from).number, c1 = tpl.getColumn(spec.to).number;
   const ncols = c1 - c0 + 1;
   const labelCols = spec.layout === 'gender' ? 2 : 1;
   const width = ncols - labelCols - 1; // data columns, before the grand total
   const merges: string[] = tpl.model.merges || [];

   const wb = new ExcelJS.Workbook();
   // Formulas carry cached results, but have Excel recompute them on open
   // (exceljs leaves out a cached result of 0).
   wb.calcProperties.fullCalcOnLoad = true;
   const ws = wb.addWorksheet(`TABLE ${Number(table.slice(1))}`, {
      views: [{ zoomScale: 90, showGridLines: true }],
      pageSetup: { ...clone(tpl.pageSetup), printArea: undefined },
   });
   for (let c = c0; c <= c1; c++) ws.getColumn(c - c0 + 1).width = tpl.getColumn(c).width;
   const col = (i: number) => ws.getColumn(i + 1).letter; // 0-based output column letter

   // Copy one template row's cells (style always; value optionally) and height.
   const copyRow = (tplRow: number, outRow: number, withValues: boolean) => {
      const h = tpl.getRow(tplRow).height;
      if (h) ws.getRow(outRow).height = h;
      for (let c = c0; c <= c1; c++) {
         const src = tpl.getCell(tplRow, c);
         const dst = ws.getCell(outRow, c - c0 + 1);
         dst.style = clone(src.style);
         const isSlave = src.isMerged && src.master.address !== src.address;
         if (withValues && !isSlave && src.value != null && !src.formula && !(src.value as any)?.sharedFormula) {
            dst.value = mapText(src.value, (s) => s.split(spec.yearText).join(data.year));
            // Fill in the blank "NAME OF INSTITUTION:" line.
            if (/^\s*NAME OF INSTITUTION\s*:?\s*$/i.test(textOf(src.value))) {
               const v: any = dst.value;
               if (v?.richText) v.richText[v.richText.length - 1].text = `${v.richText[v.richText.length - 1].text.trimEnd()} ${INSTITUTION}`;
               else dst.value = `${String(v).trimEnd()} ${INSTITUTION}`;
            }
         }
      }
   };
   // Template merges fully inside [r0..r1] x [c0..c1], shifted by `shift` rows.
   const copyMerges = (r0: number, r1: number, shift: number) => {
      for (const m of merges) {
         const [a, b = a] = m.split(':');
         const s = tpl.getCell(a), e = tpl.getCell(b);
         const sr = Number(s.row), sc = Number(s.col), er = Number(e.row), ec = Number(e.col);
         if (sr >= r0 && er <= r1 && sc >= c0 && ec <= c1) ws.mergeCells(sr + shift, sc - c0 + 1, er + shift, ec - c0 + 1);
      }
   };

   // Title and header rows, exactly as in the template.
   for (let r = spec.top; r <= spec.headerEnd; r++) copyRow(r, r - spec.top + 1, true);
   copyMerges(spec.top, spec.headerEnd, 1 - spec.top);
   let row = spec.headerEnd - spec.top + 2;

   const num = (v: number) => (v ? v : null); // blank input cells, as in the template
   const setFormula = (r: number, c: number, formula: string, result: number) => (ws.getCell(r, c + 1).value = { formula, result });
   const rowTotal = (r: number, vals: number[]) => setFormula(r, labelCols + width, `SUM(${col(labelCols)}${r}:${col(labelCols + width - 1)}${r})`, sum(vals));

   if (spec.layout === 'gender') {
      const blocks = data.blocks ?? [];
      const labelMerged = merges.some((m) => m.startsWith(`${spec.from}${spec.firstBlock}:`));
      // Unmerged labels sit in whichever block row the template uses.
      const tplLabelRow = [0, 1, 2].find((i) => textOf(tpl.getCell(spec.firstBlock + i, c0).value).trim());
      const labelRow = tplLabelRow ?? spec.labelRow ?? 1;
      const blockRows: number[] = [];
      const writeBlock = (tplStart: number, label: string, M: number[], F: number[], isTotal: boolean) => {
         const start = row;
         for (let i = 0; i < 3; i++) copyRow(tplStart + i, start + i, isTotal);
         if (!isTotal) {
            // Gender letters from the template; the label merged down the
            // block, or in the row the template puts it.
            ['M', 'F', 'T'].forEach((g, i) => (ws.getCell(start + i, 2).value = g));
            if (labelMerged) { ws.mergeCells(start, 1, start + 2, 1); ws.getCell(start, 1).value = label; }
            else ws.getCell(start + labelRow, 1).value = label;
         } else {
            copyMerges(tplStart, tplStart + 2, start - tplStart);
         }
         const T = M.map((m, i) => m + F[i]);
         for (let c = 0; c < width; c++) {
            const L = col(labelCols + c);
            if (isTotal) {
               setFormula(start, labelCols + c, blockRows.map((r) => `${L}${r}`).join('+') || '0', M[c]);
               setFormula(start + 1, labelCols + c, blockRows.map((r) => `${L}${r + 1}`).join('+') || '0', F[c]);
            } else {
               ws.getCell(start, labelCols + c + 1).value = num(M[c]);
               ws.getCell(start + 1, labelCols + c + 1).value = num(F[c]);
            }
            setFormula(start + 2, labelCols + c, `${L}${start}+${L}${start + 1}`, T[c]);
         }
         rowTotal(start, M); rowTotal(start + 1, F); rowTotal(start + 2, T);
         if (!isTotal) blockRows.push(start);
         row += 3;
      };
      blocks.forEach((b, i) => writeBlock(i === 0 ? spec.firstBlock : spec.firstBlock + 3, b.label, b.M, b.F, false));
      const M = blocks.reduce((a, b) => a.map((x, i) => x + b.M[i]), zeros(width));
      const F = blocks.reduce((a, b) => a.map((x, i) => x + b.F[i]), zeros(width));
      writeBlock(spec.total, 'TOTAL', M, F, true);
   } else {
      const rows = data.rows?.length ? data.rows : [{ label: '', values: zeros(width) }];
      const first = row;
      rows.forEach((fr, i) => {
         copyRow(i === 0 ? spec.firstBlock : spec.firstBlock + 1, row, false);
         ws.getCell(row, 1).value = fr.label || null;
         fr.values.forEach((v, c) => (ws.getCell(row, labelCols + c + 1).value = num(v)));
         rowTotal(row, fr.values);
         row++;
      });
      copyRow(spec.total, row, true);
      for (let c = 0; c <= width; c++) {
         const L = col(labelCols + c);
         setFormula(row, labelCols + c, `SUM(${L}${first}:${L}${row - 1})`, c < width ? sum(rows.map((fr) => fr.values[c])) : sum(rows.map((fr) => sum(fr.values))));
      }
   }

   // Notes under the table (e.g. staff category definitions), as in the template.
   if (spec.footer) {
      const [f0, f1] = spec.footer;
      for (let r = f0; r <= f1; r++) copyRow(r, row + r - f0, true);
      copyMerges(f0, f1, row - f0);
   }

   // Data issues on their own sheet, so the table sheet matches the template.
   if (data.gaps.length) {
      const notes = wb.addWorksheet('DATA NOTES');
      notes.getColumn(1).width = 120;
      notes.getCell(1, 1).value = 'Data notes for this table (not part of the GTEC return)';
      notes.getCell(1, 1).font = { bold: true };
      data.gaps.forEach((g, i) => {
         const c = notes.getCell(i + 3, 1);
         c.value = `• ${g}`;
         c.alignment = { wrapText: true, vertical: 'top' };
      });
   }
   return { file: data.file, workbook: wb };
}
