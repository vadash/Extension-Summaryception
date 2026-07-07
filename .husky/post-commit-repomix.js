#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const FLAG_FILE = path.join(os.tmpdir(), 'summaryception-repomix.flag');
const MAX_AGE_MS = 120 * 1000;
const REPOMIX_CMDS = [
    'repomix:source',
    'repomix:tests',
    'repomix:compressed-source',
    'repomix:compressed-tests',
];

const npmCli = findNpmCli();

/** Find the npm CLI entrypoint for the current Node installation. */
function findNpmCli() {
    const nodeDir = path.dirname(process.execPath);
    const candidates = [
        path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
        console.error('FAIL setup');
        console.error('Unable to locate npm-cli.js for this Node installation.');
        process.exit(1);
    }
    return found;
}

/** Check whether background repomix outputs are old enough to refresh. */
function shouldRunRepomix() {
    if (!fs.existsSync(FLAG_FILE)) {
        return true;
    }
    return Date.now() - fs.statSync(FLAG_FILE).mtimeMs >= MAX_AGE_MS;
}

function startRepomixInBackground() {
    fs.writeFileSync(FLAG_FILE, String(Date.now()));
    const child = spawn(
        process.execPath,
        [
            path.join(import.meta.dirname, 'pre-commit-repomix.mjs'),
            npmCli,
            FLAG_FILE,
            ...REPOMIX_CMDS,
        ],
        {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        },
    );
    child.unref();
}

if (shouldRunRepomix()) {
    startRepomixInBackground();
}
