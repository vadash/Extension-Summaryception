#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const TAIL_LINES = Number.parseInt(process.env.PRECOMMIT_ERROR_LINES || '60', 10);
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
        process.exit(error.status || 1);
    }
}

runNpm('tsc', ['exec', '--', 'tsc', '--noEmit', '--pretty', 'false']);
// Auto-format the whole repo and stage anything prettier rewrote.
// Runs before lint-staged so staged files are already formatted, and
// before tests so the committed state is canonical. Unsafe on purpose.
runNpm('format', ['exec', '--', 'prettier', '--write', '.']);
try {
    execFileSync('git', ['add', '-A'], { stdio: 'pipe' });
} catch (error) {
    console.error('FAIL git-add');
    console.error(tailOutput(`${error.stdout || ''}${error.stderr || ''}`));
    process.exit(error.status || 1);
}
runNpm('lint-staged', ['exec', '--', 'lint-staged', '--verbose']);
runNpm('tests', ['test']);

console.log(`PASS ${passed.join(' | ')}`);
