"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const jwt = require("jsonwebtoken");
const verifyToken = (req, res, next) => {
    let token = req.headers["x-access-token"];
    // console.log("headers: ", req.headers);
    if (!token)
        return res.status(403).send({ success: false, msg: "No token provided!" });
    jwt.verify(token, process.env.SECRET, (err, decoded) => {
        var _a;
        if (err)
            return res.status(401).send({ success: false, msg: "Unauthorized!", });
        req.userId = (_a = decoded === null || decoded === void 0 ? void 0 : decoded.user) === null || _a === void 0 ? void 0 : _a.tag;
        // Already embedded in the signed token at login (authController.ts) — no extra query needed.
        req.roles = (decoded === null || decoded === void 0 ? void 0 : decoded.roles) || [];
        next();
    });
};
module.exports = {
    verifyToken
};
