require('dotenv').config({ path: '.env.local' })
const jwt = require('jsonwebtoken')

const codeId = process.argv[2]
if (!codeId) {
  console.error('Usage: node mk_signup_token.js <accessCodeId>')
  process.exit(2)
}

const secret = process.env.SIGNUP_JWT_SECRET || process.env.ENCRYPTION_KEY
if (!secret) {
  console.error('SIGNUP_JWT_SECRET or ENCRYPTION_KEY not set')
  process.exit(2)
}

const payload = { accessCodeId: codeId, expiresAt: Date.now() + 5 * 60 * 1000 }
const token = jwt.sign(payload, secret, { expiresIn: '5m' })
console.log(token)
