"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Must run after verifyToken (relies on req.roles being populated from the JWT).
// Rejects the request unless the caller holds at least one of the allowed role tags,
// e.g. requireRole(['sheet::admin', 'sheet::dean']).
const requireRole = (allowed) => (req, res, next) => {
    const held = (req.roles || []).map((r) => r === null || r === void 0 ? void 0 : r.role);
    if (allowed.some((tag) => held.includes(tag)))
        return next();
    return res.status(403).json({ message: `You do not have permission to perform this action.` });
};
module.exports = {
    requireRole
};
