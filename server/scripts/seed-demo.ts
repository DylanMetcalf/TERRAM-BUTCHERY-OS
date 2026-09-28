/** Load the Test Mode sample data into the configured database. */
import { openDatabase } from '../db/db.js';
import { seedCatalogue, upgradeCatalogue } from '../domain/products.js';
import { loadSampleData, sampleDataStatus } from '../seed/sample.js';

process.env.TERRAM_DISABLE_AI = '1';
openDatabase(process.env.DATABASE_PATH ?? './data/terram.db');
seedCatalogue();
upgradeCatalogue();
await loadSampleData({ userId: null, kind: 'system', name: 'CLI' });
console.log(sampleDataStatus());
