require('dotenv').config({ path: '.env.local' })
const postgres = require('postgres')

;(async () => {
  try {
    const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' })
    const rows = await sql`SELECT id, email, name FROM users WHERE email = 'dev+smoke@example.com' LIMIT 1`
    console.log(rows)
    await sql.end({ timeout: 2 })
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
})()
