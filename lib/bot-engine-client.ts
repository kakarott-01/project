export async function postToBotEngine(endpoint: string, body?: any, timeoutMs = 8000) {
  const url = `${process.env.BOT_ENGINE_URL}${endpoint}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Bot-Secret': process.env.BOT_ENGINE_SECRET ?? '',
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const e = new Error('Bot engine unreachable') as any
    e.cause = err
    e.status = 503
    throw e
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error((data && (data.error ?? data.detail)) || `Bot engine error (HTTP ${res.status})`) as any
    e.status = res.status
    e.data = data
    throw e
  }
  return data
}
