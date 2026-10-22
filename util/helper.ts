import { gradeBand } from "./academic";
import { codesForSemester } from "./billing";
import { NextFunction, Request, Response } from 'express'
import { redisClient } from "../config/redis"; 
import { prisma } from "../prisma/client";
import { requestInfo, writeLog } from "./auditLog";
const CACHE_TTL = 3600; // 1 hour

export const getGrade = (num: any, grades: any) =>
    num == null ? 'I' : gradeBand(num, grades)?.grade ?? 'Invalid';

export const getGradePoint = (num: any, grades: any) =>
    gradeBand(num, grades)?.gradepoint ?? 0;

// Final totalScore is authoritative, including imported total-only results.
export const isIncomplete = (row: any) => row?.totalScore == null;
export const gradeFor = (row: any, grades: any) => getGrade(row?.totalScore, grades);
export const gradePointFor = (row: any, grades: any) => getGradePoint(row?.totalScore, grades);

export const getClass = (num: any,classes: any) => {
    if(num == null || classes == null ) return 'No Class'
    num = parseFloat(num)
    const vs = classes && classes.find((row: any) => parseFloat(row.min) <= parseFloat(num) && parseFloat(num) <= parseFloat(row.max))
    return (vs && vs.class) || 'No Class';
}

export const getBillCodePrisma = (semesterNum: number) =>
  codesForSemester(semesterNum).map(code => ({ mainGroupCode: { equals: code } }));

export const getSemesterFromCode = (semester: any, code: string,) => {
  const levels:any = code.split("");
  const lvs = [];
  if(levels.length){
     for(let i = 0; i < levels.length; i++){
        if(semester == 'SEM1'){
            if(levels[i] == 1 && i == 0) lvs.push(1)   
            if(levels[i] == 1  && i == 1) lvs.push(3)   
            if(levels[i] == 1  && i == 2) lvs.push(5)   
            if(levels[i] == 1  && i == 3) lvs.push(7)   
        } else {
            if(levels[i] == 1  && i == 0) lvs.push(2)   
            if(levels[i] == 1  && i == 1) lvs.push(4)   
            if(levels[i] == 1  && i == 2) lvs.push(6)   
            if(levels[i] == 1  && i == 3) lvs.push(8)
        }
     }
  }
  return lvs?.join(',');

}


export const decodeBase64Image = (dataString: any) => {
    var matches = dataString.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/),
    response:any = {};
    if (matches.length !== 3) return new Error('Invalid input string');
    response.type = matches[1];
    // response.data = new Buffer(matches[2], 'base64');
    response.data = Buffer.from(matches[2], 'base64');
    return response;
}


export const rotateImage = async (imageFile:any) => {
    const Jimp = require('jimp') ;
    // Reading Image
    const image = await Jimp.read(imageFile);
    // Checking if any error occurs while rotating image
    image.rotate(90, Jimp.RESIZE_BEZIER, function(err:any){
       if (err) throw err;
    }).write(imageFile);
}

// Bank API (route/apiRoute.ts): logs every request as BANK_API_<action>
// once the response is sent, with what the bank sent and what it got back
// (the API answers HTTP 200 with { success, msg }, so the outcome is read
// from the body). The API key (?api_key= / ?api= / x-api-key) is masked to
// its last 4 characters; the matching collector, if
// any, is recorded as the log's user. Never blocks or fails the request.
export const apiLogger = (action: any) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        const started = Date.now();
        let responseBody: any;
        const json = res.json.bind(res);
        res.json = (body: any) => { responseBody = body; return json(body); };

        res.on('finish', async () => {
            try {
                const token = String(req.query?.api_key || req.query?.api || req.headers['x-api-key'] || '').trim();
                const collector = token ? await prisma.collector.findFirst({ where: { apiToken: token }, select: { id: true, name: true } }).catch(() => null) : null;
                const query = Object.fromEntries(Object.entries(req.query || {}).map(([k, v]) => [k, ['api', 'api_key'].includes(k) ? `****${String(v).slice(-4)}` : v]));
                const authenticated = !!(req as any).collector;
                const body = req.body && Object.keys(req.body).length ? req.body : undefined;
                const serialized = responseBody === undefined ? '' : JSON.stringify(responseBody);
                await writeLog(`BANK_API_${action}`, {
                    user: collector?.name || 'BANK_API',
                    student: (req.params as any)?.refno || req.body?.studentId || null,
                    meta: {
                        request: requestInfo(req),
                        query,
                        body,
                        collector: collector ? { id: collector.id, name: collector.name } : (token ? 'unknown API key' : 'no API key'),
                        authenticated,
                        response: {
                            status: res.statusCode,
                            success: responseBody?.success ?? (res.statusCode < 400),
                            msg: responseBody?.msg ?? responseBody?.message ?? null,
                            // Service lists can be large; keep a preview only.
                            data: serialized.length > 4000 ? { truncated: true, preview: serialized.slice(0, 1000) } : responseBody?.data,
                        },
                        durationMs: Date.now() - started,
                    },
                });
            } catch (error: any) {
                console.log(`apiLogger failed (${action}):`, error?.message);
            }
        });
        return next();
    }
}

