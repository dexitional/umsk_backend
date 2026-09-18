import { NextFunction, Request, Response } from "express";
import { prisma } from "../prisma/client";
const ais: any = prisma;
const { default: axios } = require("axios");
const db = require("../config/mysql");
const { RateLimiterMemory, RateLimiterMySQL } = require("rate-limiter-flexible");

const opts = {
  storeClient: db,
  dbName: 'ums',
  tableName: 'rate', // all limiters store data in one table
  duration: 3,   // Per Second
  points: 1    // Requests
};

// const rateLimiter = new RateLimiterMemory({
//     duration: 3,   // Per Second
//     points:   1    // Requests
// });

const rateLimiter: any = new RateLimiterMySQL(opts, (err: any) => console.log(err))

// Login is unauthenticated (no req.userId yet), so this is keyed by IP rather
// than user, with a much looser window than voteLimiter -- a real user
// mistyping their password a couple of times shouldn't get locked out.
const loginLimiterOpts = {
  storeClient: db,
  dbName: 'ums',
  tableName: 'rate',
  keyPrefix: 'login',
  duration: 900,  // 15 minutes
  points: 5       // Attempts
};
const loginRateLimiter: any = new RateLimiterMySQL(loginLimiterOpts, (err: any) => console.log(err))
const loginLimiter: any = (req: Request & any, res: Response, next: NextFunction) => {
  loginRateLimiter
    .consume(req.ip)
    .then((rateLimiterRes: any) => {
      res.setHeader('Retry-After', rateLimiterRes.msBeforeNext / 1000);
      res.setHeader('X-RateLimit-Limit', loginLimiterOpts.points);
      res.setHeader('X-RateLimit-Remaining', rateLimiterRes.remainingPoints);
      res.setHeader('X-RateLimit-Reset', new Date(Date.now() + rateLimiterRes.msBeforeNext).toISOString());
      next();
    })
    .catch(() => {
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

