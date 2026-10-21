import { prisma } from "../prisma/client";
import { Prisma } from "@prisma/client";
import { Request, Response } from "express";
import moment from "moment";
import { friendlyDbError } from "../util/helper";
import { BillingError, billStudentWhere, studentBillAmount, studentTags, validateBill } from "../util/billing";
import { paramStr } from "../util/paramStr";
import { BILL_FIELDS, PAYMENT_FIELDS, diff, logRecords, pick } from "../util/auditLog";

const sms = require('../config/sms');
const fms = prisma;

// Recompute accountNet (sum of the ledger) for each student.
async function refreshAccountNet(studentIds: (string | null | undefined)[], db: any = fms) {
   for (const studentId of [...new Set(studentIds.filter(Boolean))] as string[]) {
      const bal: any = await db.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId } });
      await db.student.update({ where: { id: studentId }, data: { accountNet: bal?._sum?.amount || 0 } });
   }
}

async function lockBill(tx: any, id: string) {
   await tx.$queryRaw`SELECT id FROM fms_bill WHERE id = ${id} FOR UPDATE`;
   const bill = await tx.bill.findUnique({ where: { id } });
   if (!bill) throw new BillingError('Bill not found.', 404);
   return bill;
}

async function changeBillStudent(req: Request, res: Response, list: 'include' | 'exclude') {
   try {
      const tag = typeof req.body.tag === 'string' ? req.body.tag.trim() : '';
      const action = req.body.action;
      if (!tag || !['create', 'remove'].includes(action)) throw new BillingError('Provide a student ID or index number and a valid action.');
      const result = await fms.$transaction(async (tx) => {
         const bill = await lockBill(tx, paramStr(req.params.id));
         const matches = await tx.student.findMany({ where: { OR: [{ id: tag }, { indexno: tag }] } });
         if (matches.length !== 1) throw new BillingError('The student reference is missing or ambiguous. Use the student ID.');
         const student = matches[0];
         const aliases = [student.id, student.indexno];
         let included = studentTags(bill.includeStudentIds);
         let excluded = studentTags(bill.excludeStudentIds);
         if (list === 'include') {
            included = included.filter(value => !aliases.includes(value));
            excluded = excluded.filter(value => !aliases.includes(value));
            if (action === 'create') included.push(student.id);
            else excluded.push(student.id);
         } else {
            excluded = excluded.filter(value => !aliases.includes(value));
            if (action === 'create') excluded.push(student.id);
         }
         const updated = await tx.bill.update({ where: { id: bill.id }, data: { includeStudentIds: included, excludeStudentIds: excluded } });
         // Draft membership does not charge the student before publication.
         if (bill.posted) {
            const validated = { ...bill, ...validateBill(bill) };
            const target = billStudentWhere(validated);
            const natural = student.programId === target.programId && student.entryGroup === target.entryGroup
               && target.semesterNum.in.includes(student.semesterNum ?? 0) && !student.deferStatus && !student.completeStatus;
            const receives = (natural || included.some(value => aliases.includes(value))) && !excluded.some(value => aliases.includes(value));
            if (!receives) await tx.studentAccount.deleteMany({ where: { billId: bill.id, studentId: student.id } });
            else if (!await tx.studentAccount.findFirst({ where: { billId: bill.id, studentId: student.id } })) {
               await tx.studentAccount.create({ data: { billId: bill.id, studentId: student.id, sessionId: bill.sessionId,
                  type: 'BILL', narrative: bill.narrative, currency: bill.currency, amount: studentBillAmount(validated, student.semesterNum) } });
            }
            await refreshAccountNet([student.id], tx);
         }
         return { bill: updated, studentId: student.id };
      });
      await logRecords(req, `BILL_STUDENT_${list.toUpperCase()}_${action.toUpperCase()}`, 'fms_bill', [pick(result.bill, BILL_FIELDS)], { student: result.studentId });
      return res.status(200).json(result.bill);
   } catch (error: any) {
      console.error('Bill membership failed:', error);
      return res.status(error instanceof BillingError ? error.status : 500).json({ message: error instanceof BillingError ? error.message : friendlyDbError(error) });
   }
}

export default class FmsController {

