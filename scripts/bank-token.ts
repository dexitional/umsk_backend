// Issue or rotate a Bank API key for a collector (fms_collector), and enable
// it. Banks send it as ?api_key=<key> on every Bank API call, e.g.
// https://portal.akatsico.edu.gh/api/v1/services?api_key=<key>. Rotating
// immediately invalidates the old key.
//
//   npm run bank-token                                  list collectors
//   npm run bank-token -- "Calbank"                     generate a new key (printed once)
//   npm run bank-token -- "Calbank" --token <key>       register a key already issued to the bank
//   npm run bank-token -- "Calbank" --disable           switch the collector's API access off
import "dotenv/config";
import { randomBytes } from "crypto";
import { prisma } from "../prisma/client";

(async () => {
   const [name, flag, value] = process.argv.slice(2);
   const collectors = await prisma.collector.findMany({ select: { id: true, name: true, apiEnabled: true, apiToken: true } });
   if (!name) {
      collectors.forEach((c) => console.log(`- ${c.name}  (API ${c.apiEnabled ? "enabled" : "disabled"}, ${c.apiToken ? "token set" : "NO TOKEN"})`));
      process.exit(0);
   }
   const matches = collectors.filter((c) => c.name.toLowerCase().includes(name.toLowerCase()));
   if (matches.length !== 1) {
      console.error(matches.length ? `"${name}" matches ${matches.length} collectors: ${matches.map((c) => c.name).join(", ")}. Be more specific.` : `No collector matches "${name}".`);
      process.exit(1);
   }
   const c = matches[0];
   if (flag === "--disable") {
      await prisma.collector.update({ where: { id: c.id }, data: { apiEnabled: false } });
      await prisma.log.create({ data: { action: "BANK_API_TOKEN_DISABLED", user: "system", meta: { collectorId: c.id, collector: c.name } } });
      console.log(`API access disabled for ${c.name}.`);
      process.exit(0);
   }
   if (flag === "--token" && !(value && /^[A-Za-z0-9_-]{16,}$/.test(value))) {
      console.error("--token needs the key issued to the bank: at least 16 letters/digits (- and _ allowed).");
      process.exit(1);
   }
   const token = flag === "--token" ? value : randomBytes(32).toString("hex");
   const clash = await prisma.collector.findFirst({ where: { apiToken: token, NOT: { id: c.id } }, select: { name: true } });
   if (clash) {
      console.error(`That key is already used by ${clash.name}. Each collector needs its own key.`);
      process.exit(1);
   }
   await prisma.collector.update({ where: { id: c.id }, data: { apiToken: token, apiEnabled: true } });
   await prisma.log.create({ data: { action: c.apiToken ? "BANK_API_TOKEN_ROTATED" : "BANK_API_TOKEN_ISSUED", user: "system", meta: { collectorId: c.id, collector: c.name, tokenEnding: token.slice(-4) } } });
   console.log(flag === "--token"
      ? `API key ending ${token.slice(-4)} registered for ${c.name}; API access enabled.`
      : `API key for ${c.name} (shown once, store it securely):\n\n  ${token}\n`);
   process.exit(0);
})().catch((e) => { console.error(e?.message || e); process.exit(1); });
