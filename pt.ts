import { openDatabase } from './server/db/db.ts';
import { seedCatalogue } from './server/domain/products.ts';
import { analyseImport, getBatch, commitBatch } from './server/intelligence/imports.ts';
import { listExceptions } from './server/domain/exceptions.ts';
openDatabase(':memory:'); seedCatalogue();
process.env.TERRAM_DISABLE_AI='1';
const actor = { userId: null, kind: 'system' as const, name: 'Test' };
const text = `John:
2kg mince
4 rumps
2 ribeye bone in
Collection Saturday

Sarah:
6 fillets
1kg boerewors

Mark:
3kg chicken breasts
Delivery Friday

John: Actually make the mince 3kg.

Sarah: Can I have 4 of those steaks again?

Mark: 2 cowboy steaks

Sarah:
6 fillets
1kg boerewors

Pete: Thanks!`;
const bid = await analyseImport({ text }, actor);
const b = getBatch(bid);
console.log(b.stats);
for (const d of b.drafts) {
  const x: any = d.data;
  console.log(`#${d.position+1} ${d.kind} ${d.status} ${d.confidence} — ${x.customer?.name} (${x.customer?.match})`);
  if (x.items) for (const i of x.items) console.log('    ', i.product_name ?? `? "${i.phrase}"`, i.qty_label ?? JSON.stringify(i.qty), i.preparation_label);
  for (const i of x.issues) console.log('     !', i.severity, i.code, i.message);
  if (x.events?.length) console.log('     events:', x.events.map((e:any)=>e.summary));
}
const r = commitBatch(bid, { sendRestToExceptions: true }, actor, 'admin');
console.log(JSON.stringify(r));
for (const e of listExceptions({status:'open'})) console.log('EXC', e.severity, e.type, e.title);
