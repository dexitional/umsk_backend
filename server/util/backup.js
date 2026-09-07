"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.performBackup = performBackup;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
function performBackup() {
    return new Promise((resolve) => {
        var _a;
        fs_1.default.mkdirSync('./backup', { recursive: true });
        const file = `backup-${new Date().toISOString().replace(/:/g, '-')}.sql`;
        const dest = `./backup/${file}`;
        const fd = fs_1.default.openSync(dest, 'w');
        const dump = (0, child_process_1.spawn)('mysqldump', [
            `-u${process.env.MYSQL_USER}`,
            `--host=${process.env.MYSQL_HOST}`,
            process.env.MYSQL_DB,
        ], {
            stdio: ['ignore', fd, 'pipe'],
            env: Object.assign(Object.assign({}, process.env), { MYSQL_PWD: process.env.MYSQL_PASS }),
        });
        let stderr = '';
        (_a = dump.stderr) === null || _a === void 0 ? void 0 : _a.on('data', (chunk) => { stderr += chunk; });
        dump.on('error', (error) => { fs_1.default.closeSync(fd); resolve({ success: false, error }); });
        dump.on('close', (code) => {
            fs_1.default.closeSync(fd);
            if (code !== 0)
                return resolve({ success: false, error: stderr || `mysqldump exited with code ${code}` });
            fs_1.default.stat(dest, (err, stats) => {
                if (err || !stats.size)
                    return resolve({ success: false, error: err || "Backup file is empty." });
                resolve({ success: true, file });
            });
        });
    });
}
