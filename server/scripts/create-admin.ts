/**
 * Create (or reset) an admin account from the command line.
 *   npm run create-admin -- "Name" email@example.com 'password'
 */
import { openDatabase, db } from '../db/db.js';
import { seedCatalogue, upgradeCatalogue } from '../domain/products.js';
import { createUser, updateUser } from '../domain/users.js';

const [name, email, password] = process.argv.slice(2);
if (!name || !email || !password) {
  console.error('Usage: npm run create-admin -- "Full Name" email@example.com \'password\'');
  process.exit(1);
}
openDatabase(process.env.DATABASE_PATH ?? './data/terram.db');
seedCatalogue();
upgradeCatalogue();
const existing = db().prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email) as { id: string } | undefined;
const system = { userId: null, kind: 'system' as const, name: 'CLI' };
if (existing) {
  updateUser(existing.id, { role: 'admin', active: true, password }, system);
  console.log(`Reset ${email} as an active admin.`);
} else {
  createUser({ name, email, password, role: 'admin' }, system);
  console.log(`Created admin ${email}.`);
}
