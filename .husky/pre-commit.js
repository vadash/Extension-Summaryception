#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const TAIL_LINES = Number.parseInt(process.env.PRECOMMIT_ERROR_LINES || '60', 10);
const FLAG_FILE = path.join(os.tmpdir(), 'summaryception-repomix.flag');
const MAX_AGE_MS = 120 * 1000;
const REPOMIX_CMDS = [
    'repomix:source',
    'repomix:tests',
    'repomix:compressed-source',
    'repomix:compressed-tests',
];
const passed = [];

const npmCli = findNpmCli();

/** Find the npm CLI entrypoint for the current Node installation. */
function findNpmCli() {
    const nodeDir = path.dirname(process.execPath);
    const candidates = [
        path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
        console.error('FAIL setup');
        console.error('Unable to locate npm-cli.js for this Node installation.');
        process.exit(1);
    }
    return found;
}

/** @param {unknown} output @returns {string} */
function tailOutput(output) {
    return String(output || '')
        .trim()
        .split(/\r?\n/)
        .slice(-TAIL_LINES)
        .join('\n');
}

/**
 * @param {string} label @param {string[]} args
 * @param args
 */
function runNpm(label, args) {
    try {
        execFileSync(process.execPath, [npmCli, ...args], {
            encoding: 'utf8',
            env: process.env,
            stdio: 'pipe',
        });
        passed.push(label);
    } catch (error) {
        console.error(`FAIL ${label}`);
        const output = `${error.stdout || ''}${error.stderr || ''}`;
        console.error(tailOutput(output));
        process.exit(error.status || 1);
    }
}

/** Check whether background repomix outputs are old enough to refresh. */
function shouldRunRepomix() {
    if (!fs.existsSync(FLAG_FILE)) {
        return true;
    }
    return Date.now() - fs.statSync(FLAG_FILE).mtimeMs >= MAX_AGE_MS;
}

/**
 *
 */
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

runNpm('tsc', ['exec', '--', 'tsc', '--noEmit', '--pretty', 'false']);
runNpm('lint-staged', ['exec', '--', 'lint-staged', '--verbose']);
runNpm('tests', ['test']);

if (shouldRunRepomix()) {
    startRepomixInBackground();
}

console.log(`PASS ${passed.join(' | ')}`);
