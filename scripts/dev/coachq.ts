import { askGuide } from '../../server/guide/guide';
import { NoneProvider } from '../../server/llm/provider';
import { newGameDb } from '../../tests/helpers';
const none = { provider: new NoneProvider(), timeoutMs: 1000 };
const { db } = newGameDb();
for (const q of process.argv.slice(2)) console.log(q, '\n', JSON.stringify(await askGuide(db, none, q, 'dashboard'), null, 1), '\n');
