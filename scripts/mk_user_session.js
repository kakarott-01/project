require('dotenv').config({ path: '.env.local' })
const { createHmac } = require('crypto')

const id = process.argv[2]
const email = process.argv[3]
const name = process.argv[4]
if (!id || !email) {
  console.error('Usage: node mk_user_session.js <id> <email> [name]')
  process.exit(2)
}

const SECRET = process.env.NEXTAUTH_SECRET || process.env.ENCRYPTION_KEY
if (!SECRET) {
  console.error('NEXTAUTH_SECRET or ENCRYPTION_KEY must be set')
  process.exit(2)
}

const payload = { id, email, name: name || email.split('@')[0] }
const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
const sig = createHmac('sha256', SECRET).update(data).digest('base64url')
console.log(`${data}.${sig}`)
