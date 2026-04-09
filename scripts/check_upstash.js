require('dotenv').config({ path: '.env.local' })
const { Redis } = require('@upstash/redis')

;(async () => {
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN
    if (!url || !token) {
      console.error('UPSTASH env missing')
      process.exit(2)
    }

    const r = new Redis({ url, token })
    const key = 'login_otp:dev+smoke@example.com'
    const val = await r.get(key)
    const ttl = typeof r.ttl === 'function' ? await r.ttl(key) : 'ttl-not-supported'
    console.log('UPSTASH KEY:', key)
    console.log('VALUE:', JSON.stringify(val))
    console.log('TTL:', ttl)
  } catch (err) {
    console.error('ERROR', err)
    process.exit(1)
  }
})()
