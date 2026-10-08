import { Express, Request, Response, NextFunction} from 'express';
import { requestContext } from '../util/requestContext';
const jwt = require("jsonwebtoken");

const verifyToken = (req: Request | any, res: Response, next: NextFunction) => {
    
    let token = req.headers["x-access-token"];
    // console.log("headers: ", req.headers);
    
    if (!token) return res.status(403).send({ success: false, msg: "No token provided!"});
    
    jwt.verify(token, process.env.SECRET, (err: any, decoded: any) => {
        if (err) return res.status(401).send({ success: false, msg: "Unauthorized!",});
        req.userId = decoded?.user?.tag;
        req.groupId = decoded?.user?.group_id; // 1 = student, 2 = staff
        // Already embedded in the signed token at login (authController.ts) — no extra query needed.
        req.roles = decoded?.roles || [];
        // Everything downstream of this request (handlers, Prisma audit
        // hooks) can read who is acting via getRequestContext().
        requestContext.run(
          { userId: req.userId, ip: req.ip, method: req.method, path: req.originalUrl },
          () => next()
        );
    });
};

module.exports = {
  verifyToken
}