import { prisma } from "../prisma/client";
import { paramStr } from "../util/paramStr";
import { Request, Response } from "express";
import moment from 'moment'
const eva = prisma;

// Gates whether a student-facing endpoint (fetchQuestions/fetchGuides) may
// serve a given evaluationForm right now: it must be enabled, the current
// time must fall within its open/close window (if set), and — when the
// form has a year-group allow-list — the requesting student's computed
// year group must be in it. No allow-list rows means open to every year
// group. An unrecognized caller is denied access to a year-restricted
// form (safe default, same spirit as the per-question yearGroup rule).
async function isFormOpen(form: { id: string; status: boolean; startDate: Date | null; endDate: Date | null }, userId?: string): Promise<boolean> {
    if (!form.status) return false;

    if (form.startDate || form.endDate) {
        const now = moment();
        if (form.startDate && now.isBefore(moment(form.startDate))) return false;
        if (form.endDate && now.isAfter(moment(form.endDate))) return false;
    }

    const allowed = await eva.evaluationFormYearGroup.findMany({ where: { formId: form.id }, select: { yearGroup: true } });
    if (allowed.length === 0) return true;

    let studentYearGroup: number | null = null;
    if (userId) {
        const student = await eva.student.findUnique({ where: { id: userId }, select: { semesterNum: true } });
        if (student?.semesterNum) studentYearGroup = Math.ceil(student.semesterNum / 2);
    }
    if (studentYearGroup == null) return false;

    return allowed.some((r) => r.yearGroup === studentYearGroup);
}

// Resolves the currently-active session for a student. There's no more
// MAIN/January-SUB stream split (session.tag is always null now, and only
// one session can be the default at a time) -- just the one default session.
async function resolveActiveSession(student: { entryDate?: Date | null; semesterNum?: number | null } | null | undefined): Promise<any> {
    return await eva.session.findFirst({ where: { default: true } });
}

// Shared by fetchForms and fetchAvailableForms: a student's evaluation
// status for one form is 'completed' once every one of their registered
// courses this session has a matching courseEvaluation row for that form,
// 'started' if some (or none) are done yet, or 'not started'/'not
// registered' if they have nothing assessed at all this session. Takes an
// already-resolved student (callers own the "student not found" 404 case).
async function getEvaluationStatusForStudent(student: { indexno?: string | null }, formKey: string): Promise<{ status: string; data: any[] }> {
    const evalForm = await eva.evaluationForm.findUnique({ where: { key: formKey } });
    const indexno = student.indexno || undefined;
    const sessions: any = await eva.session.findMany({ where: { default: true } });
    let options: any = await eva.assessment.findMany({
        where: { sessionId: { in: sessions.map((r: any) => r.id) }, indexno },
        select: { course: { select: { id: true, title: true } } }
    });

    if (options.length) {
        options = options.map((r: any) => r.course);
        const takenEvals: any = evalForm ? await eva.courseEvaluation.findMany({
            where: {
                courseId: { in: options.map((r: any) => r.id) },
                sessionId: { in: sessions.map((r: any) => r.id) },
                formId: evalForm.id,
                indexno
            },
            include: { session: true, student: { include: { program: true } } }
        }) : [];

        if (options.length && takenEvals.length == options.length) return { status: 'completed', data: takenEvals };
        return { status: 'started', data: options };
    }

    const inWindow = sessions.some((s: any) => s.evaluationStart && s.evaluationEnd && moment(new Date()).isBetween(moment(s.evaluationStart), moment(s.evaluationEnd)));
    return { status: inWindow ? 'not started' : 'not registered', data: options };
}

export default class EvaController {

