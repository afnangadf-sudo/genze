// Metro config for the pnpm monorepo: watch the workspace root so the
// bundler can resolve @genze/shared (workspace:*) and the vendored web
// i18n module (../../web/lib/i18n) imported by lib/i18n.tsx.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
