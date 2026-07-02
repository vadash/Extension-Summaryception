import js from '@eslint/js';
import globals from 'globals';
import prettierConfig from 'eslint-config-prettier';

export default [
    {
        ignores: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
    },
    js.configs.recommended,
    prettierConfig,
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
            // Project style (documented in AGENTS.md)
            // `indent`, `quotes` formatting is delegated to Prettier via eslint-config-prettier
            semi: ['error', 'always'],
            'no-unused-vars': [
                'warn',
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
        },
    },
];
