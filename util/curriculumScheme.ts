export class CurriculumSchemeError extends Error {
  status = 400;
  code = 'CURRICULUM_SCHEME';
}

// A major-specific mount overrides a common mount of the same course.
// Never resolve conflicting duplicate mounts by database row order.
export function selectCurriculum(rows: any[], courseId: string, majorId?: string | null) {
  const candidates = rows.filter(r => r.courseId === courseId && (!r.majorId || r.majorId === majorId));
  const exact = majorId ? candidates.filter(r => r.majorId === majorId) : [];
  const matches = exact.length ? exact : candidates.filter(r => !r.majorId);
  if (!matches.length) throw new CurriculumSchemeError(`Course ${courseId} is not in the student's curriculum.`);
  if (matches.some(r => !r.schemeId)) throw new CurriculumSchemeError(`Select a grading scheme on the curriculum for ${courseId} before registration.`);
  if (new Set(matches.map(r => r.schemeId)).size > 1) throw new CurriculumSchemeError(`Conflicting curriculum grading schemes for ${courseId}. Please contact Registry.`);
  return matches[0];
}

export async function curriculumRows(db: any, student: any, semesterNum: number) {
  if (!student?.programId || !Number.isInteger(semesterNum) || semesterNum < 1)
    throw new CurriculumSchemeError('A valid student programme and semester are required.');
  return db.structure.findMany({ where: { programId: student.programId, semesterNum, status: true,
    OR: [{ majorId: null }, ...(student.majorId ? [{ majorId: student.majorId }] : [])] },
    include: { course: { select: { title: true, creditHour: true } }, major: { select: { shortName: true } } } });
}

export async function registrationCourses(db: any, student: any, courses: any[], sessionId: string, useCurrentSemester = true) {
  if (!student?.indexno) throw new CurriculumSchemeError('Student with an index number not found.');
  const result = [];
  const cache = new Map<number, any[]>();
  for (const course of courses) {
    const semesterNum = useCurrentSemester ? student.semesterNum : Number(course.semesterNum);
    if (!cache.has(semesterNum)) cache.set(semesterNum, await curriculumRows(db, student, semesterNum));
    const code = course.code || course.courseId;
    const mount = selectCurriculum(cache.get(semesterNum)!, code, student.majorId);
    // Ignore client-supplied scheme/credit/index/session values.
    result.push({ courseId: code, sessionId, schemeId: mount.schemeId, credit: mount.course.creditHour,
      semesterNum, indexno: student.indexno, type: 'N' });
  }
  if (new Set(result.map(r => r.courseId)).size !== result.length) throw new CurriculumSchemeError('A course can only be selected once.');
  return result;
}

export async function curriculumClassMeta(db: any, student: any) {
  if (!student?.programId) throw new CurriculumSchemeError('Student programme is missing.');
  const rows = await db.structure.findMany({ where: { programId: student.programId, status: true,
    OR: [{ majorId: null }, ...(student.majorId ? [{ majorId: student.majorId }] : [])] }, include: { scheme: { select: { classMeta: true } } } });
  if (!rows.length || rows.some((r: any) => !r.scheme?.classMeta)) throw new CurriculumSchemeError('Curriculum classification scheme is missing.');
  // Course grade bands may differ; award classification bands must agree.
  const canonical = (value: any): string => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  const bands = new Set(rows.map((r: any) => canonical(r.scheme.classMeta)));
  if (bands.size !== 1) throw new CurriculumSchemeError('Curriculum schemes have conflicting award classifications. Review before importing graduation results.');
  return rows[0].scheme.classMeta;
}

export async function curriculumSchemeId(db: any, body: any): Promise<string> {
  const value = body.schemeId ?? body.scheme_id;
  if (typeof value !== 'string' || !value.trim()) throw new CurriculumSchemeError('Select a grading scheme for this curriculum.');
  const scheme = await db.scheme.findUnique({ where: { id: value.trim() }, select: { id: true } });
  if (!scheme) throw new CurriculumSchemeError('The selected grading scheme does not exist.');
  return scheme.id;
}
