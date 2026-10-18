import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApi } from './api/routes';
import { SaveManager } from './game/saves';
import { providerFromEnv } from './llm/config';

// Minimal .env loader (no extra dependency). Real environment variables win.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const port = Number(process.env.PORT ?? 8787);
const saves = new SaveManager(resolve(root, process.env.DATA_DIR ?? 'data'));
const llm = providerFromEnv();
const app = express();
app.disable('x-powered-by');
app.use('/api', buildApi(saves, llm));

const dist = join(root, 'dist', 'client');
if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.listen(port, () => {
  const mode =
    llm.provider.name === 'claude-code' ? `Claude via your subscription login (${llm.provider.model})` : llm.provider.available ? `${llm.provider.name} / ${llm.provider.model}` : 'deterministic characters (LLM_PROVIDER=none)';
  console.log(`Automanager API on http://localhost:${port}  (characters: ${mode})`);
  console.log(`Saves in ${saves.dir}`);
});

const shutdown = () => {
  saves.closeAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
