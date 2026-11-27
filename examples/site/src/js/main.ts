// Entry module: TypeScript (types are stripped), an ES module, a JSON module and a CommonJS module.
import { label, type Item } from './format.ts';
import items from './items.json' with { type: 'json' };
import legacy from './legacy.cjs';

const lines: string[] = (items as Item[]).map(label);
lines.push(legacy.greeting('build'));

const list = (globalThis as any).document?.getElementById('app');
if (list) {
  for (const text of lines) {
    const li = list.ownerDocument.createElement('li');
    li.textContent = text;
    list.append(li);
  }
} else {
  // Outside a browser (e.g. `node dist/js/main.<hash>.js` after renaming it to .mjs): print instead.
  for (const text of lines) console.log(text);
}