   /* Reports */
   async loadReport(req: Request, res: Response) {
      try {
         let { type, program, major, year, session, service, start, end } = req.body;
         let resp: any = { type };

         if (type == 'payments') {

            // A blank filter means "all".
            let regs: any = await fms.$queryRaw`select s.id,s.fname,s.lname,s.mname,s.indexno,s.gender,s.semesterNum,t.amount,t.currency,t.transtag,t.createdAt,r.title as transtitle from fms_transaction t left join ais_student s on t.studentId = s.id left join fms_transtype r on t.transtypeId = r.id where 1=1 ${service ? Prisma.sql`and t.transtypeId = ${service}` : Prisma.empty} ${start ? Prisma.sql`and date(t.createdAt) >= date(${start})` : Prisma.empty} ${end ? Prisma.sql`and date(t.createdAt) <= date(${end})` : Prisma.empty} order by t.createdAt ASC`;
            if (regs.length) {
               regs = regs.map((r: any) => ({
                  'SERVICE TYPE': r?.transtitle,
                  'LAST NAME': r?.lname,
                  'FIRST NAME': r?.fname,
                  'MIDDLE NAME(S)': r?.mname,
                  'INDEX NUMBER': r?.indexno,
                  'STUDENT ID': r?.id,
                  'GENDER': r?.gender,
                  'YEAR': Math.ceil(r.semesterNum / 2),
                  'AMOUNT': r?.amount,
                  'CURRENCY': r?.currency,
                  'PAID ON': r.createdAt
               }))
               resp = { ...resp, data: regs }
            }

         } else if (type == 'bills') {
            // Program / session are optional filters (blank = all).
            let regs: any = await fms.$queryRaw`select s.id,s.fname,s.lname,s.mname,s.indexno,s.gender,s.semesterNum,s.entryGroup,p.shortName,t.amount,t.currency,t.createdAt,r.narrative as billtitle from fms_studaccount t left join ais_student s on t.studentId = s.id left join ais_program p on s.programId = p.id left join fms_bill r on t.billId = r.id where t.billId is not null ${program ? Prisma.sql`and s.programId = ${program}` : Prisma.empty} ${session ? Prisma.sql`and r.sessionId = ${session}` : Prisma.empty} order by t.createdAt asc`;

            // let regs:any = await fms.studentAccount.findMany({ 
            //    where: {
            //       billId: { not: null },
            //       studentId: { not: null },
            //       ... program && ({ student: { programId: program }}),
            //       ... major && ({ student: { majorId: major }}),
            //       ... mode && ({ student: { studyMode: mode }}),
            //       ... year && ({ student: { semesterNum: { in : [ (Number(year)*2), (Number(year)*2)-1 ] }}}),
            //    },
            //    include: { bill: true, student: { include: { program: true, major: true }} },
            //    // orderBy: [
            //    //    { student: { programId: 'asc' }},
            //    //    { student: { majorId: 'asc' }},
            //    //    { student: { semesterNum: 'asc' }},
            //    //    { student: { studyMode: 'asc' }},
            //    //    { student: { lname: 'asc' }},
            //    // ]
            // })
            if (regs.length) {
               // regs = regs.map((r:any) => ({
               //    'LAST NAME': r.student?.lname,
               //    'FIRST NAME': r.student?.fname,
               //    'MIDDLE NAME(S)': r.student?.mname,
               //    'INDEX NUMBER': r.student?.indexno,
               //    'STUDENT ID': r.student?.id,
               //    'STUDY MODE': r.student?.studyMode,
               //    'GENDER': r.student?.gender,
               //    'YEAR': Math.ceil(r.student?.semesterNum/2),
               //    'PROGRAM': r.student?.program?.shortName,
               //    'MAJOR': r.student?.major?.shortName,
               //    'BILL NAME': r.bill?.title,
               //    'BILL AMOUNT': r.bill?.amount,
               //    'BILL CURRENCY': r.bill?.currency,
               //    'STUDENT CATEGORY': r.student?.entryGroup
               // }))
               regs = regs.map((r: any) => ({
                  'LAST NAME': r?.lname,
                  'FIRST NAME': r?.fname,
                  'MIDDLE NAME(S)': r?.mname,
                  'INDEX NUMBER': r?.indexno,
                  'STUDENT ID': r?.id,
                  'GENDER': r?.gender,
                  'YEAR': Math.ceil(r?.semesterNum / 2),
                  'PROGRAM': r?.shortName,
                  'BILL NAME': r.billtitle,
                  'BILL AMOUNT': r?.amount,
                  'BILL CURRENCY': r?.currency,
                  'STUDENT CATEGORY': r?.entryGroup,
                  'STATUS': 'Posted'
               }))
            }

            // Bills not yet applied to any student account: one row per bill, no student details.
            const unposted: any = await fms.$queryRaw`select b.narrative as billtitle,b.amount,b.currency,b.type,p.shortName from fms_bill b left join ais_program p on b.programId = p.id where not exists (select 1 from fms_studaccount a where a.billId = b.id) ${program ? Prisma.sql`and b.programId = ${program}` : Prisma.empty} ${session ? Prisma.sql`and b.sessionId = ${session}` : Prisma.empty} order by b.createdAt asc`;
            regs = [...regs, ...unposted.map((r: any) => ({
               'LAST NAME': null,
               'FIRST NAME': null,
               'MIDDLE NAME(S)': null,
               'INDEX NUMBER': null,
               'STUDENT ID': null,
               'GENDER': null,
               'YEAR': null,
               'PROGRAM': r?.shortName,
               'BILL NAME': r.billtitle,
               'BILL AMOUNT': r?.amount,
               'BILL CURRENCY': r?.currency,
               'STUDENT CATEGORY': r?.type,
               'STATUS': 'Not posted'
            }))]
            if (regs.length) resp = { ...resp, data: regs }

         } else if (type == 'charges') {
            let regs: any = await fms.$queryRaw`select s.id,s.fname,s.lname,s.mname,s.indexno,s.gender,s.semesterNum,p.shortName,t.amount,t.currency,t.createdAt,t.title as chargetitle from fms_charge t left join ais_student s on t.studentId = s.id left join ais_program p on p.id = s.programId where 1=1 ${start ? Prisma.sql`and date(t.createdAt) >= date(${start})` : Prisma.empty} ${end ? Prisma.sql`and date(t.createdAt) <= date(${end})` : Prisma.empty} order by t.createdAt ASC`;

            // let regs:any = await fms.charge.findMany({ 
            //    where: {
            //       ... program && ({ student: { programId: program }}),
            //       ... major && ({ student: { majorId: major }}),
            //       ... mode && ({ student: { studyMode: mode }}),
            //       ... year && ({ semesterNum: { in : [ (Number(year)*2), (Number(year)*2)-1 ] }}),
            //    },
            //    include: { student: { include: { program: true, major: true }} },
            //    orderBy: [
            //       { student: { programId: 'asc' }},
            //       { student: { majorId: 'asc' }},
            //       { student: { semesterNum: 'asc' }},
            //       { student: { studyMode: 'asc' }},
            //       { student: { lname: 'asc' }},
            //    ]
            // })
            if (regs.length) {
               regs = regs.map((r: any) => ({
                  'LAST NAME': r?.lname,
                  'FIRST NAME': r?.fname,
                  'MIDDLE NAME(S)': r?.mname,
                  'INDEX NUMBER': r?.indexno,
                  'STUDENT ID': r?.id,
                  'YEAR': Math.ceil(r?.semesterNum / 2),
                  'PROGRAM': r?.shortName,
                  'CHARGE NAME': r.chargetitle,
                  'CHARGE AMOUNT': r?.amount,
                  'CHARGE CURRENCY': r?.currency,
                  'CHARGE DATE': r?.createdAt,
               }))
               resp = { ...resp, data: regs }
            }

         } else if (type == 'debtors') {
            let regs: any = await fms.student.findMany({
               where: {
                  //completeStatus: false,
                  accountNet: { gt: 0 },
                  ...program && ({ programId: program }),
                  ...major && ({ majorId: major }),
                  ...year && ({ semesterNum: { in: [(Number(year) * 2), (Number(year) * 2) - 1] } }),
               },
               include: { program: true, major: true },
               orderBy: [
                  { programId: 'asc' },
                  { majorId: 'asc' },
                  { semesterNum: 'asc' },
                  { lname: 'asc' },
               ]
            })
            if (regs.length) {
               regs = regs.map((r: any) => ({
                  'LAST NAME': r.lname,
                  'FIRST NAME': r.fname,
                  'MIDDLE NAME(S)': r.mname,
                  'INDEX NUMBER': r.indexno,
                  'STUDENT ID': r.id,
                  'GENDER': r.gender,
                  'YEAR': Math.ceil(r.semesterNum / 2),
                  'PROGRAM': r.program?.shortName,
                  'MAJOR': r.major?.shortName,
                  'STUDENT ACCOUNT NET': r.accountNet,
               }))
               resp = { ...resp, data: regs }
            }

         } else if (type == 'balances') {
            // Basic financial report: every student's account balance
            // (accountNet -- positive = owing, negative = in credit).
            // Program / year are optional filters; blank = every student.
            let regs: any = await fms.student.findMany({
               where: {
                  ...program && ({ programId: program }),
                  ...year && ({ semesterNum: { in: [(Number(year) * 2), (Number(year) * 2) - 1] } }),
               },
               select: { id: true, fname: true, mname: true, lname: true, semesterNum: true, accountNet: true, program: { select: { longName: true } } },
               orderBy: [
                  { programId: 'asc' },
                  { semesterNum: 'asc' },
                  { lname: 'asc' },
                  { fname: 'asc' },
               ]
            })
            if (regs.length) {
               regs = regs.map((r: any) => ({
                  'STUDENT ID': r.id,
                  'NAME': [r.fname, r.mname, r.lname].filter(Boolean).join(' '),
                  'PROGRAM': r.program?.longName || '',
                  'YEAR': r.semesterNum ? Math.ceil(r.semesterNum / 2) : '',
                  'BALANCE': Math.round((Number(r.accountNet) || 0) * 100) / 100,
               }))
               resp = { ...resp, data: regs }
            }

         } else if (type == 'eligible') {
            let regs: any = await fms.student.findMany({
               where: {
                  OR: [
                     { accountNet: { lte: 0 } },
                     { flagPardon: true },
                  ],
                  AND: [
                     { completeStatus: false },
                     { ...program && ({ programId: program }) },
                     { ...major && ({ majorId: major }) },
                     { ...year && ({ semesterNum: { in: [(Number(year) * 2), (Number(year) * 2) - 1] } }) },
                  ],
               },
               include: { program: true, major: true },
               orderBy: [
                  { programId: 'desc' },
                  { majorId: 'asc' },
                  { semesterNum: 'asc' },
                  { lname: 'asc' },
               ]
            })
            if (regs.length) {
               regs = regs.map((r: any) => ({
                  'LAST NAME': r.lname,
                  'FIRST NAME': r.fname,
                  'MIDDLE NAME(S)': r.mname,
                  'INDEX NUMBER': r.indexno,
                  'STUDENT ID': r.id,
                  'GENDER': r.gender,
                  'YEAR': Math.ceil(r.semesterNum / 2),
                  'PROGRAM': r.program?.shortName,
                  'MAJOR': r.major?.shortName,
                  'STATUS': r.deferStatus == 1 ? 'Deferred' : 'Active',
               }))
               resp = { ...resp, data: regs }
            }
         }

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Dashboard & Statistics */
   async loadDashboard(req: Request, res: Response) {
      try {
         // Every figure below comes from a handful of grouped queries (the old
         // version ran four per payment type). Sums are doubles, counts come
         // back as BigInt -- num() makes both plain numbers for JSON.
         const num = (v: any) => Number(v) || 0;

         // Collections per payment type for each period, plus the same point in
         // the previous period (yesterday so far, last week so far, ...) for the
         // dashboard's comparisons. transtypeId 2 = academic fees.
         const byType: any[] = await fms.$queryRaw`
            select transtypeId,
               sum(case when date(createdAt) = curdate() then amount else 0 end) as today,
               sum(case when createdAt >= curdate() - interval 1 day and createdAt < now() - interval 1 day then amount else 0 end) as todayPrev,
               sum(case when yearweek(createdAt) = yearweek(now()) then amount else 0 end) as week,
               sum(case when yearweek(createdAt) = yearweek(now() - interval 7 day) and createdAt < now() - interval 7 day then amount else 0 end) as weekPrev,
               sum(case when createdAt >= date_format(now(), '%Y-%m-01') then amount else 0 end) as month,
               sum(case when createdAt >= date_format(now() - interval 1 month, '%Y-%m-01') and createdAt < now() - interval 1 month then amount else 0 end) as monthPrev,
               sum(case when year(createdAt) = year(now()) then amount else 0 end) as year,
               sum(case when year(createdAt) = year(now()) - 1 and createdAt < now() - interval 1 year then amount else 0 end) as yearPrev,
               sum(date(createdAt) = curdate()) as todayCount,
               sum(yearweek(createdAt) = yearweek(now())) as weekCount,
               sum(createdAt >= date_format(now(), '%Y-%m-01')) as monthCount,
               sum(year(createdAt) = year(now())) as yearCount
            from fms_transaction
            where createdAt >= date_format(now() - interval 1 year, '%Y-01-01')
            group by transtypeId`;
         const row = (id: number) => byType.find((r: any) => num(r.transtypeId) === id) || {};
         const periodOf = (r: any) => ({ today: num(r.today), week: num(r.week), month: num(r.month), year: num(r.year) });

         const types: any = await fms.transtype.findMany({ where: { id: { notIn: [2] } } }); // Transaction Types
         const trans = types.map((s: any) => ({
            label: (s.title?.replaceAll('FEES', '').replaceAll('FEE', ''))?.trim()?.toLowerCase() + ' payments',
            ...periodOf(row(s.id)),
         }));

         // All payment types together.
         const keys = ['today', 'todayPrev', 'week', 'weekPrev', 'month', 'monthPrev', 'year', 'yearPrev', 'todayCount', 'weekCount', 'monthCount', 'yearCount'];
         const periods: any = Object.fromEntries(keys.map((k) => [k, byType.reduce((a: number, r: any) => a + num(r[k]), 0)]));

         // Last 12 months, academic fees vs everything else (months with no
         // payments are filled in as zero).
         const months: any[] = await fms.$queryRaw`
            select date_format(createdAt, '%Y-%m') as ym,
               sum(case when transtypeId = 2 then amount else 0 end) as fees,
               sum(case when transtypeId = 2 then 0 else amount end) as other,
               count(*) as n
            from fms_transaction
            where createdAt >= date_format(now(), '%Y-%m-01') - interval 11 month
            group by ym`;
         const trend = Array.from({ length: 12 }, (_, i) => {
            const ym = moment().startOf('month').subtract(11 - i, 'months').format('YYYY-MM');
            const m = months.find((r: any) => r.ym === ym);
            return { ym, fees: num(m?.fees), other: num(m?.other), count: num(m?.n) };
         });

         // Receivables: current students' balances (accountNet -- positive =
         // owing, negative = in credit), overall and by year group.
         const rec: any[] = await fms.$queryRaw`
            select count(*) as students,
               sum(accountNet > 0) as debtors,
               sum(case when accountNet > 0 then accountNet else 0 end) as owed,
               sum(accountNet < 0) as inCredit,
               sum(case when accountNet < 0 then -accountNet else 0 end) as credit
            from ais_student where completeStatus = 0`;
         const r0 = rec[0] || {};
         const receivables = {
            students: num(r0.students), debtors: num(r0.debtors), owed: num(r0.owed), inCredit: num(r0.inCredit), credit: num(r0.credit),
            settled: num(r0.students) - num(r0.debtors) - num(r0.inCredit),
         };
         const recYear: any[] = await fms.$queryRaw`
            select ceil(semesterNum / 2) as yg, count(*) as students,
               sum(accountNet > 0) as debtors,
               sum(case when accountNet > 0 then accountNet else 0 end) as owed
            from ais_student
            where completeStatus = 0 and semesterNum > 0
            group by yg order by yg`;
         const receivablesByYear = recYear.map((r: any) => ({ year: num(r.yg), students: num(r.students), debtors: num(r.debtors), owed: num(r.owed) })).filter((r: any) => r.year >= 1);

         // Billed to the current (default) session(s).
         const sessions = await fms.session.findMany({ where: { default: true }, select: { id: true, title: true } });
         const billedAgg = sessions.length
            ? await fms.studentAccount.aggregate({ _sum: { amount: true }, where: { sessionId: { in: sessions.map((s: any) => s.id) }, type: { in: ['BILL', 'CHARGE'] } } })
            : null;

         // Latest payments.
         const recentRows = await fms.transaction.findMany({
            orderBy: { createdAt: 'desc' },
            take: 8,
            select: {
               id: true, amount: true, createdAt: true, payType: true, currency: true,
               transtype: { select: { title: true } },
               student: { select: { id: true, fname: true, lname: true } },
            },
         });

         let data = {
            feesPayment: periodOf(row(2)),
            otherPayment: trans,
            periods,
            trend,
            receivables,
            receivablesByYear,
            session: { titles: sessions.map((s: any) => s.title), billed: num(billedAgg?._sum?.amount) },
            recent: recentRows,
         }

         if (data) res.status(200).json(data)
         else res.status(204).json({ message: `no record found` })

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Bills */
   async fetchBillList(req: Request, res: Response) {
      try {
         const resp = await fms.bill.findMany({
            where: { status: true },
            include: { session: true, program: true, bankacc: true },
            orderBy: { createdAt: 'desc' }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchBills(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { id: { contains: keyword } },
                  { narrative: { contains: keyword } },
                  { session: { title: { contains: keyword } } },
                  { program: { shortName: { contains: keyword } } },
               ],
            }
         }
         const resp = await fms.$transaction([
            fms.bill.count({
               ...(searchCondition),
            }),
            fms.bill.findMany({
               ...(searchCondition),
               include: { session: true, program: true, bankacc: true },
               skip: offset,
               take: Number(pageSize),
               orderBy: { createdAt: 'desc' }
            })
         ]);

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchBill(req: Request, res: Response) {
      try {
         const resp = await fms.bill.findUnique({
            where: { id: paramStr(req.params.id) },
            include: { session: true, program: true, bankacc: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async includeBill(req: Request, res: Response) { return changeBillStudent(req, res, 'include'); }
   async excludeBill(req: Request, res: Response) { return changeBillStudent(req, res, 'exclude'); }

   async billReceivers(req: Request, res: Response) {
      try {
         const id = paramStr(req.params.id);
         if (!await fms.bill.findUnique({ where: { id }, select: { id: true } })) return res.status(404).json({ message: 'Bill not found.' });
         const rows = await fms.studentAccount.findMany({ where: { billId: id }, include: { student: true } });
         return res.status(200).json(rows);
      } catch (error: any) {
         console.error('Bill receivers failed:', error);
         return res.status(500).json({ message: 'Bill receivers could not be loaded. Please try again.' });
      }
   }

   async billActivity(req: Request, res: Response) {
      try {
         const resp = await fms.activityBill.findMany({
            where: { billId: paramStr(req.params.id) }
         })
         if (resp?.length) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(204).json({ message: error.message })
      }
   }

   async activateBill(req: Request, res: Response) {
      try {
         const id = paramStr(req.params.id);
         const result = await fms.$transaction(async (tx) => {
            // Claim the unpublished bill inside the transaction. Concurrent requests
            // serialize here; a failed publication rolls the flag and ledger back.
            const claim = await tx.bill.updateMany({ where: { id, posted: false }, data: { posted: true } });
            const bill = await tx.bill.findUnique({ where: { id } });
            if (!bill) throw new BillingError('Bill not found.', 404);
            if (!claim.count) throw new BillingError('This bill is already published. Revoke it before changing its recipients.', 409);
            if (!bill.status) throw new BillingError('This bill is inactive. Enable it before publishing.');
            const validated = { ...bill, ...validateBill(bill) };
            const select = { id: true, indexno: true, semesterNum: true };
            const targets = await tx.student.findMany({ where: billStudentWhere(validated), select });
            const included = studentTags(bill.includeStudentIds);
            const excluded = studentTags(bill.excludeStudentIds);
            const tags = [...new Set([...included, ...excluded])];
            const exceptions = tags.length ? await tx.student.findMany({ where: { OR: [{ id: { in: tags } }, { indexno: { in: tags } }] }, select }) : [];
            const resolve = (tag: string) => {
               const matches = exceptions.filter(st => st.id === tag || st.indexno === tag);
               if (matches.length !== 1) throw new BillingError(`Student reference ${tag} is missing or ambiguous. Correct the bill's inclusion/exclusion list.`);
               return matches[0];
            };
            const recipients = new Map(targets.map(st => [st.id, st]));
            included.forEach(tag => { const st = resolve(tag); recipients.set(st.id, st); });
            excluded.forEach(tag => recipients.delete(resolve(tag).id));
            const students = [...recipients.keys()];
            if (!students.length) throw new BillingError('No students match this bill. Check its programme, category and target years.');
            const existing = await tx.studentAccount.findMany({ where: { billId: id }, select: { studentId: true } });
            const billed = new Set(existing.map(row => row.studentId));
            const entries = [...recipients.values()].filter(st => !billed.has(st.id)).map(st => ({
               studentId: st.id, sessionId: bill.sessionId, billId: id, type: 'BILL' as const,
               narrative: bill.narrative, currency: bill.currency, amount: studentBillAmount(validated, st.semesterNum),
            }));
            if (entries.length) await tx.studentAccount.createMany({ data: entries });
            for (const studentId of students) {
               const balance = await tx.studentAccount.aggregate({ where: { studentId }, _sum: { amount: true } });
               await tx.student.update({ where: { id: studentId }, data: { accountNet: balance._sum.amount || 0 } });
            }
            await tx.activityBill.create({ data: { billId: id, amount: bill.amount, discount: bill.discount, receivers: students } });
            return { bill, studentsBilled: entries.length };
         }, { timeout: 60000 });
         await logRecords(req, 'BILL_POSTED', 'fms_bill', [pick(result.bill, BILL_FIELDS)], { studentsBilled: result.studentsBilled });
         return res.status(200).json(result.bill);
      } catch (error: any) {
         console.error('Bill publication failed:', error);
         return res.status(error instanceof BillingError ? error.status : 500).json({ message: error instanceof BillingError ? error.message : friendlyDbError(error) });
      }
   }

   async revokeBill(req: Request, res: Response) {
      try {
         const id = paramStr(req.params.id);
         const result = await fms.$transaction(async (tx) => {
            await lockBill(tx, id);
            const rows = await tx.studentAccount.findMany({ where: { billId: id }, select: { studentId: true } });
            await tx.studentAccount.deleteMany({ where: { billId: id } });
            const bill = await tx.bill.update({ where: { id }, data: { posted: false } });
            await refreshAccountNet(rows.map(row => row.studentId), tx);
            return { bill, removed: rows.length };
         }, { timeout: 60000 });
         await logRecords(req, 'BILL_REVOKED', 'fms_bill', [pick(result.bill, BILL_FIELDS)], { accountEntriesRemoved: result.removed });
         return res.status(200).json(result.bill);
      } catch (error: any) {
         console.error('Bill revocation failed:', error);
         return res.status(error instanceof BillingError ? error.status : 500).json({ message: error instanceof BillingError ? error.message : friendlyDbError(error) });
      }
   }

   async postBill(req: Request, res: Response) {
      try {
         const { programId, bankaccId, sessionId, ...fields } = validateBill(req.body);

         const resp = await fms.bill.create({
            data: {
               ...fields,
               currency: 'GHC', // the application only transacts in GHC
               ...sessionId && ({ session: { connect: { id: sessionId } } }),
               ...bankaccId && ({ bankacc: { connect: { id: bankaccId } } }),
               ...programId && ({ program: { connect: { id: programId } } }),
            }
         })
         if (resp) {
            await logRecords(req, 'BILL_CREATED', 'fms_bill', [pick(resp, BILL_FIELDS)]);
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(error instanceof BillingError ? error.status : 500).json({ message: error instanceof BillingError ? error.message : friendlyDbError(error) })
      }
   }

   async updateBill(req: Request, res: Response) {
      try {
         const data = validateBill(req.body);
         const id = paramStr(req.params.id);
         const { before, bill } = await fms.$transaction(async (tx) => {
            const before = await lockBill(tx, id);
            if (before.posted) throw new BillingError('Revoke the bill before editing its amount or target years.', 409);
            const bill = await tx.bill.update({ where: { id }, data });
            return { before, bill };
         });
         await logRecords(req, 'BILL_UPDATED', 'fms_bill', [{ id: bill.id, narrative: bill.narrative, changes: diff(before, bill, BILL_FIELDS) }]);
         return res.status(200).json(bill);
      } catch (error: any) {
         console.error('Bill update failed:', error);
         return res.status(error instanceof BillingError ? error.status : 500).json({ message: error instanceof BillingError ? error.message : friendlyDbError(error) });
      }
   }

   async deleteBill(req: Request, res: Response) {
      try {
         const before = await fms.bill.findUnique({ where: { id: paramStr(req.params.id) } });
         const accounts = await fms.studentAccount.findMany({ where: { billId: paramStr(req.params.id) }, select: { studentId: true } });
         const bs = await fms.bill.update({
            where: { id: paramStr(req.params.id) },
            data: {
               studentAccount: { deleteMany: { billId: paramStr(req.params.id) } }
            }
         })
         if (bs) {
            const resp = await fms.bill.delete({ where: { id: paramStr(req.params.id) } })
            // Removing a posted bill changes every billed student's balance.
            await refreshAccountNet(accounts.map((a: any) => a.studentId));
            await logRecords(req, 'BILL_DELETED', 'fms_bill', [pick(before, BILL_FIELDS)], { studentsAffected: new Set(accounts.map((a: any) => a.studentId)).size, accountEntriesRemoved: accounts.length });
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records deleted` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Charges */
   async fetchCharges(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { id: { contains: keyword } },
                  { title: { contains: keyword } },
                  { student: { id: { contains: keyword } } },
                  { student: { indexno: { contains: keyword } } },
                  { student: { fname: { contains: keyword } } },
                  { student: { lname: { contains: keyword } } },
               ],
            }
         }
         const resp = await fms.$transaction([
            fms.charge.count({
               ...(searchCondition),
            }),
            fms.charge.findMany({
               ...(searchCondition),
               include: { student: { include: { program: true } } },
               skip: offset,
               take: Number(pageSize),
               orderBy: { createdAt: 'desc' }
            })
         ]);

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchCharge(req: Request, res: Response) {
      try {
         const resp = await fms.charge.findUnique({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async lateCharge(req: Request, res: Response) {
      try {
         const { studentId } = req.body;
         const st: any = await fms.student.findUnique({ where: { id: studentId } });
         const charge: any = await fms.transtype.findFirst({ where: { id: 8 } })
         if (st && charge) {
            const fine = st?.entryGroup == 'GH' ? charge?.amountInGhc : charge?.amountInUsd;
            const resp = await fms.charge.create({
               data: {
                  title: `LATE REGISTRATION FINE`,
                  type: 'FINE',
                  currency: st.entryGroup == 'GH' ? 'GHC' : 'USD',
                  amount: parseFloat(fine),
                  posted: true,
                  ...studentId && ({ student: { connect: { id: studentId } } }),
                  studentAccount: {
                     createMany: {
                        data: { studentId: st?.id, currency: st.entryGroup == 'GH' ? 'GHC' : 'USD', amount: parseFloat(fine), type: 'CHARGE', narrative: `LATE REGISTRATION FINE` }
                     }
                  }
               }
            })
            // Retire Accounts
            const bal: any = await fms.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId } });
            await fms.student.update({ where: { id: studentId }, data: { accountNet: bal?._sum?.amount } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postCharge(req: Request, res: Response) {
      try {
         const { studentId } = req.body
         delete req.body.studentId;
         console.log(req.body)
         const resp = await fms.charge.create({
            data: {
               ...req.body,
               currency: 'GHC', // the application only transacts in GHC
               ...studentId && ({ student: { connect: { id: studentId } } }),
               studentAccount: {
                  createMany: {
                     data: [{
                        studentId,
                        narrative: "test",
                        amount: req?.body?.amount,
                        type: 'CHARGE',
                        currency: 'GHC',
                     }]
                  }
               }
            }
         })
         if (resp) {
            // Retire Account
            const bal: any = await fms.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId } });
            await fms.student.update({ where: { id: studentId }, data: { accountNet: bal?._sum?.amount } })
            // Create record in student account
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateCharge(req: Request, res: Response) {
      try {
         const { studentId } = req.body
         delete req.body.studentId;

         const resp = await fms.charge.update({
            where: { id: paramStr(req.params.id) },
            data: {
               ...req.body,
               currency: 'GHC', // the application only transacts in GHC
               ...studentId && ({ student: { connect: { id: studentId } } }),
               studentAccount: {
                  updateMany: {
                     where: { studentId },
                     data: {
                        studentId,
                        narrative: req?.body?.title,
                        amount: req?.body?.amount,
                        type: 'CHARGE',
                        currency: 'GHC',
                     }
                  }
               }
            }
         })
         if (resp) {
            // Retire Accounts
            const bal: any = await fms.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId } });
            await fms.student.update({ where: { id: studentId }, data: { accountNet: bal?._sum?.amount } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteCharge(req: Request, res: Response) {
      try {
         const bs = await fms.charge.update({
            where: { id: paramStr(req.params.id) },
            data: { studentAccount: { deleteMany: { chargeId: paramStr(req.params.id) } } }
         })
         if (bs) {
            const { studentId }: any = bs;
            const resp = await fms.charge.delete({ where: { id: paramStr(req.params.id) } })
            // Retire Account
            const bal: any = await fms.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId } });
            await fms.student.update({ where: { id: studentId }, data: { accountNet: bal?._sum?.amount } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records deleted` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Refunds -- posted like Charges: money paid back out to a student
      raises their account balance (accountNet; positive = owing), so a
      refund writes a POSITIVE studentAccount.amount, the same as charges
      and bills. Only payments are negative. (Refunds used to be written
      negative -- prisma/sql/2026-10-11_refund_positive_amounts.sql fixes
      those rows.) */
   async fetchRefunds(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { id: { contains: keyword } },
                  { title: { contains: keyword } },
                  { student: { id: { contains: keyword } } },
                  { student: { indexno: { contains: keyword } } },
                  { student: { fname: { contains: keyword } } },
                  { student: { lname: { contains: keyword } } },
               ],
            }
         }
         const resp = await fms.$transaction([
            fms.refund.count({
               ...(searchCondition),
            }),
            fms.refund.findMany({
               ...(searchCondition),
               include: { student: { include: { program: true } } },
               skip: offset,
               take: Number(pageSize),
               orderBy: { createdAt: 'desc' }
            })
         ]);

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchRefund(req: Request, res: Response) {
      try {
         const resp = await fms.refund.findUnique({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postRefund(req: Request, res: Response) {
      try {
         const { studentId } = req.body
         delete req.body.studentId;
         const amount = Number(req?.body?.amount);
         if (!(amount > 0)) return res.status(400).json({ message: 'Refund amount must be a number greater than zero.' });
         req.body.amount = amount;
         const resp = await fms.refund.create({
            data: {
               ...req.body,
               currency: 'GHC', // the application only transacts in GHC
               ...studentId && ({ student: { connect: { id: studentId } } }),
               studentAccount: {
                  createMany: {
                     data: [{
                        studentId,
                        narrative: req?.body?.title,
                        amount: req.body.amount,
                        type: 'REFUND',
                        currency: 'GHC',
                     }]
                  }
               }
            }
         })
         if (resp) {
            // Retire Account
            const bal: any = await fms.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId } });
            await fms.student.update({ where: { id: studentId }, data: { accountNet: bal?._sum?.amount } })
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateRefund(req: Request, res: Response) {
      try {
         const { studentId } = req.body
         delete req.body.studentId;
         const amount = Number(req?.body?.amount);
         if (!(amount > 0)) return res.status(400).json({ message: 'Refund amount must be a number greater than zero.' });
         req.body.amount = amount;

         const resp = await fms.refund.update({
            where: { id: paramStr(req.params.id) },
            data: {
               ...req.body,
               currency: 'GHC', // the application only transacts in GHC
               ...studentId && ({ student: { connect: { id: studentId } } }),
               studentAccount: {
                  updateMany: {
                     where: { refundId: paramStr(req.params.id) },
                     data: {
                        studentId,
                        narrative: req?.body?.title,
                        amount: req.body.amount,
                        type: 'REFUND',
                        currency: 'GHC',
                     }
                  }
               }
            }
         })
         if (resp) {
            // Retire Accounts
            const bal: any = await fms.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId } });
            await fms.student.update({ where: { id: studentId }, data: { accountNet: bal?._sum?.amount } })
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteRefund(req: Request, res: Response) {
      try {
         const bs = await fms.refund.update({
            where: { id: paramStr(req.params.id) },
            data: { studentAccount: { deleteMany: { refundId: paramStr(req.params.id) } } }
         })
         if (bs) {
            const { studentId }: any = bs;
            const resp = await fms.refund.delete({ where: { id: paramStr(req.params.id) } })
            const bal: any = await fms.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId } });
            await fms.student.update({ where: { id: studentId }, data: { accountNet: bal?._sum?.amount } })
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records deleted` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Payments */
   async fetchPayments(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition: any = { where: { transtypeId: { in: [2] } } }
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { id: { contains: keyword } },
                  { transtag: { contains: keyword } },
                  { student: { id: { contains: keyword } } },
                  { student: { indexno: { contains: keyword } } },
                  { student: { fname: { contains: keyword } } },
                  { student: { lname: { contains: keyword } } },
               ],
               AND: [
                  { transtypeId: { in: [2] } }
               ]
            }
         }
         const resp = await fms.$transaction([
            fms.transaction.count({
               ...(searchCondition),
            }),
            fms.transaction.findMany({
               ...(searchCondition),
               include: { student: { include: { program: true } }, transtype: true },
               skip: offset,
               take: Number(pageSize),
               orderBy: { createdAt: 'desc' }
            })
         ]);

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchPaymentOthers(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition: any = { where: { transtypeId: { notIn: [1, 2] } } }
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { id: { contains: keyword } },
                  { transtag: { contains: keyword } },
                  { student: { id: { contains: keyword } } },
                  { student: { indexno: { contains: keyword } } },
                  { student: { fname: { contains: keyword } } },
                  { student: { lname: { contains: keyword } } },
                  { transtype: { title: { contains: keyword } } },
               ],
               AND: [
                  { transtypeId: { notIn: [1, 2] } }
               ]
            }
         }
         const resp = await fms.$transaction([
            fms.transaction.count({
               ...(searchCondition),
            }),
            fms.transaction.findMany({
               ...(searchCondition),
               include: { student: { include: { program: true } }, transtype: true },
               skip: offset,
               take: Number(pageSize),
               orderBy: { createdAt: 'desc' }
            })
         ]);

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchPayment(req: Request, res: Response) {
      try {
         const resp = await fms.transaction.findUnique({
            where: { id: paramStr(req.params.id) },
            include: { student: { include: { program: true } }, transtype: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async convertPayment(req: Request, res: Response) {
      try {
         const { transactId, transtypeId } = req.body
         delete req.body.transactId; delete req.body.transactId;
         const narrative = `Payment of ${transtypeId == 8 ? 'Graduation' : transtypeId == 3 ? 'Resit' : transtypeId == 8 ? 'Late Registration' : 'Academic'} Fees`
         const before = await fms.transaction.findUnique({ where: { id: transactId } });
         const resp = await fms.transaction.update({
            where: { id: transactId },
            data: {
               ...transtypeId && ({ transtype: { connect: { id: transtypeId } } }),
               // If Fees,Late,Resit,Graduation transaction
               ...transtypeId && [2, 3, 4, 8].includes(Number(transtypeId)) && ({ studentAccount: { updateMany: { data: { narrative } } } }),
            }
         })
         if (resp) {
            await logRecords(req, 'PAYMENT_UPDATED', 'fms_transaction', [{ id: resp.id, transtag: resp.transtag, changes: diff(before, resp, PAYMENT_FIELDS) }], { student: resp.studentId, operation: 'convert service type' });
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postPayment(req: Request, res: Response) {
      try {
         const { studentId, transtypeId, bankaccId, collectorId, amount } = req.body
         delete req.body.studentId; delete req.body.transtypeId;
         delete req.body.bankaccId; delete req.body.collectorId;
         const narrative = `Payment of ${transtypeId == 8 ? 'Graduation' : transtypeId == 3 ? 'Resit' : transtypeId == 8 ? 'Late Registration' : 'Academic'} Fees`

         const st: any = await fms.student.findUnique({ where: { id: studentId }, select: { entryGroup: true, indexno: true } })
         const resp: any = await fms.transaction.create({
            data: {
               ...req.body,
               currency: 'GHC', // the application only transacts in GHC
               ...collectorId && ({ collector: { connect: { id: collectorId } } }),
               ...bankaccId && ({ bankacc: { connect: { id: bankaccId } } }),
               ...studentId && ({ student: { connect: { id: studentId } } }),
               ...transtypeId && ({ transtype: { connect: { id: transtypeId } } }),
               // If Fees,Late,Resit,Graduation transaction
               ...transtypeId && [2, 3, 4, 8].includes(Number(transtypeId)) && ({ studentAccount: { createMany: { data: [{ studentId, narrative, amount: (-1 * req?.body?.amount), type: 'PAYMENT', currency: 'GHC' }] } } }),
            }
         })
         if (resp) {
            await logRecords(req, 'PAYMENT_CREATED', 'fms_transaction', [pick(resp, PAYMENT_FIELDS)], { student: studentId, source: 'STAFF' });
            // Retire Student Account Balance after Fees,Late,Resit,Graduation transaction
            if ([2, 3, 4, 8].includes(Number(transtypeId))) {
               const bal: any = await fms.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId } });
               await fms.student.update({ where: { id: studentId }, data: { accountNet: bal?._sum?.amount } })
            }

            // If Resit - Run Resit operations
            if (transtypeId == 3) {
               // Retire Number of Resit Papers
               const resit_charge: any = await fms.transtype.findUnique({ where: { id: Number(transtypeId) } });
               const pay_count = amount / Math.floor((st?.entryGroup == 'INT' ? resit_charge?.amountInUsd : resit_charge?.amountInGhc));
               const resits: any = await fms.resit.findMany({ where: { indexno: st?.indexno, paid: false }, take: pay_count })
               const filters: any = resits?.map((r: any) => ({ indexno: r.indexno }))
               // Update Paid Status of resit_data or papers
               const ups = await fms.resit.updateMany({ where: { OR: filters, AND: [{ paid: false }] }, data: { paid: true } })
               // Get Paid Balance for Extra Resit
               const unsorted_courses = pay_count - ups?.count;
               const resit_balance = pay_count - ups?.count;
            }

            // If Transwift Transtypes - Run Transwift( Attestation, Proficiency, Introductory, Transcript) operations
            if ([5, 6, 9, 10].includes(Number(transtypeId))) {
               // Retire Number of Resit Papers
               const charge: any = await fms.transtype.findUnique({ where: { id: Number(transtypeId) } });
               const count = amount / Math.floor((st?.entryGroup == 'INT' ? charge?.amountInUsd : charge?.amountInGhc));
               // Create Transwift Requests for Payment
               const tw = await fms.transwift.upsert({
                  where: { transactId: resp?.id },
                  create: {
                     studentId,
                     transactId: resp?.id,
                     quantity: count
                  },
                  update: {}
               })
            }

            // If Late fine - Run Late fine operations

            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updatePayment(req: Request, res: Response) {
      try {
         const { studentId, transtypeId, bankaccId, collectorId } = req.body
         delete req.body.studentId; delete req.body.transtypeId;
         delete req.body.bankaccId; delete req.body.collectorId;
         const narrative = `Payment of ${transtypeId == 8 ? 'Graduation' : transtypeId == 3 ? 'Resit' : transtypeId == 8 ? 'Late Registration' : 'Academic'} Fees`
         const before = await fms.transaction.findUnique({ where: { id: paramStr(req.params.id) } });
         const resp = await fms.transaction.update({
            where: { id: paramStr(req.params.id) },
            data: {
               ...req.body,
               currency: 'GHC', // the application only transacts in GHC
               ...collectorId && ({ collector: { connect: { id: collectorId } } }),
               ...bankaccId && ({ bankacc: { connect: { id: bankaccId } } }),
               ...studentId && ({ student: { connect: { id: studentId } } }),
               ...transtypeId && ({ transtype: { connect: { id: transtypeId } } }),
               // If Fees,Late,Resit,Graduation transaction
               ...transtypeId && ['2', '3', '4', '8'].includes(transtypeId) && ({ studentAccount: { updateMany: { data: { studentId, narrative, amount: (-1 * req?.body?.amount), type: 'PAYMENT', currency: 'GHC' } } } }),
            }
         })
         if (resp) {
            await logRecords(req, 'PAYMENT_UPDATED', 'fms_transaction', [{ id: resp.id, transtag: resp.transtag, changes: diff(before, resp, PAYMENT_FIELDS) }], { student: resp.studentId || studentId });
            // Retire Student Account Balance after Fees,Late,Resit,Graduation transaction
            if (['2', '3', '4', '8'].includes(transtypeId)) {
               const bal: any = await fms.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId } });
               await fms.student.update({ where: { id: studentId }, data: { accountNet: bal?._sum?.amount } })
            }
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deletePayment(req: Request, res: Response) {
      try {
         const before = await fms.transaction.findUnique({ where: { id: paramStr(req.params.id) } });
         const bs = await fms.transaction.update({
            where: { id: paramStr(req.params.id) },
            data: {
               studentAccount: { deleteMany: { transactId: paramStr(req.params.id) } }
            }
         })
         if (bs) {
            const resp = await fms.transaction.delete({ where: { id: paramStr(req.params.id) } })
            // The payment's ledger entry is gone, so the balance must be recomputed.
            await refreshAccountNet([before?.studentId]);
            await logRecords(req, 'PAYMENT_DELETED', 'fms_transaction', [pick(before, PAYMENT_FIELDS)], { student: before?.studentId });
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records deleted` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Bank API Transactions  */

   async loadPayServices(req: Request, res: Response) {
      // LOAD_API_SERVICES
      try {
         const resp = await fms.transtype.findMany({
            where: { status: true, visibility: 'PUBLIC' },
            include: { bankacc: true }
         })
         if (resp?.length) {
            const data = resp?.map((row: any) => {
               return ({ serviceId: row.id, serviceName: row.title, serviceChargeInGHC: row.amountInGhc || 0, serviceChargeInUSD: row.amountInUsd || 0, bankAccount: row.bankacc ? row.bankacc.bankAccount : row.bankaccMeta || 'NONE' });
            });
            res.status(200).json({ success: true, data })
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async loadPayService(req: Request, res: Response) {
      try {
         const type: any = paramStr(req.params.type);
         const refno = paramStr(req.params.refno);
         if (refno && type != 1) {
            var dt, ft = 0;
            const st: any = await fms.student.findFirst({
               where: { OR: [{ id: refno }, { indexno: refno }] },
               include: { program: { select: { shortName: true, category: true } } }
            });
            if (st) {
               let bankAccount = "NONE";
               const sv: any = await fms.transtype.findFirst({ where: { id: 2 } });
               if (sv) {
                  bankAccount = sv?.bankaccMeta?.find((r: any) => r.category == st?.program?.category)?.bankAccount || 'NONE';
               }

               dt = {
                  studentId: st.id,
                  indexno: st.indexno,
                  name: `${st.fname} ${st.mname && st.mname + ' '}${st.lname}`,
                  program: st?.program?.shortName,
                  year: st.semesterNum ? Math.ceil(st.semesterNum / 2) : 'none',
                  serviceId: type,
                  bankAccount
               }

               if (type == 2) { /* Student Account Balance */
                  ft = st?.accountNet;

               } else if ([4, 8].includes(type)) { /* Graduation, Late Fine  Charges */
                  const ac = await fms.transtype.findUnique({ where: { id: Number(type) } });
                  if (ac) ft = st?.entryGroup == 'INT' ? (ac?.amountInUsd || 0) : (ac?.amountInGhc || 0);

               } else if (type == 3) { /* Resit Charges */
                  const rs: any = await fms.resit.count({ where: { paid: false, indexno: st?.indexno } });
                  const ac = await fms.transtype.findUnique({ where: { id: Number(type) } });
                  if (ac && rs) ft = st.entryGroup == 'INT' ? rs?.count * (ac.amountInUsd || 0) : rs?.count * (ac.amountInGhc || 0);
               }
               // Return Information
               return res.status(200).json({ success: true, data: { ...dt, serviceCharge: ft } });

            } else {
               return res.status(200).json({ success: false, data: null, msg: "Invalid Student ID or Index Number" });
            }


         } else {
            return res.status(403).json({ success: false, data: null, msg: "Invalid request" });
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async payService(req: Request & any, res: Response) {
      try {

         // Previously fms.vendor.findFirst() — vendor was an admissions-only
         // table removed along with the rest of the admission system.
         // transaction.collectorId's actual relation points at collector
         // (apiToken/apiEnabled fields, built for exactly this automated
         // Bank API payment flow), so this was corrected to use it.
         // The collector whose API token authenticated this request (see
         // middleware/requireBankCollector). Only during an unauthenticated
         // rollout (BANK_API_ALLOW_UNAUTHENTICATED) is the old fallback used.
         const cl: any = req.collector || (process.env.BANK_API_ALLOW_UNAUTHENTICATED === 'true' ? await fms.collector.findFirst() : null);
         let { serviceId, amountPaid, studentId, refNote, transRef, buyerName, buyerPhone } = req.body;
         serviceId = Number(serviceId)
         // Banks send amounts as numbers or formatted strings ("1,250.00",
         // "GHS 1,250.00") -- keep only digits/decimal point. The old
         // replace(",", "") only stripped the first comma and passed NaN
         // through to Prisma when the amount was missing or prefixed.
         amountPaid = parseFloat(String(amountPaid ?? req.body?.amount ?? "").replace(/[^0-9.]/g, ""))
         // The application only transacts in GHC (see postPayment); banks
         // send the ISO code "GHS", which isn't a member of the currency enum.
         const currency = 'GHC';

         if (!cl) return res.status(200).json({ success: false, data: null, msg: "Payment collector is not configured" });
         if (!Number.isFinite(amountPaid) || amountPaid <= 0) return res.status(200).json({ success: false, data: null, msg: "Invalid amount paid" });
         if (!transRef) return res.status(200).json({ success: false, data: null, msg: "Missing transaction reference" });

         const tr = await fms.transaction.findFirst({ where: { transtag: transRef } })

         let data: any = {
            collectorId: cl.id,
            transtypeId: serviceId,
            currency,
            amount: amountPaid,
            reference: refNote,
            studentId: studentId,
            transtag: transRef,
         };

        

         /* Voucher purchases (serviceId 1) were removed along with the admission system/portal. */
         if (serviceId == 1) {
            return res.status(200).json({ success: false, data: null, msg: `Voucher service no longer available` });

            /* OTHER PAYMENT SERVICE (ACADEMIC FEES, RESIT, GRADUATION, ATTESTATION, PROFICIENCY, TRANSCRIPT, LATE FINE ) */
         } else {
            /* PAY FOR SERVICES */
            const st: any = await fms.student.findFirst({ where: { OR: [{ id: studentId }, { indexno: studentId }] }, include: { program: { select: { prefix: true } } } });
            if (!st) return res.status(200).json({ success: false, data: null, msg: "Invalid Student ID or Index Number" });
            if (!tr) {
               const narrative = `Payment of ${serviceId == 8 ? 'Graduation' : serviceId == 3 ? 'Resit' : serviceId == 8 ? 'Late Registration' : 'Academic'} Fees`
               data = { ...data, studentId: st?.id }
               studentId = st?.id;
               const ins = await fms.transaction.create({
                  data: {
                     ...data,
                     ...serviceId && [2, 3, 4, 8].includes(serviceId) && ({ studentAccount: { createMany: { data: { studentId, narrative, currency, amount: (-1 * amountPaid), type: 'PAYMENT' } } } }),
                  }
               })

               if (ins) {
                  await logRecords(req, 'PAYMENT_CREATED', 'fms_transaction', [pick(ins, PAYMENT_FIELDS)], { student: studentId, user: 'BANK_API', source: 'BANK_API', collector: cl?.name });
                  if ([2, 3, 4, 8].includes(serviceId)) {
                     const bal: any = await fms.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId } });
                     await fms.student.update({ where: { id: studentId }, data: { accountNet: bal?._sum?.amount || 0 } })
                  }
                  /* For Resit Payments */
                  if (serviceId == 3) {
                     // Retire Number of Resit Papers
                     const resit_charge: any = await fms.transtype.findUnique({ where: { id: Number(serviceId) } });
                     const pay_count = Math.floor(amountPaid / (st?.entryGroup == 'INT' ? resit_charge?.amountInUsd : resit_charge?.amountInGhc));
                     const resits: any = await fms.resit.findMany({ where: { indexno: st?.indexno, paid: false }, take: pay_count })
                     const filters: any = resits?.map((r: any) => ({ indexno: r.indexno }))
                     // Update Paid Status of resit_data or papers
                     const ups = await fms.resit.updateMany({ where: { OR: filters, AND: [{ paid: false }] }, data: { paid: true } })
                  }

                  /* If Transwift Transtypes - Run Transwift( Attestation, Proficiency, Introductory, Transcript) operations */
                  if ([5, 6, 9, 10].includes(Number(serviceId))) {
                     // Retire Number of Documents
                     const charge: any = await fms.transtype.findUnique({ where: { id: Number(serviceId) } });
                     const count = amountPaid / Math.floor((st?.entryGroup == 'INT' ? charge?.amountInUsd : charge?.amountInGhc));
                     // Create Transwift Requests for Payment
                     const tw = await fms.transwift.upsert({
                        where: { transactId: ins?.id },
                        create: { studentId, transactId: ins?.id, quantity: count },
                        update: {}
                     })
                     // Send Follow-up SMS to Student
                     const msg = `Hi! Your document request has been processed, Please go into your portal [https://portal.akatsico.edu.gh] to update receipient and required information. Thank you.`;
                     const send = await sms(st?.phone, msg);
                  }

                  /* Index Number Generation For Freshers  */
                  if (serviceId == 2 && (st.semesterNum == st.entrySemesterNum)) {
                     // Get student account transaction & Bill + Quota
                     const cx: any = await fms.studentAccount.findFirst({ where: { studentId, type: 'BILL' }, include: { bill: { select: { quota: true } } } });
                     const px: any = await fms.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId, type: 'PAYMENT' } })
                     // Compare All Payments to Bill Quota
                     const isPassedIndex = (px?._sum?.amount >= (cx?.bill?.quota || 0) * cx?.amount);
                     // Generate Index 
                     if (!st?.indexno && isPassedIndex) {
                        let indexno;
                        // const students:any = await fms.$queryRaw`select * from fms_student where date_format(entryDate,'%m%y') = ${moment(st?.entryDate).format("mmyyyy")} and programId = ${st?.programId}`;
                        const students: any = await fms.$queryRaw`select * from ais_student where date_format(entryDate,'%m%y') = ${moment(st?.entryDate).format("MMYY")} and programId = ${st?.programId} and indexno is not null and (semesterNum = entrySemesterNum)`;

                        let studentCount = students?.length + 1;
                        let loop = true;
                        while (loop) {
                           // Compute Index Number
                           const count = studentCount.toString().length == 1 ? `000${studentCount}` : studentCount.toString().length == 2 ? `00${studentCount}` : studentCount.toString().length == 3 ? `0${studentCount}` : studentCount;
                           indexno = `${st?.program?.prefix}${moment(st?.entryDate || new Date()).format("MMYY")}${count}`
                           // Check If Index Number Exists
                           const ck = await fms.student.findFirst({ where: { indexno } });
                           if (ck) {
                              studentCount = studentCount + 1;
                           } else {
                              loop = false;
                           }
                        }

                        await fms.student.update({ where: { id: studentId }, data: { indexno } });
                        // Send Notfication
                        const msg = `Hi ${st.fname}! Your AKATSICO Index number has been generated: ${indexno}, Thank you!`;
                        await sms(st?.phone, msg);
                     }
                  }
                  // Retire Account

                  // Return Response
                  return res.status(200).json({ success: true, data: { transId: ins?.id, studentId, serviceId } });
               } else {
                  return res.status(200).json({ success: false, data: null, msg: `Transaction failed` });
               }
            } else {
               return res.status(200).json({ success: true, data: { transId: tr?.id, studentId: st?.id, serviceId } });
            }
         }

      } catch (error: any) {
         console.log(error)
         // Keep the bank API's { success, msg } shape; the raw Prisma error
         // stays in the server log rather than going back to the bank.
         return res.status(500).json({ success: false, data: null, msg: "Transaction could not be processed. Please retry or contact the institution." })
      }
   }

   /* Student Accounts & Debtors */

   async fetchAccounts(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition: any = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { id: { contains: keyword } },
                  { indexno: { contains: keyword } },
                  { fname: { contains: keyword } },
                  { lname: { contains: keyword } },
               ]
            }
         }
         const resp = await fms.$transaction([
            fms.student.count({
               ...(searchCondition),
            }),
            fms.student.findMany({
               ...(searchCondition),
               include: { program: true },
               skip: offset,
               take: Number(pageSize),
            })
         ]);

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchAccount(req: Request, res: Response) {
      try {
         const resp = await fms.studentAccount.findMany({
            where: { studentId: paramStr(req.params.id) },
            include: {
               student: { select: { fname: true, mname: true, lname: true, indexno: true, program: { select: { longName: true } } } },
               bill: { select: { narrative: true } },
               charge: { select: { title: true } },
               session: { select: { title: true } },
               transaction: { select: { transtag: true } },
            },
            orderBy: { createdAt: 'asc' }
         })
         if (resp.length) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   async fetchDebts(req: Request, res: Response) {
      console.log("Depts")
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition: any = { where: { accountNet: { gt: 0 } } }
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { id: { contains: keyword } },
                  { indexno: { contains: keyword } },
                  { fname: { contains: keyword } },
                  { lname: { contains: keyword } },
               ],
               AND: [{ accountNet: { gt: 0 } }]
            }
         }
         const resp = await fms.$transaction([
            fms.student.count({
               ...(searchCondition),
            }),
            fms.student.findMany({
               ...(searchCondition),
               include: { program: true },
               skip: offset,
               take: Number(pageSize),
            })
         ]);
         console.log(resp)

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async retireAccount(req: Request, res: Response) {
      try {
         const st = await fms.student.findFirst({ where: { OR: [{ id: paramStr(req.params.tag) }, { indexno: paramStr(req.params.tag) }] } })
         if (st) {
            // const pays = await fms.transaction.findMany({ where: { studentId: st?.id } });
            const mt: any = await fms.$queryRaw`select sum(amount) as amount from fms_studaccount where studentId = ${st?.id}`;
            console.log("Accounts: ", mt)

            /* Clean Student Account Payments & Repopulate */
            // Delete Any Transaction Payment in Student Account
            //  await fms.studentAccount.deleteMany({ where: { 
            //    studentId: st?.id , transactId: { not: null }
            //  }})
            const del: any = st?.indexno
               ? await fms.studentAccount.deleteMany({
                  where: {
                     OR: [{ studentId: st?.id }, { studentId: st?.indexno }],
                     AND: [{ transactId: { not: null } }]
                  }
               })
               : await fms.studentAccount.deleteMany({
                  where: {
                     studentId: st?.id, transactId: { not: null }
                  }
               });

            // const pays = st?.indexno 
            //    ? await fms.transaction.findMany({ where: { 
            //        OR: [ { studentId: st?.id }, { studentId: st?.indexno } ],
            //        AND: [ { transtypeId: { in: [2,3,4,8] } } ]
            //      },
            //    }) 
            //    : await fms.transaction.findMany({ where: {  studentId: st?.id, transtypeId: { in: [2,3,4,8] }} });

            const pays: any = st?.indexno
               ? await fms.$queryRaw`select t.* from fms_transaction t left join ais_student s on ( s.id = t.studentId or s.indexno = t.studentId ) where (t.studentId = ${st?.id} or t.studentId = ${st?.indexno}) and t.transtypeId in (2,3,4,8)`
               : await fms.transaction.findMany({ where: { studentId: st?.id, transtypeId: { in: [2, 3, 4, 8] } } });

            if (pays?.length) {
               const response = await Promise.all(pays?.map(async (r: any, i: number) => {
                  // Check If in Student Account
                  const narrative = `Payment of ${r.transtypeId == 8 ? 'Graduation' : r.transtypeId == 3 ? 'Resit' : r.transtypeId == 8 ? 'Late Registration' : 'Academic'} Fees - ${r.transtag}`
                  const isExist = await fms.studentAccount.findFirst({ where: { transactId: r?.id } });
                  if (!isExist && [2, 3, 4, 8].includes(r.transtypeId)) {
                     const ins: any = await fms.studentAccount.create({ data: { studentId: st?.id, narrative, currency: r.currency, amount: (-1 * r.amount), type: 'PAYMENT', transactId: r.id, createdAt: r.createdAt } });
                  }
               }))

               if (response) {
                  const bal: any = await fms.studentAccount.aggregate({ _sum: { amount: true }, where: { studentId: st?.id } });
                  const ups = await fms.student.update({ where: { id: st?.id }, data: { accountNet: bal?._sum?.amount } })
               }
            }
            // Return New Balance
            res.status(200).json(pays?.length)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Service charges */
   async fetchServiceList(req: Request, res: Response) {
      try {
         const resp = await fms.transtype.findMany({
            where: { status: true },
            orderBy: { createdAt: 'desc' }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   async fetchServices(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition: any = {
         where: { id: { notIn: [1, 2, 7] } },
         // select: { bankacc: { bankAccount: true } }
      }
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { title: { contains: keyword } },
               ],
               AND: [
                  { id: { notIn: [1, 2, 7] } }
               ]
            },
            // select: { bankacc: { bankAccount: true } }
         }
         const resp = await fms.$transaction([
            fms.transtype.count({
               ...(searchCondition),
            }),
            fms.transtype.findMany({
               ...(searchCondition),
               include: { bankacc: true },
               skip: offset,
               take: Number(pageSize),
            })
         ]);

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchService(req: Request, res: Response) {
      try {
         const resp = await fms.transtype.findUnique({
            where: { id: Number(paramStr(req.params.id)) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postService(req: Request, res: Response) {
      try {
         delete req.body.transtypeId;
         const resp = await fms.transtype.create({
            data: {
               ...req.body,
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateService(req: Request, res: Response) {
      try {
         delete req.body.transtypeId;
         const resp = await fms.transtype.update({
            where: {
               id: Number(paramStr(req.params.id))
            },
            data: {
               ...req.body,
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteService(req: Request, res: Response) {
      try {
         const resp = await fms.transtype.delete({ where: { id: Number(paramStr(req.params.id)) } })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records deleted` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   async fetchBanks(req: Request, res: Response) {
      try {
         const resp = await fms.bankacc.findMany({
            where: { status: true },
            orderBy: { createdAt: 'desc' }
         })
         if (resp?.length) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

}