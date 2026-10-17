/**
 * Bundles the OpenChamber server (packages/web/server) for the extension into
 * dist/openchamber-server/. The VSIX ships without node_modules, so the server
 * and its npm dependencies become one ESM file, server.mjs, which the extension
 * host runs as a child process (src/openchamber-server-process.ts).
 *
 * Server modules find files next to themselves through `import.meta.url`
 * (`new URL('./ssh-wrapper.js', import.meta.url)`,
 * `createRequire(import.meta.url)('./settings-registry.json')`). In one bundle
 * every module would share the bundle's URL, so each server module's
 * `import.meta.url` is rewritten to its original path under the output folder,
 * and every file such a module names is copied there. A server module that
 * starts naming another sibling file gets it staged without a change here.
 *
 * Native modules stay external: node-pty and bun-pty serve the terminal and
 * sherpa-onnx-node local dictation, none of which the extension offers. The
 * server imports them lazily and handles their absence.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = path.resolve(packageRoot, '..', 'web', 'server');
const outDir = path.join(packageRoot, 'dist', 'openchamber-server');

// `new URL('<relative>', import.meta.url)` and `createRequire(import.meta.url)('<relative>')`.
const SIBLING_FILE_REFERENCES = [
  /new URL\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g,
  /createRequire\(\s*import\.meta\.url\s*\)\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g,
];

const isInside = (root, candidate) => candidate.startsWith(root + path.sep);

const serverModuleUrlPlugin = (stagedFiles) => ({
  name: 'openchamber-server-module-url',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.(?:js|mjs)$/ }, async (args) => {
      if (!isInside(serverRoot, args.path)) return undefined;
      const source = await fs.readFile(args.path, 'utf8');
      if (!source.includes('import.meta.url')) return undefined;
      for (const pattern of SIBLING_FILE_REFERENCES) {
        for (const match of source.matchAll(pattern)) {
          const target = path.resolve(path.dirname(args.path), match[2]);
          // Files outside the server, such as package.json, are not staged.
          if (isInside(serverRoot, target)) stagedFiles.add(target);
        }
      }
      const relativePath = path.relative(serverRoot, args.path).split(path.sep).join('/');
      return {
        contents: source.replaceAll('import.meta.url', `__openchamberServerModuleUrl(${JSON.stringify(relativePath)})`),
        loader: 'js',
      };
    });
  },
});

const stagedFiles = new Set();
await fs.rm(outDir, { recursive: true, force: true });

await build({
  entryPoints: [path.join(packageRoot, 'src', 'openchamber-server-entry.ts')],
  outfile: path.join(outDir, 'server.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  mainFields: ['module', 'main'],
  minify: true,
  external: ['node-pty', 'bun-pty', 'sherpa-onnx-node'],
  banner: {
    js: [
      // Bundled CommonJS dependencies call `require` for Node built-ins.
      "import { createRequire as __openchamberCreateRequire } from 'node:module';",
      'const require = __openchamberCreateRequire(import.meta.url);',
      'const __openchamberServerModuleUrl = (relativePath) => new URL(relativePath, import.meta.url).href;',
    ].join('\n'),
  },
  plugins: [serverModuleUrlPlugin(stagedFiles)],
  logLevel: 'warning',
});

let copied = 0;
for (const file of stagedFiles) {
  // A directory reference (the built-in extension root) is not a file to copy.
  if (!(await fs.stat(file)).isFile()) continue;
  const target = path.join(outDir, path.relative(serverRoot, file));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(file, target);
  copied += 1;
}

// The extension renders no extension panels, so its server registers none.
await fs.mkdir(path.join(outDir, 'built-in-extensions'), { recursive: true });
await fs.writeFile(
  path.join(outDir, 'built-in-extensions', 'registry.json'),
  `${JSON.stringify({ version: 1, extensions: [] }, null, 2)}\n`,
);

console.log(`[vscode] OpenChamber server bundled -> dist/openchamber-server/server.mjs (${copied} sibling files staged)`);
