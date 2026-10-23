"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const utilitiesController_1 = __importDefault(require("../controller/utilitiesController"));
const utilities_1 = require("../util/utilities");
const { verifyToken } = require('../middleware/verifyToken');
const router = (0, express_1.Router)(), c = new utilitiesController_1.default();
router.use(verifyToken);
router.use((req, res, next) => {
    if (typeof req.userId !== 'string' || !req.userId.trim())
        return res.status(401).json({ message: 'Please sign in again.' });
    if (Number(req.groupId) !== 2 || !(req.roles || []).some((r) => { var _a; return ((_a = r === null || r === void 0 ? void 0 : r.app) === null || _a === void 0 ? void 0 : _a.toLowerCase()) === 'ais' && utilities_1.UTILITY_ROLES.includes(r.role); }))
        return res.status(403).json({ message: 'You do not have permission to manage utilities.' });
    return next();
});
router.get('/options', c.options);
router.get('/students', c.students);
router.get('/change-of-program', c.changes);
router.post('/change-of-program', c.saveChange);
router.patch('/change-of-program/:id', c.saveChange);
router.delete('/change-of-program/:id', c.deleteChange);
router.post('/change-of-program/:id/approve', c.approveChange);
router.get('/:module', c.list);
router.post('/:module', c.save);
router.patch('/:module/:id', c.save);
router.delete('/:module/:id', c.remove);
exports.default = router;
