#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

const [npmCli, flagFile, ...commands] = process.argv.slice(2);
if (!npmCli || !flagFile) {
    process.exit(1);
}
for (const command of commands) {
    const result = spawnSync(process.execPath, [npmCli, 'run', command], {
        stdio: 'ignore',
        windowsHide: true,
    });
    if (result.status !== 0) process.exit(result.status || 1);
}
fs.writeFileSync(flagFile, String(Date.now()));
