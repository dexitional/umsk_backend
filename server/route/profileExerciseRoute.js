"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const profileExerciseController_1 = __importDefault(require("../controller/profileExerciseController"));
const { profileSearchLimiter, profileSaveLimiter } = require('../middleware/rateLimitterFlexible');
// Public (no sign-in) profile update exercise -- see the controller for the
// safeguards. Mounted at /api/public/profile.
const router = (0, express_1.Router)(), c = new profileExerciseController_1.default();
router.get('/status', c.status);
router.get('/search', profileSearchLimiter, c.search);
router.get('/students/:id', profileSearchLimiter, c.fetch);
router.put('/students/:id', profileSaveLimiter, c.update);
exports.default = router;
