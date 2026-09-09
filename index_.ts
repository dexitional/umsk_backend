import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import express, { Application, Express, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import aisRoute from './route/aisRoute';
import apiRoute from './route/apiRoute';
import authRoute from "./route/authRoute";
import evsRoute from './route/evsRoute';
import fmsRoute from './route/fmsRoute';
import hrsRoute from './route/hrsRoute';
dotenv.config();

const fileUpload = require('express-fileupload');
const cors = require('cors');
const compression = require('compression');
const app: Express = express();
const port = process.env.PORT || 5030;

export default class Routes {
  constructor(app: Application) {
    // Middlewares
    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
    app.use("/public", express.static("public"));
    app.use(cors());
    //app.use(fileUpload());
    app.use(fileUpload({
      limits: { fileSize: 50 * 1024 * 1024 },
    }));
    // Compress Responses
    app.use(compression());
    // Security Guards
    app.use(helmet());
    // Token Initializations
    app.use(function (req: Request, res: Response, next: NextFunction) {
      res.header(
        "Access-Control-Allow-Headers",
        "x-access-token, Origin, Content-Type, Accept"
      );
      next();
    });
    // Routes & Endpoints
    app.get('/', (req, res) => { res.send("test") });
    app.use("/api/auth", authRoute); /** Authentication API **/
    app.use("/api/ais", aisRoute); /** Academics API **/
    app.use("/api/fms", fmsRoute); /** Finance API **/
    app.use("/api/hrs", hrsRoute); /** HRS API **/
    app.use("/api/evs", evsRoute); /** Electa API **/
    app.use("/api/v1", apiRoute); /** Bank API **/

    // Initialize Server
    app.listen(port, () => console.log(`⚡️[server]: Server is running at http://localhost:${port}`));
  }
}

// Bootstrap Application
new Routes(app)

