import { spawn } from 'child_process';
import fs from 'fs';

type BackupResult =
  | { success: true; file: string }
  | { success: false; error: string | Error };

export function performBackup(): Promise<BackupResult> {
  return new Promise((resolve) => {
    fs.mkdirSync('./backup', { recursive: true });
    const file = `backup-${new Date().toISOString().replace(/:/g, '-')}.sql`;
    const dest = `./backup/${file}`;
    const fd = fs.openSync(dest, 'w');
    const dump = spawn('mysqldump', [
      `-u${process.env.MYSQL_USER}`,
      `--host=${process.env.MYSQL_HOST}`,
      process.env.MYSQL_DB as string,
    ], {
      stdio: ['ignore', fd, 'pipe'],
      env: { ...process.env, MYSQL_PWD: process.env.MYSQL_PASS },
    });
    let stderr = '';
    dump.stderr?.on('data', (chunk) => { stderr += chunk; });
    dump.on('error', (error) => { fs.closeSync(fd); resolve({ success: false, error }); });
    dump.on('close', (code) => {
      fs.closeSync(fd);
      if (code !== 0) return resolve({ success: false, error: stderr || `mysqldump exited with code ${code}` });
      fs.stat(dest, (err, stats) => {
        if (err || !stats.size) return resolve({ success: false, error: err || "Backup file is empty." });
        resolve({ success: true, file });
      });
    });
  });
}