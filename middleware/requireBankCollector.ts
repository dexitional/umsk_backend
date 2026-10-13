import { NextFunction, Request, Response } from "express";
import { prisma } from "../prisma/client";

// Bank API (route/apiRoute.ts) authentication: the caller must send the API
// key of an enabled collector (fms_collector.apiToken / apiEnabled) as
// ?api_key=<key> -- the format issued to the banks, e.g.
// https://portal.akatsico.edu.gh/api/v1/services?api_key=<key> -- or, also
// accepted, ?api=<key> or an `x-api-key` header. The matching collector is put on
// req.collector, and payments are credited to it (fmsController.payService).
// Issue / rotate a token with: npm run bank-token -- "<collector name>"
//
// BANK_API_ALLOW_UNAUTHENTICATED=true is a temporary rollout switch for
// while a bank's token is being set up: requests without a valid token are
// let through and fall back to the old behaviour (first collector). Every
// request is logged either way (apiLogger), showing whether the token matched.
export const bankApiKey = (req: Request) => String(req.query?.api_key || req.query?.api || req.headers["x-api-key"] || "").trim();

export const requireBankCollector = async (req: Request & any, res: Response, next: NextFunction) => {
   try {
      const token = bankApiKey(req);
      const collector = token ? await prisma.collector.findFirst({ where: { apiToken: token, apiEnabled: true }, select: { id: true, name: true } }) : null;
      if (collector) {
         req.collector = collector;
         return next();
      }
      if (process.env.BANK_API_ALLOW_UNAUTHENTICATED === "true") return next();
      return res.status(401).json({ success: false, data: null, msg: "Invalid or missing API key" });
   } catch (error: any) {
      console.log("requireBankCollector failed:", error?.message);
      return res.status(500).json({ success: false, data: null, msg: "Could not verify API token" });
   }
};
