import { NextFunction, Request, Response } from "express";
import { prisma } from "../prisma/client";
const ais: any = prisma;
const { default: axios } = require("axios");
const db = require("../config/mysql");
const { RateLimiterMemory, RateLimiterMySQL } = require("rate-limiter-flexible");

const opts = {
  storeClient: db,
  // The app's own database (.env MYSQL_DB), so each deployment keeps its
  // counters in its own `rate` table.
  dbName: process.env.MYSQL_DB,
  tableName: 'rate', // all limiters store data in one table
  duration: 3,   // Per Second
  points: 1    // Requests
};

// const rateLimiter = new RateLimiterMemory({
//     duration: 3,   // Per Second
//     points:   1    // Requests
// });

const rateLimiter: any = new RateLimiterMySQL(opts, (err: any) => console.log(err))

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
  duration: 900,  // 15 minutes
  points: 5,      // Attempts
  // If MySQL errors (e.g. "Too many connections"), keep throttling in memory
  // instead of rejecting -- which used to answer every login with a 429.
  insuranceLimiter: new RateLimiterMemory({ points: 5, duration: 900 }),
};
const loginRateLimiter: any = new RateLimiterMySQL(loginLimiterOpts, (err: any) => console.log(err))
const loginKey = (req: Request & any) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  return username ? `user:${username.slice(0, 255)}` : `ip:${req.ip}`;
};
const loginLimiter: any = (req: Request & any, res: Response, next: NextFunction) => {
  loginRateLimiter
    .consume(loginKey(req))
    .then((rateLimiterRes: any) => {
      res.setHeader('Retry-After', rateLimiterRes.msBeforeNext / 1000);
      res.setHeader('X-RateLimit-Limit', loginLimiterOpts.points);
      res.setHeader('X-RateLimit-Remaining', rateLimiterRes.remainingPoints);
      res.setHeader('X-RateLimit-Reset', new Date(Date.now() + rateLimiterRes.msBeforeNext).toISOString());
      next();
    })
    .catch((rej: any) => {
      // Only a used-up quota is a 429. A store error (if even the in-memory
      // fallback fails) must not lock every user out -- the password check
      // still guards the account.
      if (rej instanceof Error) {
        console.log('loginLimiter store error:', rej.message);
        return next();
      }
      res.setHeader('Retry-After', String(Math.ceil((rej?.msBeforeNext || 0) / 1000)));
      res.status(429).json({ message: 'Too many login attempts, please try again later.' });
    });
};
const voteLimiter: any = (req: Request & any, res: Response, next: NextFunction) => {
  rateLimiter
    .consume(req.userId)
    .then((rateLimiterRes: any) => {
      res.setHeader('Retry-After', rateLimiterRes.msBeforeNext / 1000);
      res.setHeader('X-RateLimit-Limit', 1);
      res.setHeader('X-RateLimit-Remaining', rateLimiterRes.remainingPoints);
      res.setHeader('X-RateLimit-Reset', new Date(Date.now() + rateLimiterRes.msBeforeNext).toISOString());
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      next();
    })
    .catch(async () => {

      // Log to Rate Attacks
      axios.get(`https://geolocation-db.com/json/`).then(async ({ data }: any) => {
        await ais.attack.create({
          data: {
            tag: req?.userId,
            ip: data?.IPv4,
            location: `Country: ${data?.country_name}, Coordinates: [ Lat ${data?.latitude}, Long ${data?.longitude} ] ${data?.city && data?.city != 'null' && ', City: ' + data?.city}`,
            meta: "RATE ATTACK"
          }
        })
      })

      res.status(429).json({ message: 'Too Many Requests !' });
    });
};



module.exports = {
  voteLimiter,
  loginLimiter
}


// EH/BSS/19/0234 - adongo
// EH/ACT/20/0075 - abanga

