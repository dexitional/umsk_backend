import { Router } from 'express'
import FmsController from '../controller/fmsController'
import { apiLogger } from '../util/helper';
import { requireBankCollector } from '../middleware/requireBankCollector';

class ApiRoute {
    
    router = Router();
    controller = new FmsController();

    constructor(){
       this.initializeRoute();
    }

    initializeRoute(){
      
      /* Bank Payment API Services -- apiLogger runs first so rejected
         (bad/missing token) requests are logged too. */
      this.router.get('/services', apiLogger('LOAD_API_SERVICES'), requireBankCollector, this.controller.loadPayServices);
      this.router.get('/services/:type', apiLogger('LOAD_VOUCHER_FORMS'), requireBankCollector, this.controller.loadPayService);
      this.router.get('/services/:type/:refno', apiLogger('VERIFY_STUDENT'), requireBankCollector, this.controller.loadPayService);
      this.router.post('/payservice', apiLogger('SEND_TRANSACTION'), requireBankCollector, this.controller.payService);
 
    }

   
}

export default new ApiRoute().router;