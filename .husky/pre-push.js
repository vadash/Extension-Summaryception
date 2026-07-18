#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Mirror the "Lint & Format" CI job (.github/workflows/lint.yml) so whole-repo
// drift is caught before it reaches main. lint-staged in pre-commit only sees
// staged files, so files that drift out of format elsewhere slip past it.
const TAIL_LINES = Number.parseInt(process.env.PREPUSH_ERROR_LINES || '60', 10);
const passed = [];

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
        console.error('\nRun `npm run format` to fix formatting, then re-push.');
        process.exit(error.status || 1);
    }
}

runNpm('lint', ['run', 'lint']);
runNpm('format:check', ['run', 'format:check']);

console.log(`PASS ${passed.join(' | ')}`);