    // Lists the courses a student must evaluate for a given form (defaults
    // to 'course') and whether they've already done so. Every evaluation
    // form is tied to the student's registered courses and an assessor
    // (staff/lecturer) for that course — this endpoint is shared by every
    // form, not just 'course', distinguished by the `form` query param.
    async fetchForms(req: Request, res: Response) {
        try {
            const id = paramStr(req.params.indexno);
            const formKey = paramStr(req.query.form as string) || 'course';
            const student: any = await eva.student.findUnique({ where: { id } });
            if (!student) {
                return res.status(404).json({ message: `no record found` });
            }
            const result = await getEvaluationStatusForStudent(student, formKey);
            res.status(200).json(result);
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Fetch Options for Likert scale questions
    async fetchOptions(req: Request, res: Response) {
        try {
            const options = await eva.evaluationOption.findMany({
                where: { status: true },
                orderBy: { orderNum: 'asc' },
                select: {
                    id: true,
                    option: true,
                    value: true,
                    orderNum: true
                }
            });
            if (options) {
                res.status(200).json(options);
            } else {
                res.status(204).json({ message: "No options found" });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Fetch Questions for the evaluation form. `form` distinguishes which
    // questionnaire to load — defaults to 'course' (the original, only
    // form this endpoint served) so the existing course-evaluation page
    // keeps working unchanged; pass ?form=sts for the STS coach appraisal.
    //
    // Also restricts by the requesting student's year group: a question
    // with yearGroup set is only visible to students in that year — the
    // same Math.ceil(semesterNum / 2) computation used everywhere else in
    // this codebase for "level" — while yearGroup: null questions (e.g.
    // course-evaluation ones, which apply to any student taking the
    // course) are visible to everyone. If the caller isn't a recognizable
    // student (no matching record, or no semesterNum on file), only the
    // null-yearGroup questions are returned — the safe default.
    async fetchQuestions(req: Request & any, res: Response) {
        try {
            const key = paramStr(req.query.form as string) || 'course';
            const form = await eva.evaluationForm.findUnique({ where: { key } });
            if (!form || !(await isFormOpen(form, req.userId))) {
                return res.status(200).json([]);
            }

            let studentYearGroup: number | null = null;
            if (req.userId) {
                const student = await eva.student.findUnique({ where: { id: req.userId }, select: { semesterNum: true } });
                if (student?.semesterNum) studentYearGroup = Math.ceil(student.semesterNum / 2);
            }

            const questions = await eva.evaluationQuestion.findMany({
                where: {
                    status: true,
                    formId: form.id,
                    ...(studentYearGroup != null
                        ? { OR: [{ yearGroup: studentYearGroup }, { yearGroup: null }] }
                        : { yearGroup: null }),
                },
                orderBy: { orderNum: 'asc' },
                select: {
                    id: true,
                    question: true,
                    category: true,
                    yearGroup: true,
                    type: true,
                    orderNum: true,
                    required: true
                }
            });

            if (questions) {
                res.status(200).json(questions);
            } else {
                res.status(204).json({ message: "No questions found" });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Fetch the instructional/rubric text for the evaluation form — general
    // guidance (yearGroup: null, e.g. the Likert-scale legend) plus
    // whichever year-group-specific rubric applies to the requesting
    // student, using the exact same visibility rule as fetchQuestions.
    async fetchGuides(req: Request & any, res: Response) {
        try {
            const key = paramStr(req.query.form as string) || 'course';
            const form = await eva.evaluationForm.findUnique({ where: { key } });
            if (!form || !(await isFormOpen(form, req.userId))) {
                return res.status(200).json([]);
            }

            let studentYearGroup: number | null = null;
            if (req.userId) {
                const student = await eva.student.findUnique({ where: { id: req.userId }, select: { semesterNum: true } });
                if (student?.semesterNum) studentYearGroup = Math.ceil(student.semesterNum / 2);
            }

            const guides = await eva.evaluationGuide.findMany({
                where: {
                    status: true,
                    formId: form.id,
                    ...(studentYearGroup != null
                        ? { OR: [{ yearGroup: studentYearGroup }, { yearGroup: null }] }
                        : { yearGroup: null }),
                },
                orderBy: { orderNum: 'asc' },
                select: {
                    id: true,
                    title: true,
                    description: true,
                    yearGroup: true,
                    orderNum: true,
                }
            });

            if (guides) {
                res.status(200).json(guides);
            } else {
                res.status(204).json({ message: "No guides found" });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Fetch Courses for dropdown
    async fetchCourses(req: Request, res: Response) {
        try {
            const courses = await eva.course.findMany({
                where: { status: true },
                select: {
                    id: true,
                    title: true
                },
                orderBy: { title: 'asc' }
            });

            if (courses) {
                res.status(200).json(courses);
            } else {
                res.status(204).json({ message: "No courses found" });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Fetch Staff for dropdown
    async fetchStaff(req: Request, res: Response) {
        try {
            const staff = await eva.staff.findMany({
                where: { status: true },
                select: {
                    staffNo: true,
                    fname: true,
                    lname: true
                },
                orderBy: { fname: 'asc' }
            });

            const formattedStaff = staff.map(s => ({
                staffNo: s.staffNo,
                name: `${s.fname} ${s.lname}`
            }));

            if (formattedStaff) {
                res.status(200).json(formattedStaff);
            } else {
                res.status(204).json({ message: "No staff found" });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Fetch Students for dropdown
    async fetchStudents(req: Request, res: Response) {
        try {
            const students = await eva.student.findMany({
                where: { completeStatus: false }, // Only active students
                select: {
                    indexno: true,
                    fname: true,
                    lname: true
                },
                orderBy: { fname: 'asc' }
            });

            const formattedStudents = students.map(s => ({
                indexno: s.indexno,
                name: `${s.fname} ${s.lname}`
            }));

            if (formattedStudents) {
                res.status(200).json(formattedStudents);
            } else {
                res.status(204).json({ message: "No students found" });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Fetch Sessions for dropdown
    async fetchSessions(req: Request, res: Response) {
        try {
            const sessions = await eva.session.findMany({
                where: { status: true },
                select: {
                    id: true,
                    title: true,
                    year: true,
                    semester: true
                },
                orderBy: { createdAt: 'desc' }
            });

            if (sessions) {
                res.status(200).json(sessions);
            } else {
                res.status(204).json({ message: "No sessions found" });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }


    // Submit an evaluation for any form ('form' defaults to 'course' — the
    // original, only form this endpoint served). Every form is tied to one
    // of the student's registered courses and an assessor (staff) for that
    // course — courseId is always required, and formId lets the same
    // course be evaluated separately under different forms.
    async submitEvaluation(req: Request & any, res: Response) {
        try {
            let { form, courseId, staffNo, sessionId, responses } = req.body;
            const formKey = paramStr(form) || 'course';
            console.log(req.body)

            if (!courseId) {
                return res.status(400).json({ message: "Course is required" });
            }

            const evalForm = await eva.evaluationForm.findUnique({ where: { key: formKey } });
            if (!evalForm) {
                return res.status(400).json({ message: "Unknown evaluation form" });
            }

            // Course keeps its existing, ungated behavior (already governed
            // by session.evaluationStart/End via fetchForms) — every other
            // form is gated by isFormOpen, same as fetchQuestions/fetchGuides.
            if (formKey !== 'course' && !(await isFormOpen(evalForm, req.userId))) {
                return res.status(403).json({ message: "This evaluation form is not currently open" });
            }

            // Get Student Info — derived from the verified token (req.userId
            // is the student's `id`/login tag), never trusted from the
            // request body. A client-supplied `indexno` here doesn't
            // actually match student.indexno (the frontend only has the
            // login tag available), which previously caused every
            // submission to fail with a foreign key violation on insert —
            // and trusting a client-supplied indexno at all would let one
            // student submit evaluations under another student's identity.
            const student: any = await eva.student.findFirst({ include: { program: { select: { schemeId: true, hasMajor: true } } }, where: { id: req.userId } })
            if (!student?.indexno) {
                return res.status(400).json({ message: "Student record not found" });
            }
            const indexno = student.indexno;
            const session = await resolveActiveSession(student);
            if (!session) {
                return res.status(400).json({ message: "No active session found for evaluation" });
            }
            sessionId = session.id;

            // Check if evaluation already exists
            let evaluation: any = await eva.courseEvaluation.findUnique({
                where: {
                  indexno_sessionId_courseId_formId: {
                      indexno,
                      sessionId,
                      courseId,
                      formId: evalForm.id
                  }
                }
            });

            if (!evaluation) {
                // Create new evaluation record
                evaluation = await eva.courseEvaluation.create({
                    data: {
                        courseId,
                        formId: evalForm.id,
                        staffNo,
                        indexno,
                        sessionId,
                        status: 'completed',
                        completedAt: new Date()
                    }
                });
            } else {
                // Update existing evaluation
                evaluation = await eva.courseEvaluation.update({
                    where: { id: evaluation.id },
                    data: {
                        staffNo,
                        status: 'completed',
                        completedAt: new Date()
                    }
                });
            }

            if (evaluation) {
                // Create individual response records
                const responsePromises = Object.entries(responses).map(async ([questionId, responseValue]) => {
                    const response = responseValue as string;

                    // For Likert questions, find the option ID
                    let optionId = null;
                    if (response && response !== '') {
                        const option = await eva.evaluationOption.findFirst({
                            where: { option: response, status: true }
                        });
                        if (option) {
                            optionId = option.id;
                        }
                    }

                    // Upsert — a resubmission (e.g. re-taking an already
                    // completed evaluation) hits the same evaluationId +
                    // questionId pair, which the unique constraint below
                    // would otherwise reject on a blind create.
                    return eva.evaluationResponse.upsert({
                        where: {
                            evaluationId_questionId: {
                                evaluationId: evaluation?.id,
                                questionId
                            }
                        },
                        create: {
                            evaluationId: evaluation?.id,
                            questionId,
                            optionId,
                            response: response || ''
                        },
                        update: {
                            optionId,
                            response: response || ''
                        }
                    });
                });

                await Promise.all(responsePromises);

                res.status(201).json({
                    message: "Evaluation submitted successfully",
                    data: evaluation
                });
            } else {
                res.status(500).json({ message: "Failed to submit evaluation" });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Lists every evaluation form currently open (per isFormOpen) for the
    // requesting student, powering the student portal's evaluation list
    // page. Every form works the same way (a set of registered courses to
    // evaluate, each with its own assessor) — completion is inherently a
    // per-course concept handled inside fetchForms's own status field once
    // the student opens a specific form, not a single boolean here.
    async fetchAvailableForms(req: Request & any, res: Response) {
        try {
            const forms = await eva.evaluationForm.findMany({ orderBy: { createdAt: 'asc' } });
            const student = req.userId ? await eva.student.findUnique({ where: { id: req.userId } }) : null;

            const result: any[] = [];
            for (const form of forms) {
                if (!(await isFormOpen(form, req.userId))) continue;
                const completed = student ? (await getEvaluationStatusForStudent(student, form.key)).status === 'completed' : false;
                result.push({ id: form.id, key: form.key, name: form.name, description: form.description, completed });
            }

            res.status(200).json(result);
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Get Evaluation Tracking Statistics
    async getEvaluationTrackingStats(req: Request, res: Response) {
        try {
            const { sessionId, courseId } = req.query;

            let whereClause: any = {};
            if (sessionId) whereClause.sessionId = sessionId;
            if (courseId) whereClause.courseId = courseId;

            const stats = await eva.courseEvaluation.groupBy({
                by: ['status'],
                where: whereClause,
                _count: {
                    id: true
                }
            });

            // Get total count
            const total = await eva.courseEvaluation.count({
                where: whereClause
            });

            // Get completion time statistics
            const completionStats = await eva.courseEvaluation.findMany({
                where: {
                    ...whereClause,
                    status: 'completed',
                    startedAt: { not: null },
                    completedAt: { not: null }
                },
                select: {
                    startedAt: true,
                    completedAt: true
                }
            });

            const avgCompletionTime = completionStats.length > 0
                ? completionStats.reduce((acc: number, stat: any) => {
                    const duration = new Date(stat.completedAt!).getTime() - new Date(stat.startedAt!).getTime();
                    return acc + duration;
                }, 0) / completionStats.length
                : 0;

            res.status(200).json({
                total,
                byStatus: stats,
                avgCompletionTimeMs: avgCompletionTime,
                avgCompletionTimeMinutes: Math.round(avgCompletionTime / (1000 * 60))
            });
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Fetch Evaluations (for admin/review)
    async fetchEvaluations(req: Request, res: Response) {
        const { page = 1, pageSize = 10, keyword = '' }: any = req.query;
        const offset = (page - 1) * pageSize;

        try {
            let searchCondition: any = {};

            if (keyword) {
                searchCondition = {
                    where: {
                        OR: [
                            { course: { title: { contains: keyword } } },
                            { lecturerName: { contains: keyword } }
                        ]
                    }
                };
            }

            const resp = await eva.$transaction([
                eva.courseEvaluation.count({
                    ...(searchCondition)
                }),
                eva.courseEvaluation.findMany({
                    ...(searchCondition),
                    skip: offset,
                    take: Number(pageSize),
                    include: {
                        course: true,
                        staff: true,
                        student: true,
                        session: true,
                        responses: {
                            include: {
                                question: true
                            }
                        }
                    },
                    orderBy: { createdAt: 'desc' }
                })
            ]);

            if (resp && resp[1]?.length) {
                res.status(200).json({
                    totalPages: Math.ceil(resp[0] / pageSize) || 0,
                    totalData: resp[1]?.length,
                    data: resp[1]
                });
            } else {
                res.status(204).json({ message: "No evaluations found" });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Fetch Single Evaluation
    async fetchEvaluation(req: Request, res: Response) {
        try {
            const evaluation = await eva.courseEvaluation.findUnique({
                where: { id: paramStr(req.params.id) }
            });

            if (evaluation) {
                res.status(200).json(evaluation);
            } else {
                res.status(404).json({ message: "Evaluation not found" });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Delete Evaluation
    async deleteEvaluation(req: Request, res: Response) {
        try {
            const evaluation = await eva.courseEvaluation.delete({
                where: { id: paramStr(req.params.id) }
            });

            if (evaluation) {
                res.status(200).json({ message: "Evaluation deleted successfully" });
            } else {
                res.status(404).json({ message: "Evaluation not found" });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Get Evaluation Statistics
    async getEvaluationStats(req: Request, res: Response) {
        try {
            // Course/lecturer stats only — scoped to courseId: not null so
            // non-course (sts/ims) submissions, which have no course.title,
            // don't crash the unguarded evaluation.course.title access below.
            const totalEvaluations = await eva.courseEvaluation.count({ where: { courseId: { not: null } } });

            // Get all evaluations for analysis
            const evaluations = await eva.courseEvaluation.findMany({
                where: { courseId: { not: null } },
                include: {
                    course: true,
                    staff: true
                }
            });

            // Basic stats
            const courseStats: any = {};
            const lecturerStats: any = {};

            evaluations.forEach((evaluation) => {
                const courseName = evaluation.course?.title ?? 'Unknown';
                const lecturerName = evaluation.staff ? `${evaluation.staff.fname} ${evaluation.staff.lname}` : 'Unknown';

                // Count by course
                if (!courseStats[courseName]) {
                    courseStats[courseName] = { count: 0, lecturers: new Set() };
                }
                courseStats[courseName].count++;
                courseStats[courseName].lecturers.add(lecturerName);

                // Count by lecturer
                if (!lecturerStats[lecturerName]) {
                    lecturerStats[lecturerName] = { count: 0, courses: new Set() };
                }
                lecturerStats[lecturerName].count++;
                lecturerStats[lecturerName].courses.add(courseName);
            });

            // Convert Sets to arrays for JSON response
            Object.keys(courseStats).forEach(course => {
                courseStats[course].lecturers = Array.from(courseStats[course].lecturers);
            });

            Object.keys(lecturerStats).forEach(lecturer => {
                lecturerStats[lecturer].courses = Array.from(lecturerStats[lecturer].courses);
            });

            res.status(200).json({
                totalEvaluations,
                courseStats,
                lecturerStats
            });
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }


    async loadData(req: Request, res: Response) {
        try {

            console.log('Seeding evaluation questions and options...');

            const courseForm = await eva.evaluationForm.upsert({
                where: { key: 'course' },
                update: {},
                create: { key: 'course', name: 'Course Evaluation' },
            });

            // Scoped to this form — a global count would (and did) stay
            // permanently blocked once STS/IMS questions exist.
            const existingCount = await eva.evaluationQuestion.count({ where: { formId: courseForm.id } });
            if (existingCount > 0) {
                console.log('Course evaluation questions already seeded, skipping...');
                return res.status(200).json({ message: 'Course evaluation questions already seeded' });
            }

            // Options are shared globally across every form — only seed the
            // base Likert set if nothing has created it yet (e.g. via STS/IMS).
            const existingOptionCount = await eva.evaluationOption.count();
            if (existingOptionCount === 0) {
                const options = [
                    { option: "Strongly Disagree", value: 1, orderNum: 1 },
                    { option: "Disagree", value: 2, orderNum: 2 },
                    { option: "Agree", value: 3, orderNum: 3 },
                    { option: "Strongly Agree", value: 4, orderNum: 4 },
                ];

                for (const option of options) {
                    await eva.evaluationOption.create({
                        data: option
                    });
                }

                console.log('Seeded evaluation options successfully!');
            }

            // Seed questions
            const questions = [
                // Course Content
                { question: "The course was well organized.", category: "Course Content", type: "likert", orderNum: 1, required: true },
                { question: "The instructor communicated course objectives and learning goals.", category: "Course Content", type: "likert", orderNum: 2, required: true },
                { question: "Assignments helped us to meet the course objectives and learning goals", category: "Course Content", type: "likert", orderNum: 3, required: true },
                { question: "Course requirements were clearly stated and followed", category: "Course Content", type: "likert", orderNum: 4, required: true },
                { question: "Required materials and books were helpful.", category: "Course Content", type: "likert", orderNum: 5, required: true },

                // Course Delivery
                { question: "The instructor came to class well prepared.", category: "Course Delivery", type: "likert", orderNum: 6, required: true },
                { question: "The instructor knows his/her subject", category: "Course Delivery", type: "likert", orderNum: 7, required: true },
                { question: "Course activities help students to problem solve and think critically.", category: "Course Delivery", type: "likert", orderNum: 8, required: true },
                { question: "Course activities make the subject matter meaningful.", category: "Course Delivery", type: "likert", orderNum: 9, required: true },
                { question: "The instructor is flexible in accommodating individual student needs.", category: "Course Delivery", type: "likert", orderNum: 10, required: true },
                { question: "The instructor returns homework in a timely manner", category: "Course Delivery", type: "likert", orderNum: 11, required: true },
                { question: "The instructor communicated course content clearly", category: "Course Delivery", type: "likert", orderNum: 12, required: true },
                { question: "The instructor taught in a way that helped me learn the subject", category: "Course Delivery", type: "likert", orderNum: 13, required: true },
                { question: "The instructor returned assignments and examinations in a timely manner.", category: "Course Delivery", type: "likert", orderNum: 14, required: true },
                { question: "The instructor was available outside of class (office hours, email, etc)", category: "Course Delivery", type: "likert", orderNum: 15, required: true },

                // Learning Environment
                { question: "The instructor treated students and their contributions with respect", category: "Learning Environment", type: "likert", orderNum: 16, required: true },
                { question: "The instructor generated enthusiasm for learning the subject matter", category: "Learning Environment", type: "likert", orderNum: 17, required: true },
                { question: "The instructor clearly explained the grading system", category: "Learning Environment", type: "likert", orderNum: 18, required: true },
                { question: "The instructor respects the opinions of and decisions of students", category: "Learning Environment", type: "likert", orderNum: 19, required: true },
                { question: "The instructor was sensitive to the needs of students", category: "Learning Environment", type: "likert", orderNum: 20, required: true },
                { question: "The instructor likes and respects students", category: "Learning Environment", type: "likert", orderNum: 21, required: true },
                { question: "The instructor helps you when you ask for help", category: "Learning Environment", type: "likert", orderNum: 22, required: true },
                { question: "The instructor is consistent and fair in discipline", category: "Learning Environment", type: "likert", orderNum: 23, required: true },

                // Course's Impact on You
                { question: "I have learned a lot in the course about this subject", category: "Course's Impact on You", type: "likert", orderNum: 24, required: true },
                { question: "The course improved my oral communication skills", category: "Course's Impact on You", type: "likert", orderNum: 25, required: true },
                { question: "The course improved my written communication skills", category: "Course's Impact on You", type: "likert", orderNum: 26, required: true },
                { question: "The course challenged me intellectually", category: "Course's Impact on You", type: "likert", orderNum: 27, required: true },

                // Open-ended questions
                { question: "What is one thing that you really liked about the course?", category: "Additional Feedback", type: "text", orderNum: 28, required: false },
                { question: "What is one thing that you can suggest to help improve this course?", category: "Additional Feedback", type: "text", orderNum: 29, required: false },
                { question: "Any other thoughts?", category: "Additional Feedback", type: "text", orderNum: 30, required: false },
            ];

            for (const q of questions) {
                await eva.evaluationQuestion.create({
                    data: { ...q, formId: courseForm.id }
                });
            }

            console.log('Seeded evaluation questions successfully!');
            return res.status(200).json({ message: `Seeded ${questions.length} course evaluation questions successfully` });

        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Seed the STS (Supported Teaching in School) coach appraisal
    // questionnaire — a separate form from course evaluation, grouped by
    // year group instead of course-content category. Reuses the existing
    // evaluationOption rows (Strongly Disagree..Strongly Agree) since the
    // source document uses the identical 4-point Likert scale, so no new
    // options are seeded here.
    async loadSTSData(req: Request, res: Response) {
        try {
            console.log('Seeding STS evaluation questions...');

            const stsForm = await eva.evaluationForm.upsert({
                where: { key: 'sts' },
                update: {},
                create: { key: 'sts', name: 'Supported Teaching in School Appraisal' },
            });

            // Scoped to this form — unlike loadData's global count guard,
            // this must not be blocked by the (already-seeded) course-eval
            // question count.
            const existingCount = await eva.evaluationQuestion.count({ where: { formId: stsForm.id } });
            if (existingCount > 0) {
                console.log('STS questions already seeded, skipping...');
                return res.status(200).json({ message: 'STS questions already seeded' });
            }

            const questions = [
                // STS ACTIVITY – YEAR ONE
                { question: "My coach supports me to become familiar with the organisation of the school, including its culture and key education policies.", category: "STS ACTIVITY – YEAR ONE", form: "sts", yearGroup: 1, type: "likert", orderNum: 1, required: true },
                { question: "My coach supports me to become familiar with the key features of the Basic School Curriculum.", category: "STS ACTIVITY – YEAR ONE", form: "sts", yearGroup: 1, type: "likert", orderNum: 2, required: true },
                { question: "My coach supports me to become familiar with classroom teaching and learning involving both whole-class and small-group activities.", category: "STS ACTIVITY – YEAR ONE", form: "sts", yearGroup: 1, type: "likert", orderNum: 3, required: true },
                { question: "My coach supports me to learn how to conduct a small-scale classroom enquiry involving four (4) learners.", category: "STS ACTIVITY – YEAR ONE", form: "sts", yearGroup: 1, type: "likert", orderNum: 4, required: true },
                { question: "My coach assists me to develop a deeper understanding of practices that promote teacher professionalism.", category: "STS ACTIVITY – YEAR ONE", form: "sts", yearGroup: 1, type: "likert", orderNum: 5, required: true },
                { question: "My coach supports me to continuously develop and build my professional teaching portfolio.", category: "STS ACTIVITY – YEAR ONE", form: "sts", yearGroup: 1, type: "likert", orderNum: 6, required: true },

                // STS ACTIVITY – YEAR TWO
                { question: "My coach supports me to become familiar with the organisation of the school, including its culture and key education policies.", category: "STS ACTIVITY – YEAR TWO", form: "sts", yearGroup: 2, type: "likert", orderNum: 7, required: true },
                { question: "My coach supports me to become familiar with the key features of the Basic School Curriculum.", category: "STS ACTIVITY – YEAR TWO", form: "sts", yearGroup: 2, type: "likert", orderNum: 8, required: true },
                { question: "My coach supports me to become familiar with classroom teaching and learning involving both whole-class and small-group activities.", category: "STS ACTIVITY – YEAR TWO", form: "sts", yearGroup: 2, type: "likert", orderNum: 9, required: true },
                { question: "My coach supports me to learn how to conduct a small-scale classroom enquiry involving four (4) learners.", category: "STS ACTIVITY – YEAR TWO", form: "sts", yearGroup: 2, type: "likert", orderNum: 10, required: true },
                { question: "My coach assists me to develop a deeper understanding of practices that promote teacher professionalism.", category: "STS ACTIVITY – YEAR TWO", form: "sts", yearGroup: 2, type: "likert", orderNum: 11, required: true },
                { question: "My coach supports me to continuously develop and build my professional teaching portfolio.", category: "STS ACTIVITY – YEAR TWO", form: "sts", yearGroup: 2, type: "likert", orderNum: 12, required: true },

                // STS ACTIVITY – YEAR THREE
                { question: "My coach supports me to observe, teach and motivate a small group of learners and assists me with my induction into School 3.", category: "STS ACTIVITY – YEAR THREE", form: "sts", yearGroup: 3, type: "likert", orderNum: 13, required: true },
                { question: "My coach supports me to identify and discuss leadership qualities required in the classroom setting.", category: "STS ACTIVITY – YEAR THREE", form: "sts", yearGroup: 3, type: "likert", orderNum: 14, required: true },
                { question: "My coach supports me to plan and develop activities that will help me achieve the targets set for the National Teachers' Standards (NTS).", category: "STS ACTIVITY – YEAR THREE", form: "sts", yearGroup: 3, type: "likert", orderNum: 15, required: true },
                { question: "My coach supports me to acquire the knowledge and skills required for co-planning sequences of lessons across the required subjects of the school curriculum.", category: "STS ACTIVITY – YEAR THREE", form: "sts", yearGroup: 3, type: "likert", orderNum: 16, required: true },
                { question: "My coach supports me to acquire the knowledge and skills required for co-teaching sequences of lessons across the required subjects of the school curriculum.", category: "STS ACTIVITY – YEAR THREE", form: "sts", yearGroup: 3, type: "likert", orderNum: 17, required: true },
                { question: "My coach supports me to acquire the knowledge and skills required for co-assessing lessons across the required subjects of the school curriculum.", category: "STS ACTIVITY – YEAR THREE", form: "sts", yearGroup: 3, type: "likert", orderNum: 18, required: true },
                { question: "My coach supports me to acquire the knowledge and skills needed to teach and motivate all learners.", category: "STS ACTIVITY – YEAR THREE", form: "sts", yearGroup: 3, type: "likert", orderNum: 19, required: true },
                { question: "My coach supports me to acquire the knowledge and skills needed to manage the learning of all learners.", category: "STS ACTIVITY – YEAR THREE", form: "sts", yearGroup: 3, type: "likert", orderNum: 20, required: true },
                { question: "My coach supports me to acquire the knowledge and skills needed to extend the learning of all learners.", category: "STS ACTIVITY – YEAR THREE", form: "sts", yearGroup: 3, type: "likert", orderNum: 21, required: true },
                { question: "My coach supports me to conduct a small-scale classroom enquiry into teaching and learners' learning.", category: "STS ACTIVITY – YEAR THREE", form: "sts", yearGroup: 3, type: "likert", orderNum: 22, required: true },
                { question: "My coach supports me to demonstrate leadership qualities in the wider school setting.", category: "STS ACTIVITY – YEAR THREE", form: "sts", yearGroup: 3, type: "likert", orderNum: 23, required: true },
                { question: "My coach supports me to provide evidence demonstrating how I am meeting the National Teachers' Standards (NTS).", category: "STS ACTIVITY – YEAR THREE", form: "sts", yearGroup: 3, type: "likert", orderNum: 24, required: true },
                { question: "My coach supports me to continuously develop and build my professional teaching portfolio.", category: "STS ACTIVITY – YEAR THREE", form: "sts", yearGroup: 3, type: "likert", orderNum: 25, required: true },
            ];

            for (const { form, ...q } of questions) {
                await eva.evaluationQuestion.create({ data: { ...q, formId: stsForm.id } });
            }

            console.log('Seeded STS evaluation questions successfully!');
            return res.status(200).json({ message: `Seeded ${questions.length} STS questions successfully` });

        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Seed the IMS (Student Evaluation of Lecturers) questionnaire — a
    // separate form from course evaluation and STS, accessible to every
    // student regardless of year group (yearGroup left null throughout).
    async loadIMSData(req: Request, res: Response) {
        try {
            console.log('Seeding IMS evaluation questions...');

            const imsForm = await eva.evaluationForm.upsert({
                where: { key: 'ims' },
                update: {},
                create: { key: 'ims', name: 'Student Evaluation of Lecturers (IMS)' },
            });

            const existingCount = await eva.evaluationQuestion.count({ where: { formId: imsForm.id } });
            if (existingCount > 0) {
                console.log('IMS questions already seeded, skipping...');
                return res.status(200).json({ message: 'IMS questions already seeded' });
            }

            // General instructions + scale legend — yearGroup left null since
            // IMS applies to every student regardless of year.
            const existingGuideCount = await eva.evaluationGuide.count({ where: { formId: imsForm.id } });
            if (existingGuideCount === 0) {
                await eva.evaluationGuide.create({
                    data: {
                        formId: imsForm.id,
                        yearGroup: null,
                        title: 'Instructions',
                        description: 'Please indicate the extent to which you agree or disagree with each statement by ticking (✓) the appropriate response.\n\nScale: SD = Strongly Disagree (1) | D = Disagree (2) | A = Agree (3) | SA = Strongly Agree (4)',
                        orderNum: 0,
                    }
                });
            }

            const categories = [
                { letter: "A", title: "Lecturer Attendance, Punctuality and Time Management", questions: [
                    "The lecturer was regular in attending scheduled classes.",
                    "The lecturer reported to class on time.",
                    "The lecturer ended lessons at the scheduled time.",
                    "The lecturer made effective use of the allocated instructional time.",
                    "The lecturer communicated appropriately when a scheduled class had to be changed or cancelled.",
                    "The lecturer made appropriate arrangements for missed lessons where necessary.",
                ]},
                { letter: "B", title: "Course Organisation and Preparation", questions: [
                    "The lecturer clearly explained the expected learning outcomes.",
                    "The lecturer provided and explained the course outline at the beginning of the course.",
                    "Lessons were well planned and organised.",
                    "The lecturer demonstrated adequate preparation for lessons.",
                    "Course content was presented in a logical sequence.",
                    "The lecturer covered the relevant course content within the semester.",
                    "Learning activities were aligned with the objectives of the course.",
                ]},
                { letter: "C", title: "Subject-Matter and Pedagogical Knowledge", questions: [
                    "The lecturer demonstrated strong knowledge of the subject matter.",
                    "The lecturer explained concepts accurately.",
                    "The lecturer explained difficult concepts in ways that students could understand.",
                    "The lecturer provided relevant examples to clarify concepts.",
                    "The lecturer related theoretical concepts to practical situations.",
                    "The lecturer responded appropriately to students' questions.",
                    "The lecturer demonstrated appropriate pedagogical knowledge for teaching the course.",
                ]},
                { letter: "D", title: "Teaching and Learning Methods", questions: [
                    "The lecturer used appropriate teaching methods.",
                    "The lecturer used a variety of teaching and learning approaches.",
                    "Teaching methods encouraged active student participation.",
                    "The lecturer encouraged students to ask questions.",
                    "The lecturer encouraged discussion and exchange of ideas.",
                    "The lecturer used examples, demonstrations or illustrations effectively.",
                    "Teaching approaches helped students develop understanding rather than rely only on memorisation.",
                    "The lecturer adjusted explanations when students experienced difficulty.",
                    "Lessons promoted critical thinking and problem-solving.",
                    "The lecturer encouraged independent learning.",
                ]},
                { letter: "E", title: "Student Engagement and Classroom Management", questions: [
                    "The lecturer maintained students' attention during lessons.",
                    "The lecturer created opportunities for meaningful student participation.",
                    "The lecturer managed classroom activities effectively.",
                    "The lecturer maintained an appropriate learning environment.",
                    "The lecturer encouraged collaboration among students where appropriate.",
                    "The lecturer motivated students to take responsibility for their learning.",
                    "The lecturer effectively managed disruptive behaviour where it occurred.",
                ]},
                { letter: "F", title: "Learning Resources and ICT Integration", questions: [
                    "The lecturer used appropriate teaching and learning resources.",
                    "Learning materials provided by the lecturer supported understanding of the course.",
                    "The lecturer made appropriate use of digital technologies in teaching.",
                    "The lecturer used presentations, videos, simulations or other digital resources where appropriate.",
                    "The lecturer guided students to relevant additional learning resources.",
                    "The lecturer used the College's approved digital/LMS platforms appropriately where applicable.",
                    "Technology was used to enhance learning rather than merely for presentation.",
                ]},
                { letter: "G", title: "Assessment Practices", questions: [
                    "Assessment requirements were clearly explained.",
                    "Assessment tasks were related to the content taught.",
                    "Assessment tasks were aligned with the intended learning outcomes.",
                    "The lecturer used appropriate forms of assessment.",
                    "Assessment tasks encouraged students to demonstrate understanding.",
                    "Assessment tasks encouraged critical thinking and application of knowledge.",
                    "The lecturer administered assessments fairly.",
                    "Assessment criteria were clearly communicated where appropriate.",
                    "The lecturer provided adequate opportunities for students to demonstrate their learning.",
                ]},
                { letter: "H", title: "Feedback and Remediation", questions: [
                    "The lecturer provided feedback on students' work.",
                    "Feedback was provided within a reasonable period.",
                    "Feedback helped students understand their strengths and areas for improvement.",
                    "The lecturer discussed common difficulties identified through assessment.",
                    "The lecturer provided additional explanation when students did not understand concepts.",
                    "Students experiencing learning difficulties received appropriate academic support.",
                    "The lecturer provided opportunities for students to improve their learning after feedback.",
                ]},
                { letter: "I", title: "Inclusivity, Equity and Respect", questions: [
                    "The lecturer treated students with respect.",
                    "The lecturer treated students fairly.",
                    "The lecturer created an inclusive learning environment.",
                    "Students were given reasonable opportunities to express their views.",
                    "The lecturer respected differences among students.",
                    "The lecturer avoided discrimination or unfair treatment.",
                    "The lecturer encouraged participation from different groups of students.",
                    "The lecturer responded appropriately to students with different learning needs.",
                ]},
                { letter: "J", title: "Professionalism and Ethical Conduct", questions: [
                    "The lecturer demonstrated professional conduct.",
                    "The lecturer communicated respectfully with students.",
                    "The lecturer maintained appropriate lecturer–student boundaries.",
                    "The lecturer demonstrated integrity in dealing with students.",
                    "The lecturer handled student information and academic matters appropriately.",
                    "The lecturer avoided favouritism in dealing with students.",
                    "The lecturer demonstrated behaviour worthy of emulation by student teachers.",
                ]},
                { letter: "K", title: "Accessibility and Academic Support", questions: [
                    "The lecturer was reasonably accessible to students for academic consultation.",
                    "The lecturer responded appropriately to students' academic concerns.",
                    "The lecturer provided guidance when students experienced academic difficulties.",
                    "The lecturer encouraged students to seek clarification when necessary.",
                    "The lecturer provided appropriate academic support outside normal lessons where necessary.",
                ]},
                { letter: "L", title: "Teacher-Education and Professional Relevance", questions: [
                    "The lecturer related course content to the teaching profession.",
                    "The lecturer helped students understand how course knowledge can be applied in schools.",
                    "The lecturer modelled effective teaching practices that student teachers could emulate.",
                    "The lecturer encouraged reflection on teaching and learning.",
                    "Learning activities contributed to the development of professional teaching competence.",
                    "The lecturer related lessons to classroom realities where appropriate.",
                    "The lecturer encouraged students to apply knowledge during Supported Teaching in School or other practical experiences where relevant.",
                    "The course contributed to students' development as competent professional teachers.",
                ]},
                { letter: "M", title: "Overall Teaching Effectiveness", questions: [
                    "The lecturer helped me understand the course content.",
                    "The lecturer stimulated my interest in the course.",
                    "The lecturer challenged me to think critically.",
                    "The lecturer contributed positively to my learning.",
                    "I developed relevant knowledge and skills through this course.",
                    "The lecturer met the major learning expectations of the course.",
                    "Overall, the lecturer was effective in teaching this course.",
                ]},
            ];

            let orderNum = 0;
            for (const cat of categories) {
                for (const question of cat.questions) {
                    orderNum++;
                    await eva.evaluationQuestion.create({
                        data: {
                            question,
                            category: `${cat.letter}. ${cat.title}`,
                            formId: imsForm.id,
                            yearGroup: null,
                            type: 'likert',
                            orderNum,
                            required: true,
                        }
                    });
                }
            }

            console.log(`Seeded ${orderNum} IMS evaluation questions successfully!`);
            return res.status(200).json({ message: `Seeded ${orderNum} IMS questions successfully` });

        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }


    /* Evaluation Forms (Admin — Evaluation Manager) */

    async fetchEvaluationForms(req: Request, res: Response) {
        const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
        const offset = (page - 1) * pageSize;
        let searchCondition: any = { orderBy: { createdAt: 'desc' } };
        try {
            if (keyword) searchCondition = {
                where: {
                    OR: [
                        { name: { contains: keyword } },
                        { key: { contains: keyword } },
                    ],
                },
                orderBy: { createdAt: 'desc' }
            };
            const resp = await eva.$transaction([
                eva.evaluationForm.count({ ...(searchCondition) }),
                eva.evaluationForm.findMany({
                    ...(searchCondition),
                    skip: offset,
                    take: Number(pageSize),
                    include: { _count: { select: { questions: true, guides: true } }, yearGroups: true },
                })
            ]);

            res.status(200).json({
                totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
                totalData: resp[1]?.length,
                data: resp[1],
            });
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    async fetchEvaluationForm(req: Request, res: Response) {
        try {
            const resp = await eva.evaluationForm.findUnique({
                where: { id: paramStr(req.params.id) },
                include: {
                    questions: { orderBy: { orderNum: 'asc' } },
                    guides: { orderBy: { orderNum: 'asc' } },
                    yearGroups: true,
                },
            });
            if (resp) {
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `no record found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    async postEvaluationForm(req: Request & any, res: Response) {
        try {
            const resp = await eva.evaluationForm.create({ data: { ...req.body } });
            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_FORM_CREATED`, user: req?.userId, meta: req.body } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `no records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    async updateEvaluationForm(req: Request & any, res: Response) {
        try {
            const resp = await eva.evaluationForm.update({
                where: { id: paramStr(req.params.id) },
                data: { ...req.body },
            });
            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_FORM_UPDATED`, user: req?.userId, meta: req.body } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `No records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Blocks physical deletion once any student has responded to one of this
    // form's questions — that response history shouldn't silently vanish.
    // Disable the form instead (status: false via updateEvaluationForm).
    async deleteEvaluationForm(req: Request & any, res: Response) {
        try {
            const id = paramStr(req.params.id);
            const responseCount = await eva.evaluationResponse.count({ where: { question: { formId: id } } });
            if (responseCount > 0) {
                return res.status(409).json({ message: `This form has ${responseCount} submitted response(s) — disable it instead of deleting.` });
            }
            // Catches an in-progress (started, zero-response) submission that
            // the responseCount check above wouldn't — deleting the form
            // while that row still points at it would violate the formId FK.
            const evalCount = await eva.courseEvaluation.count({ where: { formId: id } });
            if (evalCount > 0) {
                return res.status(409).json({ message: `This form has ${evalCount} student submission(s) — disable it instead of deleting.` });
            }

            const resp = await eva.$transaction(async (tx: any) => {
                await tx.evaluationFormYearGroup.deleteMany({ where: { formId: id } });
                await tx.evaluationGuide.deleteMany({ where: { formId: id } });
                await tx.evaluationQuestion.deleteMany({ where: { formId: id } });
                return tx.evaluationForm.delete({ where: { id } });
            });

            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_FORM_DELETED`, user: req?.userId, meta: req.body } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `No records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    async postEvaluationFormYearGroup(req: Request & any, res: Response) {
        try {
            const formId = paramStr(req.params.id);
            const { yearGroup } = req.body;
            const resp = await eva.evaluationFormYearGroup.create({ data: { formId, yearGroup: Number(yearGroup) } });
            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_FORM_YEAR_GROUP_ADDED`, user: req?.userId, meta: { formId, yearGroup } } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `no records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    async deleteEvaluationFormYearGroup(req: Request & any, res: Response) {
        try {
            const formId = paramStr(req.params.id);
            const yearGroup = Number(req.params.yearGroup);
            const resp = await eva.evaluationFormYearGroup.delete({
                where: { formId_yearGroup: { formId, yearGroup } },
            });
            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_FORM_YEAR_GROUP_REMOVED`, user: req?.userId, meta: { formId, yearGroup } } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `No records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    async postEvaluationQuestion(req: Request & any, res: Response) {
        try {
            const resp = await eva.evaluationQuestion.create({ data: { ...req.body } });
            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_QUESTION_CREATED`, user: req?.userId, meta: req.body } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `no records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    async updateEvaluationQuestion(req: Request & any, res: Response) {
        try {
            const resp = await eva.evaluationQuestion.update({
                where: { id: paramStr(req.params.id) },
                data: { ...req.body },
            });
            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_QUESTION_UPDATED`, user: req?.userId, meta: req.body } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `No records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Blocks physical deletion once a student has responded to this
    // question. The Evaluation Manager's nested editor should fall back to
    // disabling (status: false) instead when this happens.
    async deleteEvaluationQuestion(req: Request & any, res: Response) {
        try {
            const id = paramStr(req.params.id);
            const responseCount = await eva.evaluationResponse.count({ where: { questionId: id } });
            if (responseCount > 0) {
                return res.status(409).json({ message: `This question has ${responseCount} submitted response(s) — disable it instead of deleting.` });
            }

            const resp = await eva.evaluationQuestion.delete({ where: { id } });
            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_QUESTION_DELETED`, user: req?.userId, meta: req.body } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `No records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    async postEvaluationGuide(req: Request & any, res: Response) {
        try {
            const resp = await eva.evaluationGuide.create({ data: { ...req.body } });
            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_GUIDE_CREATED`, user: req?.userId, meta: req.body } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `no records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    async updateEvaluationGuide(req: Request & any, res: Response) {
        try {
            const resp = await eva.evaluationGuide.update({
                where: { id: paramStr(req.params.id) },
                data: { ...req.body },
            });
            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_GUIDE_UPDATED`, user: req?.userId, meta: req.body } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `No records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    async deleteEvaluationGuide(req: Request & any, res: Response) {
        try {
            const resp = await eva.evaluationGuide.delete({ where: { id: paramStr(req.params.id) } });
            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_GUIDE_DELETED`, user: req?.userId, meta: req.body } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `No records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    async postEvaluationOption(req: Request & any, res: Response) {
        try {
            const resp = await eva.evaluationOption.create({ data: { ...req.body } });
            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_OPTION_CREATED`, user: req?.userId, meta: req.body } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `no records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    async updateEvaluationOption(req: Request & any, res: Response) {
        try {
            const resp = await eva.evaluationOption.update({
                where: { id: paramStr(req.params.id) },
                data: { ...req.body },
            });
            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_OPTION_UPDATED`, user: req?.userId, meta: req.body } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `No records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

    // Options are shared globally across every form, so the blast radius of
    // an in-use delete is wider than a per-form question — block it the
    // same way, favoring disable (status: false) over losing response history.
    async deleteEvaluationOption(req: Request & any, res: Response) {
        try {
            const id = paramStr(req.params.id);
            const responseCount = await eva.evaluationResponse.count({ where: { optionId: id } });
            if (responseCount > 0) {
                return res.status(409).json({ message: `This option has ${responseCount} submitted response(s) — disable it instead of deleting.` });
            }

            const resp = await eva.evaluationOption.delete({ where: { id } });
            if (resp) {
                await eva.log.create({ data: { action: `EVALUATION_OPTION_DELETED`, user: req?.userId, meta: req.body } });
                res.status(200).json(resp);
            } else {
                res.status(202).json({ message: `No records found` });
            }
        } catch (error: any) {
            console.log(error);
            return res.status(500).json({ message: error.message });
        }
    }

}