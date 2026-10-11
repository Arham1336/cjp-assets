// Manual tool for the old-JSONB -> relational move. Since v2.0 the server imports cjp_app_state automatically on its first start,
// so you normally never need this. Useful for:
//   node migrate-to-relational.js --verify            compare the old cjp_app_state with the relational tables (run right after the first start)
//   node migrate-to-relational.js --file backup.json  restore a backup downloaded from the admin panel into EMPTY tables (add --replace to wipe first)
//   node migrate-to-relational.js                     import cjp_app_state into EMPTY tables (only if the automatic import did not run)
// Requires DATABASE_URL. The old cjp_app_state table is never modified.
require("dotenv").config();
const fs = require("fs");
const { createPool, SCHEMA_FILE, parseJson, nowIso } = require("./db");
const { migrateBlob, verifyBlob } = require("./migration-core");

const args = process.argv.slice(2);
const flagValue = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

async function legacyBlob(client) {
  try { return parseJson((await client.query("SELECT data FROM cjp_app_state WHERE id = 1")).rows[0]?.data, null); }
  catch (e) { if (e.code === "42P01") return null; throw e; }
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set. Aborting."); process.exit(1); }
  const pool = createPool(process.env.DATABASE_URL);
  const client = await pool.connect();
  try {
    await client.query(fs.readFileSync(SCHEMA_FILE, "utf8"));
    if (args.includes("--verify")) {
      const blob = await legacyBlob(client);
      if (!blob) { console.error("No old data (cjp_app_state) found - nothing to verify against."); return; }
      const r = await verifyBlob(client, blob);
      console.log("Totals (old data vs tables):", r.totals);
      if (r.ok) console.log("OK - the relational tables match the old data.");
      else { console.log(`${r.issues.length} difference(s). Members who were active after the import will differ legitimately:`); r.issues.slice(0, 200).forEach(i => console.log(" -", i)); process.exitCode = 2; }
      return;
    }
    const file = flagValue("--file");
    const blob = file ? JSON.parse(fs.readFileSync(file, "utf8")) : await legacyBlob(client);
    if (!blob) { console.error("No data to import (no --file given and no cjp_app_state found)."); return; }
    const result = await migrateBlob(client, blob, { log: console.log, replace: args.includes("--replace") });
    if (result.skipped) { console.error(`The users table already has ${result.existing} rows. Refusing to import. Use --replace to wipe the relational tables first (this DELETES them).`); process.exitCode = 1; return; }
    await client.query("INSERT INTO app_state (key, value) VALUES ('legacy_import', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify({ source: file ? "file" : "legacy_blob", at: nowIso(), counts: result.counts })]);
    console.log("\nImport complete:", result.counts);
    result.warnings.forEach(w => console.log(" warning:", w));
  } catch (e) {
    console.error("Failed (nothing was changed):", e.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}
main();
