import js from '@eslint/js';
import globals from 'globals';
import prettierConfig from 'eslint-config-prettier';
import jsdocPlugin from 'eslint-plugin-jsdoc';

export default [
    {
        ignores: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
    },
    js.configs.recommended,
    prettierConfig,
    jsdocPlugin.configs['flat/recommended'],
    {
        files: ['**/*.js'],
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
        rules: {
            // ── Naming conventions (enforces AGENTS.md standards) ──────
            camelcase: [
                'error',
                {
                    properties: 'never',
                    ignoreDestructuring: true,
                    allow: ['^event_types$', '^chat_metadata$'],
                },
            ],
            'new-cap': ['error', { capIsNew: false }],

            // ── Complexity limits ──────────────────────────────────────
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

            // ── JSDoc type enforcement on public exports ──────────────
            // Note: these rules apply only to exported functions and classes,
            // matching the `ExportNamedDeclaration` contexts below.
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
            // Allow @type, @typedef, and utility-style docs without requiring description
            'jsdoc/require-description': 'off',
            'jsdoc/require-returns-description': 'off',
            'jsdoc/tag-lines': 'off',
            'jsdoc/check-param-names': 'off',
            'jsdoc/require-param-description': 'off',
            'jsdoc/require-param': 'off',
        },
    },
];
