const path = require("node:path");

const buildIdentifier = `build-${new Date().toISOString().replace(/[:.]/g, "-")}`;

module.exports = {
  outDir: "artifacts",
  buildIdentifier,
  packagerConfig: {
    asar: true,
    extraResource: [
      "native",
      path.resolve(__dirname, "..", "runtime-host", "dist", "bundle", "runtime-host.cjs"),
    ],
    prune: false,
    name: "Sovereign Code Runtime",
    executableName: "SovereignCodeRuntime",
    ignore: [
      /^\/node_modules($|\/)/,
      /^\/src($|\/)/,
      /^\/vite\..*\.ts$/,
      /^\/tsconfig\.json$/,
      /^\/forge\.config\.cjs$/,
      /^\/artifacts($|\/)/,
      /^\/out($|\/)/,
    ],
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "SovereignCodeRuntime",
        setupExe: "SovereignCodeRuntimeSetup.exe",
        noMsi: true,
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["win32"],
      config: {},
    },
  ],
};
