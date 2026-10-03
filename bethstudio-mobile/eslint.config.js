// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["node_modules/*", "dist/*", ".expo/*", "src/terminal/xtermAssets.generated.ts"],
  },
  {
    files: ["tools/**/*.js", "eslint.config.js"],
    languageOptions: {
      globals: {
        require: "readonly",
        module: "writable",
        __dirname: "readonly",
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
  },
]);
