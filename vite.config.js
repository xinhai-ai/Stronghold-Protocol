import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const absolute = (rel) => normalizePath(path.join(root, rel));
const runtimeCdn = absolute('public/js/asset-cdn.js');
const serverData = absolute('server/data.js');
const browserData = '\0stronghold-browser-data';

// Preserve the server's browser-only contracts without bundling Node data loading or runtime environment settings.
function browserContracts() {
  return {
    name: 'stronghold-browser-contracts',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.startsWith('/sim/')) return absolute(`server${source}`);
      if (source === '/vendor/three.module.js') return absolute('public/vendor/three.module.js');
      const resolved = source.startsWith('.') && importer
        ? normalizePath(path.resolve(path.dirname(importer), source)) : normalizePath(source);
      if (resolved === runtimeCdn) return { id: '/js/asset-cdn.js', external: true };
      if (resolved === serverData) return browserData;
      if (resolved === absolute('server/sim/nodeData.js')) this.error('Node-only simulation data cannot enter the client bundle');
    },
    load(id) {
      if (id === browserData) return `
        import { getSimData } from ${JSON.stringify(absolute('server/sim/simdata.js'))};
        export function getData() { return getSimData() || {}; }
        export function resetData() {}
      `;
    },
    transform(code, id) {
      if (id !== absolute('server/sim/simdata.js')) return;
      // Native ESM skips this Node-only branch at runtime; a bundler would still resolve its filesystem imports.
      // Select the existing browser branch at build time, leaving the shared simulation source untouched.
      const branch = this.parse(code).body.find((node) => node.type === 'IfStatement' && node.test.type === 'Identifier'
        && node.test.name === 'IS_NODE');
      if (!branch || branch.alternate) this.error('Cannot identify the simulation Node-only initializer');
      return { code: code.slice(0, branch.start) + code.slice(branch.end), map: null };
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html
          .replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, '')
          .replace(/\s*<link rel="modulepreload"[^>]*>/g, '')
          // Fonts remain optional and are supplied by the separate assets pipeline at runtime.
          .replace(/\s*<link rel="stylesheet" href="\/fonts\/fonts.css"\s*\/>/, '')
          .replace("why === 'old' || !im", "why === 'old'");
      },
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const html = bundle['index.html'];
        if (!html || html.type !== 'asset') throw new Error('Missing client HTML');
        let source = String(html.source);
        // Prefetch the same hashed classic scripts that ensurePixi injects, never a second unversioned copy.
        for (const name of ['pixi.min.js', 'pixi-spine.js']) {
          const asset = Object.values(bundle).find((item) => item.type === 'asset' && item.names.includes(name));
          if (!asset) throw new Error(`Missing bundled vendor asset: ${name}`);
          source = source.replace(`/vendor/${name}`, `/build/${asset.fileName}`);
        }
        source = source.replace(/(<script type="module"[^>]*)(><\/script>)/,
          '$1 onerror="window.__spBootFail && window.__spBootFail(\'load\')"$2');
        html.source = source.replace('<meta name="theme-color"', '<link rel="stylesheet" href="/fonts/fonts.css" />\n  <meta name="theme-color"');
      },
    },
  };
}

export default defineConfig({
  root: absolute('public'),
  publicDir: false, // Do not copy hundreds of MB of art or bundle optional fonts.
  base: '/build/',
  plugins: [browserContracts()],
  build: {
    outDir: absolute('public/build'),
    // Keep old hashes for tabs that still need a previous build's lazy chunks. Clean only while the server is stopped.
    emptyOutDir: false,
    target: ['chrome90', 'edge90', 'firefox108', 'safari16.4'],
    assetsInlineLimit: 0,
    manifest: true,
    rollupOptions: {
      makeAbsoluteExternalsRelative: false, // /js/asset-cdn.js is an origin URL, not a filesystem path.
      output: {
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          if (/\/vendor\/(preact|hooks|htm)\.module\.js$/.test(id)) return 'ui-vendor';
          if (/\/vendor\/three\.(core|module)\.js$/.test(id)) return 'three';
          if (id.startsWith(absolute('shared') + '/')) return 'shared';
          if (id === browserData || (id.includes('/server/sim/') && !id.endsWith('/constants.js'))) return 'simulation';
        },
      },
    },
  },
});
