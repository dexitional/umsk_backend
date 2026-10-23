import { Router } from 'express'
import AuthController from '../controller/authController'

const { verifyToken } = require("../middleware/verifyToken");
const { loginLimiter } = require("../middleware/rateLimitterFlexible");
const pinSendAccess = (req: any, res: any, next: any) => {
  const roles = ['student::admin', 'student::registry', 'access::admin'];
  if (Number(req.groupId) !== 2 || !(req.roles || []).some((r: any) => r.app === 'ais' && roles.includes(r.role))) return res.status(403).json({ message: 'You do not have permission to send student PINs.' });
  next();
};

class AuthRoute {
    
    router = Router();
    controller = new AuthController();

    constructor(){
       this.initializeRoute();
    }

    initializeRoute(){
      /* Authentication Providers */
       this.router.post('/credential', [loginLimiter], this.controller.authenticateWithCredential);
       this.router.post('/google', this.controller.authenticateWithGoogle);
       // Impersonation — must require an already-authenticated caller.
       // authenticateWithKey issues a full session token by tag alone, no
       // password; without this guard anyone unauthenticated could take
       // over any account.
       this.router.post('/switch', [verifyToken], this.controller.authenticateWithKey);
      /* Account Management - Change Password */
       this.router.post('/password', this.controller.changePassword);
       this.router.post('/forget', this.controller.forgetPassword);
      /* Photo Management */
       this.router.get('/mobile', this.controller.fetchAmsApk);
       this.router.get('/pixo', this.controller.fetchEvsPhoto);
       this.router.get('/photos', this.controller.fetchPhoto);
       this.router.post('/photos', this.controller.postPhoto);
       this.router.post('/photos/rotate', this.controller.rotatePhoto);
       this.router.delete('/photos/:id', this.controller.removePhoto);
       /* SSO Pin Management */
       // PIN resets require a logged-in user: they change credentials and are
       // audit-logged with the acting user (was unauthenticated -- anyone could
       // reset every student's PIN).
       this.router.post('/pins/generate', [verifyToken], this.controller.resetStudentPins);
       this.router.post('/pins/generate/:tag', [verifyToken], this.controller.resetStudentPin);
       this.router.post('/pins/send', [verifyToken, pinSendAccess], this.controller.sendStudentPins);
       this.router.post('/pins/send/:tag', [verifyToken, pinSendAccess], this.controller.sendStudentPin);
       
    }

}

export default new AuthRoute().router;
