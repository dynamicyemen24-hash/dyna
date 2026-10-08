/** @type {import('eslint').Linter.Config} */
const config = {
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: {
      ecmaVersion: "2022",
      ecmaFeatures: {
        jsx: true,
      },
    },
    plugins: [
      // Would add eslint-plugin-react if configured
    ],
    rules: {
      "no-unused-vars": "error",
      "eqeqeq": "error",
      "strict": "error",
    },
  },
  files: ["**/*.ts", "**/*.tsx"],
  languageOptions: {
    parser: require.resolve("@typescript-eslint/parser"),
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      something: "value",
    },
    rules: {
      // Basic rules for now
      "no-console": "warn",
      "no-alert": "error",
    },
  },
};

module.exports = config;