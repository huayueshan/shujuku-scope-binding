import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const names = ['applyActiveApiBinding', 'mutateDatabaseSettingsViaSave', 'buildSelectControl',
  'buildFeatureControl', 'buildFeatureRow', 'buildScopeControl', 'escapeHtml', 'positionChoiceMenu'];
const server = createServer(async (request, response) => {
  try {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/runtime.js') {
      const source = await readFile(new URL('patches/shujuku-scope-binding-patch.js', root), 'utf8');
      const functions = names.map(name => {
        const fn = source.match(new RegExp(`^  (?:async )?function ${name}\\([\\s\\S]*?^  }\\r?$`, 'm'))?.[0];
        if (!fn) throw new Error(`Missing ${name}`);
        return fn;
      });
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(`window.__SHUJUKU_SCOPE_BINDING_PATCH_TEST__ = {};\n${source}\nObject.assign(window, window.__SHUJUKU_SCOPE_BINDING_PATCH_TEST__);\n${functions.join('\n')}`);
    } else if (request.url === '/style.css') {
      const source = await readFile(new URL('patches/shujuku-scope-binding-patch.js', root), 'utf8');
      const css = source.match(/style.textContent = `([\s\S]*?)`;/)?.[1];
      response.setHeader('Content-Type', 'text/css; charset=utf-8'); response.end(css);
    } else if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(await readFile(new URL('tests/fixtures/scope-active-api.html', root)));
    } else response.writeHead(404).end();
  } catch (_) { response.writeHead(500).end('Harness error'); }
});
server.listen(Number(process.env.PORT || 18174), '127.0.0.1', () => console.log('Active API simulation ready'));
