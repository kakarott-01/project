require('dotenv').config({ path: '.env.local' })
const postgres = require('postgres')

;(async () => {
  try {
    const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' })
    const rows = await sql`SELECT id, label, is_burned, expires_at FROM access_codes ORDER BY created_at DESC LIMIT 20`
    console.log('found', rows.length)
    for (const r of rows) console.log(r)
    await sql.end({ timeout: 2 })
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
})()
