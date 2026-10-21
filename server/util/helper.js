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
exports.errorMessage = exports.friendlyDbError = exports.stripBlank = exports.toDate = exports.clearCache = exports.getOrSetCache = exports.apiLogger = exports.rotateImage = exports.decodeBase64Image = exports.getSemesterFromCode = exports.getBillCodePrisma = exports.getClass = exports.getGradePoint = exports.gradePointFor = exports.gradeFor = exports.isIncomplete = exports.getGrade = void 0;
const billing_1 = require("./billing");
const redis_1 = require("../config/redis");
const client_1 = require("../prisma/client");
const auditLog_1 = require("./auditLog");
const CACHE_TTL = 3600; // 1 hour
const getGrade = (num, grades) => {
    if (num == null)
        return 'I';
    num = parseFloat(num);
    const vs = grades && grades.find((row) => parseFloat(row.min) <= parseFloat(num) && parseFloat(num) <= parseFloat(row.max));
    console.log(num, vs);
    return (vs && vs.grade) || 'I';
};
exports.getGrade = getGrade;
// IC (Incomplete): the course's exam score hasn't been entered. A result
// entered as a total only (no class or exam score -- e.g. a backlog upload)
// is complete, not IC. IC results show grade "IC" and carry no grade points
// or GPA/CGPA credits until the exam score is in.
const isIncomplete = (r) => (r === null || r === void 0 ? void 0 : r.examScore) == null && !((r === null || r === void 0 ? void 0 : r.classScore) == null && (r === null || r === void 0 ? void 0 : r.totalScore) != null);
exports.isIncomplete = isIncomplete;
const gradeFor = (r, grades) => ((0, exports.isIncomplete)(r) ? 'IC' : (0, exports.getGrade)(r === null || r === void 0 ? void 0 : r.totalScore, grades));
exports.gradeFor = gradeFor;
const gradePointFor = (r, grades) => ((0, exports.isIncomplete)(r) ? 0 : (0, exports.getGradePoint)(r === null || r === void 0 ? void 0 : r.totalScore, grades));
exports.gradePointFor = gradePointFor;
const getGradePoint = (num, grades) => {
    if (num == null)
        return 0;
    num = parseFloat(num);
    const vs = grades && grades.find((row) => parseFloat(row.min) <= parseFloat(num) && parseFloat(num) <= parseFloat(row.max));
    return (vs && vs.gradepoint) || 0;
};
exports.getGradePoint = getGradePoint;
const getClass = (num, classes) => {
    if (num == null || classes == null)
        return 'No Class';
    num = parseFloat(num);
    const vs = classes && classes.find((row) => parseFloat(row.min) <= parseFloat(num) && parseFloat(num) <= parseFloat(row.max));
    return (vs && vs.class) || 'No Class';
};
exports.getClass = getClass;
const getBillCodePrisma = (semesterNum) => (0, billing_1.codesForSemester)(semesterNum).map(code => ({ mainGroupCode: { equals: code } }));
exports.getBillCodePrisma = getBillCodePrisma;
const getSemesterFromCode = (semester, code) => {
    const levels = code.split("");
    const lvs = [];
    if (levels.length) {
        for (let i = 0; i < levels.length; i++) {
            if (semester == 'SEM1') {
                if (levels[i] == 1 && i == 0)
                    lvs.push(1);
                if (levels[i] == 1 && i == 1)
                    lvs.push(3);
                if (levels[i] == 1 && i == 2)
                    lvs.push(5);
                if (levels[i] == 1 && i == 3)
                    lvs.push(7);
            }
            else {
                if (levels[i] == 1 && i == 0)
                    lvs.push(2);
                if (levels[i] == 1 && i == 1)
                    lvs.push(4);
                if (levels[i] == 1 && i == 2)
                    lvs.push(6);
                if (levels[i] == 1 && i == 3)
                    lvs.push(8);
            }
        }
    }
    return lvs === null || lvs === void 0 ? void 0 : lvs.join(',');
};
exports.getSemesterFromCode = getSemesterFromCode;
const decodeBase64Image = (dataString) => {
    var matches = dataString.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/), response = {};
    if (matches.length !== 3)
        return new Error('Invalid input string');
    response.type = matches[1];
    // response.data = new Buffer(matches[2], 'base64');
    response.data = Buffer.from(matches[2], 'base64');
    return response;
};
exports.decodeBase64Image = decodeBase64Image;
const rotateImage = (imageFile) => __awaiter(void 0, void 0, void 0, function* () {
    const Jimp = require('jimp');
    // Reading Image
    const image = yield Jimp.read(imageFile);
    // Checking if any error occurs while rotating image
    image.rotate(90, Jimp.RESIZE_BEZIER, function (err) {
        if (err)
            throw err;
    }).write(imageFile);
});
exports.rotateImage = rotateImage;
// Bank API (route/apiRoute.ts): logs every request as BANK_API_<action>
// once the response is sent, with what the bank sent and what it got back
// (the API answers HTTP 200 with { success, msg }, so the outcome is read
// from the body). The API key (?api_key= / ?api= / x-api-key) is masked to
// its last 4 characters; the matching collector, if
// any, is recorded as the log's user. Never blocks or fails the request.
const apiLogger = (action) => {
    return (req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
        const started = Date.now();
        let responseBody;
        const json = res.json.bind(res);
        res.json = (body) => { responseBody = body; return json(body); };
        res.on('finish', () => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f, _g;
            try {
                const token = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.api_key) || ((_b = req.query) === null || _b === void 0 ? void 0 : _b.api) || req.headers['x-api-key'] || '').trim();
                const collector = token ? yield client_1.prisma.collector.findFirst({ where: { apiToken: token }, select: { id: true, name: true } }).catch(() => null) : null;
                const query = Object.fromEntries(Object.entries(req.query || {}).map(([k, v]) => [k, ['api', 'api_key'].includes(k) ? `****${String(v).slice(-4)}` : v]));
                const authenticated = !!req.collector;
                const body = req.body && Object.keys(req.body).length ? req.body : undefined;
                const serialized = responseBody === undefined ? '' : JSON.stringify(responseBody);
                yield (0, auditLog_1.writeLog)(`BANK_API_${action}`, {
                    user: (collector === null || collector === void 0 ? void 0 : collector.name) || 'BANK_API',
                    student: ((_c = req.params) === null || _c === void 0 ? void 0 : _c.refno) || ((_d = req.body) === null || _d === void 0 ? void 0 : _d.studentId) || null,
                    meta: {
                        request: (0, auditLog_1.requestInfo)(req),
                        query,
                        body,
                        collector: collector ? { id: collector.id, name: collector.name } : (token ? 'unknown API key' : 'no API key'),
                        authenticated,
                        response: {
                            status: res.statusCode,
                            success: (_e = responseBody === null || responseBody === void 0 ? void 0 : responseBody.success) !== null && _e !== void 0 ? _e : (res.statusCode < 400),
                            msg: (_g = (_f = responseBody === null || responseBody === void 0 ? void 0 : responseBody.msg) !== null && _f !== void 0 ? _f : responseBody === null || responseBody === void 0 ? void 0 : responseBody.message) !== null && _g !== void 0 ? _g : null,
                            // Service lists can be large; keep a preview only.
                            data: serialized.length > 4000 ? { truncated: true, preview: serialized.slice(0, 1000) } : responseBody === null || responseBody === void 0 ? void 0 : responseBody.data,
                        },
                        durationMs: Date.now() - started,
                    },
                });
            }
            catch (error) {
                console.log(`apiLogger failed (${action}):`, error === null || error === void 0 ? void 0 : error.message);
            }
        }));
        return next();
    });
};
exports.apiLogger = apiLogger;
const getOrSetCache = (key, cb) => __awaiter(void 0, void 0, void 0, function* () {
    const cachedData = yield redis_1.redisClient.get(key);
    if (cachedData) {
        return JSON.parse(cachedData);
    }
    const freshData = yield cb();
    if (freshData) {
        yield redis_1.redisClient.setEx(key, CACHE_TTL, JSON.stringify(freshData));
    }
    return freshData;
});
exports.getOrSetCache = getOrSetCache;
const clearCache = (key) => __awaiter(void 0, void 0, void 0, function* () {
    const keys = yield redis_1.redisClient.keys(key);
    if (keys.length > 0)
        yield redis_1.redisClient.del(keys);
});
exports.clearCache = clearCache;
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
const utcDay = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : undefined;
};
const toDate = (v) => {
    if (v === undefined)
        return undefined;
    if (v === null || String(v).trim() === '')
        return null;
    if (v instanceof Date)
        return isNaN(v.getTime()) ? undefined : v;
    if (typeof v === 'number') {
        const d = v > 0 && v < 100000 ? new Date(Math.round((v - 25569) * 86400000)) : new Date(v);
        return isNaN(d.getTime()) ? undefined : d;
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m)
        return utcDay(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (m)
        return utcDay(+m[3], +m[2], +m[1]);
    // Full date-times (ISO strings from the API, Date#toString output).
    if (!/\d{4}/.test(s))
        return undefined;
    const d = new Date(s);
    return isNaN(d.getTime()) ? undefined : d;
};
exports.toDate = toDate;
const stripBlank = (body, blankValues = ['', 'NONE', null, undefined]) => {
    const clean = {};
    for (const [key, value] of Object.entries(body || {})) {
        if (blankValues.includes(value))
            continue;
        clean[key] = value;
    }
    return clean;
};
exports.stripBlank = stripBlank;
// Maps common Prisma error codes to plain-language messages safe to show a
// user, instead of the raw exception (SQL/driver internals, table/column
// names, stack frames) that error.message otherwise carries.
const friendlyDbError = (error) => {
    var _a, _b, _c, _d, _e, _f;
    switch (error === null || error === void 0 ? void 0 : error.code) {
        case 'P2003':
            return `One of the values you selected doesn't exist or is no longer valid. Please re-check your selections and try again.`;
        case 'P2002': {
            const target = Array.isArray((_a = error === null || error === void 0 ? void 0 : error.meta) === null || _a === void 0 ? void 0 : _a.target) ? error.meta.target.join(', ') : (_b = error === null || error === void 0 ? void 0 : error.meta) === null || _b === void 0 ? void 0 : _b.target;
            return `A record with this ${target || 'value'} already exists.`;
        }
        case 'P2025':
            return `The record you're trying to update or delete could not be found — it may have already been removed.`;
        case 'P2014':
            return `That change would leave a related record in an invalid state. Please review and try again.`;
        // Schema drift: the code expects a column/table a pending SQL
        // migration (prisma/sql) hasn't added to this database yet.
        case 'P2022': {
            const column = ((_c = error === null || error === void 0 ? void 0 : error.meta) === null || _c === void 0 ? void 0 : _c.column) || ((_d = String((error === null || error === void 0 ? void 0 : error.message) || '').match(/column `([^`]+)`/)) === null || _d === void 0 ? void 0 : _d[1]);
            return `The database is missing ${column ? `the column ${column}` : 'a column'} needed for this. Ask the system administrator to run the latest database updates (backend/prisma/sql), then try again.`;
        }
        case 'P2021': {
            const table = ((_e = error === null || error === void 0 ? void 0 : error.meta) === null || _e === void 0 ? void 0 : _e.table) || ((_f = String((error === null || error === void 0 ? void 0 : error.message) || '').match(/table `([^`]+)`/)) === null || _f === void 0 ? void 0 : _f[1]);
            return `The database is missing ${table ? `the table ${table}` : 'a table'} needed for this. Ask the system administrator to run the latest database updates (backend/prisma/sql), then try again.`;
        }
        default:
            return `Something went wrong while saving. Please try again, and contact support if the problem continues.`;
    }
};
exports.friendlyDbError = friendlyDbError;
// A message that's safe to show users for any caught error: Prisma errors
// (whose messages are long internal query dumps) go through
// friendlyDbError; errors the app throws itself keep their own message.
const errorMessage = (error, fallback = 'Something went wrong. Please try again, and contact support if the problem continues.') => {
    const isPrisma = /^Prisma/.test((error === null || error === void 0 ? void 0 : error.name) || '') || /^P\d{4}$/.test((error === null || error === void 0 ? void 0 : error.code) || '');
    if (isPrisma)
        return (error === null || error === void 0 ? void 0 : error.code) ? (0, exports.friendlyDbError)(error) : fallback;
    return (error === null || error === void 0 ? void 0 : error.message) || fallback;
};
exports.errorMessage = errorMessage;
