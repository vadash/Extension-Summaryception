import js from '@eslint/js';
import globals from 'globals';
import prettierConfig from 'eslint-config-prettier';
import jsdocPlugin from 'eslint-plugin-jsdoc';
import unicornPlugin from 'eslint-plugin-unicorn';
import boundariesPlugin from 'eslint-plugin-boundaries';

export default [
    {
        ignores: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
    },
    js.configs.recommended,
    prettierConfig,
    jsdocPlugin.configs['flat/recommended'],
    {
        files: ['src/**/*.js'],
        plugins: {
            unicorn: unicornPlugin,
            boundaries: boundariesPlugin,
        },
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                SillyTavern: 'readonly',
                toastr: 'readonly',
                jQuery: 'readonly',
                $: 'readonly',
            },
        },
        settings: {
            'boundaries/elements': [
                { type: 'constants', pattern: 'src/constants.js' },
                { type: 'logger', pattern: 'src/logger.js' },
                { type: 'retry', pattern: 'src/retry.js' },
                { type: 'state', pattern: 'src/state.js' },
                {
                    type: 'core',
                    pattern: [
                        'src/ghosting.js',
                        'src/chatutils.js',
                        'src/connectionutil.js',
                        'src/summarizer.js',
                    ],
                },
                {
                    type: 'feature',
                    pattern: [
                        'src/injection.js',
                        'src/persist.js',
                        'src/memory.js',
                        'src/prompts.js',
                    ],
                },
                { type: 'entry', pattern: ['src/ui.js', 'src/events.js', 'src/commands.js'] },
            ],
        },
        rules: {
            // Naming conventions (enforces AGENTS.md standards)
            camelcase: [
                'error',
                {
                    properties: 'never',
                    ignoreDestructuring: true,
                    allow: ['^event_types$', '^chat_metadata$'],
                },
            ],
            'new-cap': ['error', { capIsNew: false }],

            // Complexity limits
            complexity: ['warn', { max: 15 }],
            'max-depth': ['warn', { max: 4 }],
            'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
            'max-lines-per-function': [
                'warn',
                { max: 80, skipBlankLines: true, skipComments: true },
            ],
            'max-params': ['warn', { max: 4 }],

            // Project style (documented in AGENTS.md)
            // `indent`, `quotes` formatting is delegated to Prettier via eslint-config-prettier
            semi: ['error', 'always'],
            'no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
            'no-console': 'off', // extension prints to browser console for debugging

            // Quality
            'no-var': 'error',
            'prefer-const': 'error',
            eqeqeq: ['error', 'always'],
            curly: ['error', 'all'],
            'no-implicit-globals': 'error',

            // Technical debt tracking
            'unicorn/expiring-todo-comments': [
                'warn',
                {
                    allowWarningComments: false,
                    ignore: [],
                    terms: ['todo', 'fixme', 'xxx', 'hack'],
                },
            ],

            // JSDoc type enforcement on public exports
            'jsdoc/require-jsdoc': [
                'warn',
                {
                    require: {
                        FunctionDeclaration: false,
                        MethodDefinition: false,
                        ClassDeclaration: false,
                        ArrowFunctionExpression: false,
                        FunctionExpression: false,
                    },
                    contexts: [
                        'ExportNamedDeclaration > FunctionDeclaration',
                        'ExportNamedDeclaration > ArrowFunctionExpression',
                        'ExportNamedDeclaration > ClassDeclaration',
                    ],
                },
            ],
            'jsdoc/require-param-type': 'warn',
            'jsdoc/require-returns': 'warn',
            'jsdoc/require-returns-type': 'warn',
            'jsdoc/check-types': 'warn',
            'jsdoc/valid-types': 'warn',
            'jsdoc/require-description': 'off',
            'jsdoc/require-returns-description': 'off',
            'jsdoc/tag-lines': 'off',
            'jsdoc/check-param-names': 'off',
            'jsdoc/require-param-description': 'off',
            'jsdoc/require-param': 'off',

            // Module boundary enforcement: foundation -> core -> feature -> entry
            'boundaries/element-types': [
                'warn',
                {
                    default: 'disallow',
                    rules: [
                        { from: 'constants', allow: ['constants'] },
                        { from: 'logger', allow: ['constants', 'logger'] },
                        { from: 'retry', allow: ['constants', 'retry'] },
                        { from: 'state', allow: ['constants', 'logger', 'state'] },
                        { from: 'core', allow: ['constants', 'logger', 'retry', 'state', 'core'] },
                        {
                            from: 'feature',
                            allow: ['constants', 'logger', 'state', 'core', 'feature'],
                        },
                        {
                            from: 'entry',
                            allow: [
                                'constants',
                                'logger',
                                'retry',
                                'state',
                                'core',
                                'feature',
                                'entry',
                            ],
                        },
                    ],
                },
            ],
        },
    },
    {
        files: ['*.js'],
        ignores: ['src/**'],
        plugins: {
            unicorn: unicornPlugin,
        },
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
        },
        rules: {
            camelcase: [
                'error',
                {
                    properties: 'never',
                    ignoreDestructuring: true,
                    allow: ['^event_types$', '^chat_metadata$'],
                },
            ],
            'new-cap': ['error', { capIsNew: false }],
            complexity: ['warn', { max: 15 }],
            'max-depth': ['warn', { max: 4 }],
            semi: ['error', 'always'],
            'no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
            'no-console': 'off',
            'no-var': 'error',
            'prefer-const': 'error',
            eqeqeq: ['error', 'always'],
            curly: ['error', 'all'],
            'no-implicit-globals': 'error',
            'unicorn/expiring-todo-comments': [
                'warn',
                {
                    allowWarningComments: false,
                    ignore: [],
                    terms: ['todo', 'fixme', 'xxx', 'hack'],
                },
            ],
            'jsdoc/require-param-type': 'warn',
            'jsdoc/require-returns': 'warn',
            'jsdoc/require-returns-type': 'warn',
            'jsdoc/check-types': 'warn',
            'jsdoc/valid-types': 'warn',
            'jsdoc/require-description': 'off',
            'jsdoc/require-returns-description': 'off',
            'jsdoc/tag-lines': 'off',
            'jsdoc/check-param-names': 'off',
            'jsdoc/require-param-description': 'off',
            'jsdoc/require-param': 'off',
        },
    },
];