export const getOrSetCache = async (key: string, cb: () => Promise<any>) => {
    const cachedData = await redisClient.get(key);
    if (cachedData) {
       return JSON.parse(cachedData);
    }
    const freshData = await cb();
    if (freshData) {
       await redisClient.setEx(key, CACHE_TTL, JSON.stringify(freshData));
    }
    return freshData;
}

export const clearCache = async (key: string) =>  {
  const keys = await redisClient.keys(key);
  if (keys.length > 0) await redisClient.del(keys);
}

// Forms routinely submit "" for an untouched optional dropdown/input, or a
// literal sentinel like "NONE" for an explicit no-selection option — passed
// straight through as a scalar foreign key column, the DB rejects either as
// pointing to a row that doesn't exist. Stripping them lets Prisma omit the
// field (and MariaDB just store NULL) instead of erroring.
// A request-body date for Prisma, which only accepts a Date or a full
// ISO-8601 date-time string (a bare "1985-04-12", "12/04/1985" or "" is
// rejected). Blank ('' / null) -> null. Plain calendar dates are pinned to
// UTC midnight so they don't shift a day with the server's timezone:
//  - YYYY-MM-DD (date inputs; single-digit month/day allowed)
//  - DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY -- day first, as written in Ghana
//    (JavaScript would read 12/04/1985 as 4 December)
// A small number is an Excel serial day. Anything that doesn't parse (or an
// impossible day like 31/02) -> undefined, which Prisma treats as "leave the
// field as it is", so bad input never wipes a stored date.
const utcDay = (y: number, m: number, d: number) => {
   const dt = new Date(Date.UTC(y, m - 1, d));
   return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : undefined;
};
export const toDate = (v: any): Date | null | undefined => {
   if (v === undefined) return undefined;
   if (v === null || String(v).trim() === '') return null;
   if (v instanceof Date) return isNaN(v.getTime()) ? undefined : v;
   if (typeof v === 'number') {
      const d = v > 0 && v < 100000 ? new Date(Math.round((v - 25569) * 86400000)) : new Date(v);
      return isNaN(d.getTime()) ? undefined : d;
   }
   const s = String(v).trim();
   let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
   if (m) return utcDay(+m[1], +m[2], +m[3]);
   m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
   if (m) return utcDay(+m[3], +m[2], +m[1]);
   // Full date-times (ISO strings from the API, Date#toString output).
   if (!/\d{4}/.test(s)) return undefined;
   const d = new Date(s);
   return isNaN(d.getTime()) ? undefined : d;
};

export const stripBlank = (body: any, blankValues: any[] = ['', 'NONE', null, undefined]) => {
  const clean: any = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (blankValues.includes(value)) continue;
    clean[key] = value;
  }
  return clean;
}

// Maps common Prisma error codes to plain-language messages safe to show a
// user, instead of the raw exception (SQL/driver internals, table/column
// names, stack frames) that error.message otherwise carries.
export const friendlyDbError = (error: any): string => {
  switch (error?.code) {
    case 'P2003':
      return `One of the values you selected doesn't exist or is no longer valid. Please re-check your selections and try again.`;
    case 'P2002': {
      const target = Array.isArray(error?.meta?.target) ? error.meta.target.join(', ') : error?.meta?.target;
      return `A record with this ${target || 'value'} already exists.`;
    }
    case 'P2025':
      return `The record you're trying to update or delete could not be found — it may have already been removed.`;
    case 'P2014':
      return `That change would leave a related record in an invalid state. Please review and try again.`;
    // Schema drift: the code expects a column/table a pending SQL
    // migration (prisma/sql) hasn't added to this database yet.
    case 'P2022': {
      const column = error?.meta?.column || String(error?.message || '').match(/column `([^`]+)`/)?.[1];
      return `The database is missing ${column ? `the column ${column}` : 'a column'} needed for this. Ask the system administrator to run the latest database updates (backend/prisma/sql), then try again.`;
    }
    case 'P2021': {
      const table = error?.meta?.table || String(error?.message || '').match(/table `([^`]+)`/)?.[1];
      return `The database is missing ${table ? `the table ${table}` : 'a table'} needed for this. Ask the system administrator to run the latest database updates (backend/prisma/sql), then try again.`;
    }
    default:
      return `Something went wrong while saving. Please try again, and contact support if the problem continues.`;
  }
}

// A message that's safe to show users for any caught error: Prisma errors
// (whose messages are long internal query dumps) go through
// friendlyDbError; errors the app throws itself keep their own message.
export const errorMessage = (error: any, fallback: string = 'Something went wrong. Please try again, and contact support if the problem continues.'): string => {
  const isPrisma = /^Prisma/.test(error?.name || '') || /^P\d{4}$/.test(error?.code || '');
  if (isPrisma) return error?.code ? friendlyDbError(error) : fallback;
  return error?.message || fallback;
}