// Shared by transcripts and graduation processing. Stored scores are never rounded.
export function numeric(value: unknown): number | null {
  if (value == null || (typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function gradeBand(score: unknown, grades: any): any | null {
  const value = numeric(score);
  if (value == null || !Array.isArray(grades)) return null;
  const bands = grades.map((band: any) => ({ ...band, min: numeric(band.min), max: numeric(band.max), gradepoint: numeric(band.gradepoint) }))
    .sort((a: any, b: any) => a.min - b.min);
  if (!bands.length || bands.some((b: any) => b.min == null || b.max == null || b.min > b.max || b.gradepoint == null || b.gradepoint < 0 || !b.grade)) return null;
  // Adjacent whole-mark bands such as 50–54 and 55–59 cover decimals up to 55.
  // Do not bridge genuinely missing bands or extend beyond the scheme's maximum.
  return bands.find((band: any, i: number) => {
    const next = bands[i + 1];
    const continuous = next && next.min > band.max && next.min <= band.max + 1;
    return value >= band.min && (continuous ? value < next.min : value <= band.max);
  }) ?? null;
}

export function assessmentGrade(row: any) {
  const incomplete = row.totalScore == null;
  const band = gradeBand(row.totalScore, row.scheme?.gradeMeta);
  const credit = numeric(row.credit);
  const valid = !incomplete && !!band && !['I', 'IC'].includes(String(band.grade).toUpperCase()) && credit != null && credit >= 0;
  const exclusionReason = incomplete ? 'Incomplete' : !valid ? 'Invalid grade or credit' : row.status !== true ? 'Unpublished' : null;
  return {
    grade: incomplete ? 'I' : valid ? band.grade : 'Invalid',
    gradepoint: valid ? band.gradepoint as number : null,
    validGrade: valid,
    includedInGpa: exclusionReason == null,
    exclusionReason,
  };
}

export function academicTotals(rows: any[]) {
  let credit = 0, gradepoint = 0, incomplete = 0, invalid = 0, unpublished = 0;
  const failed = new Set<string>(), passed = new Set<string>();
  for (const row of rows) {
    const result = assessmentGrade(row);
    if (row.totalScore == null) incomplete++;
    else if (!result.validGrade) invalid++;
    if (row.status !== true) unpublished++;
    if (!result.includedInGpa) continue;
    credit += Number(row.credit);
    gradepoint += Number(row.credit) * result.gradepoint!;
    const passMark = numeric(row.scheme?.passMark);
    if (passMark != null && row.courseId) {
      const course = String(row.courseId).trim().toUpperCase();
      (Number(row.totalScore) >= passMark ? passed : failed).add(course);
    }
  }
  const cgpa = credit ? Number((gradepoint / credit).toFixed(2)) : null;
  return { credit, gradepoint, gpa: cgpa, cgpa, incomplete, invalid, unpublished,
    failedCourses: [...failed].filter(course => !passed.has(course)).length };
}

export function transcriptGroups(rows: any[]) {
  const groups = new Map<string, { title: string; rows: any[] }>();
  for (const row of rows) {
    // Sessions with the same display title must still have separate totals.
    const key = row.sessionId;
    const group: { title: string; rows: any[] } = groups.get(key) ?? { title: row.session?.title ?? 'none', rows: [] };
    group.rows.push({ ...row, ...assessmentGrade(row), classes: row.scheme?.classMeta });
    groups.set(key, group);
  }
  const cumulative: any[] = [];
  return [...groups.values()].map(({ title, rows }) => {
    cumulative.push(...rows);
    const semester = academicTotals(rows), total = academicTotals(cumulative);
    return [title, rows, { ...semester, cgpa: total.cgpa, cumulativeCredit: total.credit,
      cumulativeGradepoint: total.gradepoint, cumulativeIncomplete: total.incomplete,
      cumulativeInvalid: total.invalid, cumulativeUnpublished: total.unpublished,
      failedCourses: total.failedCourses }];
  });
}
