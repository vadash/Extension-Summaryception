import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const LOG_PREFIX = '[Summaryception]';
const SKIP_ENV = 'SUMMARYCEPTION_SKIP_VERSION_BUMP';
const VERSION_FILES = ['package.json', 'package-lock.json', 'manifest.json'];
const GENERATED_COMMIT_PATTERN = /^chore: bump version to \d+\.\d+\.0$/u;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const runGit = (args, options = {}) =>
    execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, ...options.env },
        stdio: options.stdio ?? 'pipe',
    });

const readJson = (fileName) => JSON.parse(readFileSync(resolve(repoRoot, fileName), 'utf8'));

const writeJson = (fileName, data) => {
    writeFileSync(resolve(repoRoot, fileName), `${JSON.stringify(data, null, 4)}\n`);
};

const getNextMinorVersion = (version) => {
    const match = /^(\d+)\.(\d+)\.\d+$/u.exec(version);

    if (!match) {
        throw new Error(`Expected MAJOR.MINOR.PATCH version, received "${version}".`);
    }

    const major = Number.parseInt(match[1], 10);
    const minor = Number.parseInt(match[2], 10) + 1;

    return `${major}.${minor}.0`;
};

const hasVersionFileChanges = () =>
    runGit(['status', '--porcelain', '--', ...VERSION_FILES]).trim().length > 0;

const hasCodeChanges = () => {
    const changedFiles = runGit([
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--name-only',
        '-r',
        'HEAD',
    ])
        .trim()
        .split('\n')
        .filter(Boolean);

    return changedFiles.some(
        (fileName) => !fileName.startsWith('.beads/') && !/\.md$/iu.test(fileName),
    );
};

const isGeneratedVersionCommit = () => {
    const subject = runGit(['log', '-1', '--pretty=%s']).trim();

    return GENERATED_COMMIT_PATTERN.test(subject);
};

const updateVersions = (nextVersion) => {
    const packageJson = readJson('package.json');
    const packageLock = readJson('package-lock.json');
    const manifestJson = readJson('manifest.json');

    packageJson.version = nextVersion;
    packageLock.version = nextVersion;
    packageLock.packages[''].version = nextVersion;
    manifestJson.version = nextVersion;

    writeJson('package.json', packageJson);
    writeJson('package-lock.json', packageLock);
    writeJson('manifest.json', manifestJson);
};

const commitVersionBump = (nextVersion) => {
    runGit(['add', '--', ...VERSION_FILES], { stdio: 'inherit' });
    runGit(
        [
            'commit',
            '--no-verify',
            '-m',
            `chore: bump version to ${nextVersion}`,
            '--',
            ...VERSION_FILES,
        ],
        {
            env: { [SKIP_ENV]: '1' },
            stdio: 'inherit',
        },
    );
};

if (process.env[SKIP_ENV] === '1' || isGeneratedVersionCommit()) {
    process.exit(0);
}

if (hasVersionFileChanges()) {
    console.log(`${LOG_PREFIX} Version files already changed; skipping automatic version bump.`);
    process.exit(0);
}

if (!hasCodeChanges()) {
    console.log(`${LOG_PREFIX} No code changes detected; skipping automatic version bump.`);
    process.exit(0);
}

const packageJson = readJson('package.json');
const nextVersion = getNextMinorVersion(packageJson.version);

updateVersions(nextVersion);
commitVersionBump(nextVersion);
console.log(`${LOG_PREFIX} Bumped version to ${nextVersion}.`);
