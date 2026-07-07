#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const LAST_HEAD_FILE = path.join(os.tmpdir(), 'summaryception-repomix.last-head');
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const REPOMIX_CMDS = [
    'repomix:source-full',
    'repomix:source-compressed',
    'repomix:tests-full',
    'repomix:tests-compressed',
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

function getCurrentHead() {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    }).trim();
}

/** Check whether the current commit has already refreshed Repomix outputs. */
function shouldRunRepomix(head) {
    if (!fs.existsSync(LAST_HEAD_FILE)) {
        return true;
    }
    return fs.readFileSync(LAST_HEAD_FILE, 'utf8').trim() !== head;
}

/**
 * @param {string} head
 */
function markRepomixComplete(head) {
    fs.writeFileSync(LAST_HEAD_FILE, `${head}\n`);
}

/**
 * @param {string} command
 */
function runRepomix(command) {
    execFileSync(process.execPath, [npmCli, 'run', command], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: process.env,
        stdio: 'inherit',
    });
}

function runRepomixCommands() {
    for (const command of REPOMIX_CMDS) {
        runRepomix(command);
    }
}

const currentHead = getCurrentHead();

if (shouldRunRepomix(currentHead)) {
    runRepomixCommands();
    markRepomixComplete(currentHead);
}
