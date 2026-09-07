import { Response, NextFunction } from 'express';

// Must run after verifyToken (relies on req.roles being populated from the JWT).
// Rejects the request unless the caller holds at least one of the allowed role tags,
// e.g. requireRole(['sheet::admin', 'sheet::dean']).
const requireRole = (allowed: string[]) => (req: any, res: Response, next: NextFunction) => {
    const held: string[] = (req.roles || []).map((r: any) => r?.role);
    if (allowed.some((tag) => held.includes(tag))) return next();
    return res.status(403).json({ message: `You do not have permission to perform this action.` });
};

module.exports = {
  requireRole
}
