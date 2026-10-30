'use strict';
/*
 * One-time migration of the data that lived in the old single-file app's browser
 * storage ("lj_store").
 *
 *   1. In the OLD page, open the browser console and run:
 *        copy(localStorage.getItem('lj_store'))
 *      then paste the clipboard into a file, e.g. old-store.json
 *   2. Stop the server (npm start must not be running).
 *   3. node scripts/import-state.js old-store.json
 *   4. Start the server again and log in with the imported admin password.
 */
const fs = require('fs');
const store = require('../lib/store');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/import-state.js <old-store.json>');
  process.exit(1);
}

let obj;
try {
  obj = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error('Could not read ' + file + ': ' + e.message);
  process.exit(1);
}
if (!obj || !Array.isArray(obj.products)) {
  console.error('This does not look like an lj_store export (no products list).');
  process.exit(1);
}

store.init();
const version = store.importState(obj);
console.log('Imported ' + obj.products.length + ' products, ' + ((obj.orders || []).length) + ' orders, ' +
  ((obj.customers || []).length) + ' customers, ' + ((obj.staff || []).length) + ' staff.');
console.log('Store version is now ' + version + '.');
if (!obj.pin) console.log('The old file had no admin password, so the current one was kept.');
