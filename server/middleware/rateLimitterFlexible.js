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
const client_1 = require("../prisma/client");
const ais = client_1.prisma;
const { default: axios } = require("axios");
const db = require("../config/mysql");
const { RateLimiterMemory, RateLimiterMySQL } = require("rate-limiter-flexible");
const opts = {
    storeClient: db,
    // The app's own database (.env MYSQL_DB), so each deployment keeps its
    // counters in its own `rate` table.
    dbName: process.env.MYSQL_DB,
    tableName: 'rate', // all limiters store data in one table
    duration: 3, // Per Second
    points: 1 // Requests
};
// const rateLimiter = new RateLimiterMemory({
//     duration: 3,   // Per Second
//     points:   1    // Requests
// });
const rateLimiter = new RateLimiterMySQL(opts, (err) => console.log(err));
// Login throttle, keyed by the submitted username so each account gets its own
// quota. It used to be keyed by req.ip, but behind nginx every request had the
// same (loopback) IP, so the whole institution shared one 5-attempt bucket --
// one person mistyping locked everyone out, and every login queued on the
// same `rate` row. Usernames match case-insensitively in MySQL, so the key is
// lowercased to stop case variations getting fresh quotas. Falls back to the
// IP when no username is sent. Looser window than voteLimiter: a real user
// mistyping their password a couple of times shouldn't get locked out.
const loginLimiterOpts = {
    storeClient: db,
    dbName: process.env.MYSQL_DB,
    tableName: 'rate',
    keyPrefix: 'login',
    duration: 900, // 15 minutes
    points: 5, // Attempts
    // If MySQL errors (e.g. "Too many connections"), keep throttling in memory
    // instead of rejecting -- which used to answer every login with a 429.
    insuranceLimiter: new RateLimiterMemory({ points: 5, duration: 900 }),
};
const loginRateLimiter = new RateLimiterMySQL(loginLimiterOpts, (err) => console.log(err));
const loginKey = (req) => {
    var _a;
    const username = typeof ((_a = req.body) === null || _a === void 0 ? void 0 : _a.username) === 'string' ? req.body.username.trim().toLowerCase() : '';
    return username ? `user:${username.slice(0, 255)}` : `ip:${req.ip}`;
};
const loginLimiter = (req, res, next) => {
    loginRateLimiter
        .consume(loginKey(req))
        .then((rateLimiterRes) => {
        res.setHeader('Retry-After', rateLimiterRes.msBeforeNext / 1000);
        res.setHeader('X-RateLimit-Limit', loginLimiterOpts.points);
        res.setHeader('X-RateLimit-Remaining', rateLimiterRes.remainingPoints);
        res.setHeader('X-RateLimit-Reset', new Date(Date.now() + rateLimiterRes.msBeforeNext).toISOString());
        next();
    })
        .catch((rej) => {
        // Only a used-up quota is a 429. A store error (if even the in-memory
        // fallback fails) must not lock every user out -- the password check
        // still guards the account.
        if (rej instanceof Error) {
            console.log('loginLimiter store error:', rej.message);
            return next();
        }
        res.setHeader('Retry-After', String(Math.ceil(((rej === null || rej === void 0 ? void 0 : rej.msBeforeNext) || 0) / 1000)));
        res.status(429).json({ message: 'Too many login attempts, please try again later.' });
    });
};
const voteLimiter = (req, res, next) => {
    rateLimiter
        .consume(req.userId)
        .then((rateLimiterRes) => {
        res.setHeader('Retry-After', rateLimiterRes.msBeforeNext / 1000);
        res.setHeader('X-RateLimit-Limit', 1);
        res.setHeader('X-RateLimit-Remaining', rateLimiterRes.remainingPoints);
        res.setHeader('X-RateLimit-Reset', new Date(Date.now() + rateLimiterRes.msBeforeNext).toISOString());
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        next();
    })
        .catch(() => __awaiter(void 0, void 0, void 0, function* () {
        // Log to Rate Attacks
        axios.get(`https://geolocation-db.com/json/`).then((_a) => __awaiter(void 0, [_a], void 0, function* ({ data }) {
            yield ais.attack.create({
                data: {
                    tag: req === null || req === void 0 ? void 0 : req.userId,
                    ip: data === null || data === void 0 ? void 0 : data.IPv4,
                    location: `Country: ${data === null || data === void 0 ? void 0 : data.country_name}, Coordinates: [ Lat ${data === null || data === void 0 ? void 0 : data.latitude}, Long ${data === null || data === void 0 ? void 0 : data.longitude} ] ${(data === null || data === void 0 ? void 0 : data.city) && (data === null || data === void 0 ? void 0 : data.city) != 'null' && ', City: ' + (data === null || data === void 0 ? void 0 : data.city)}`,
                    meta: "RATE ATTACK"
                }
            });
        }));
        res.status(429).json({ message: 'Too Many Requests !' });
    }));
};
module.exports = {
    voteLimiter,
    loginLimiter
};
// EH/BSS/19/0234 - adongo
// EH/ACT/20/0075 - abanga
