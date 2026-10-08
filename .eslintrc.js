/** ESLint configuration for DyPOS v1.37.1 */
const reactPlugin = require("eslint-plugin-react");
const tsParser = require("@typescript-eslint/parser");

module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:react/recommended",
    "plugin:@typescript-eslint/recommended-type-checked",
    "plugin:@typescript-eslint/stylistic-type-checked",
  ],
  parser: tsParser,
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: ["react"],
  rules: {
    "react/react-hooks/rules-of-hooks": "error",
    "react/react-dependencies/rules-of-hook": "error",
    "react/jsx-uses-react": "error",
    "react/jsx-uses-vars": "error",
    "no-console": "warn",
    "no-restricted-syntax": [
      "error",
      "WithStatement",
      "LabeledStatement",
    ],
  },
};