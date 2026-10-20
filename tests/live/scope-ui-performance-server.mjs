import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/functions.js') {
      const source = await readFile(new URL('patches/shujuku-scope-binding-patch.js', root), 'utf8');
      const names = ['syncDatabaseUiSourcePicker', 'syncDatabaseUi', 'installDatabaseUiIntegration'];
      const functions = names.map(name => {
        const match = source.match(new RegExp(`^  function ${name}\\([\\s\\S]*?^  }\\r?$`, 'm'));
        if (!match) throw new Error(`Missing function: ${name}`);
        return match[0];
      });
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(functions.join('\n'));
      return;
    }
    if (request.url !== '/') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(await readFile(new URL('tests/fixtures/scope-ui-performance.html', root)));
  } catch (error) { response.writeHead(500).end(String(error)); }
});
server.listen(Number(process.env.PORT || 18173), '127.0.0.1', () => console.log('Scope UI harness ready'));
