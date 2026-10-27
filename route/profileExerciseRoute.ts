import { Router } from 'express';
import ProfileExerciseController from '../controller/profileExerciseController';
const { profileSearchLimiter, profileSaveLimiter } = require('../middleware/rateLimitterFlexible');

// Public (no sign-in) profile update exercise -- see the controller for the
// safeguards. Mounted at /api/public/profile.
const router = Router(), c = new ProfileExerciseController();
router.get('/status', c.status);
router.get('/search', profileSearchLimiter, c.search);
router.get('/students/:id', profileSearchLimiter, c.fetch);
router.put('/students/:id', profileSaveLimiter, c.update);
export default router;
