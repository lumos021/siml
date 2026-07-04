// app/api/registry/route.ts - T2 fingerprint registry HTTP endpoint
// GET  /api/registry?hash=<64-hex-char pHash>  → { match, dist, key, candidates }
// POST /api/registry                           → body { hash, payload }  → { ok, hash }
//
// Storage: Upstash Redis when UPSTASH_REDIS_REST_URL/_TOKEN are set (persistent
// on Vercel), else a local .siml-registry.json file (dev). A committed seed of
// the bundled sample entries is always overlaid, so the deployed demo resolves
// its own samples via T2 with zero configuration.
// Hamming-distance lookup (≤ 24) matches the spec §5.3 ratified threshold.
import { NextRequest, NextResponse } from 'next/server'

// CORS: the registry is a public demo endpoint queried from other origins
// (the Canva app iframe, external SIML readers). Reads and writes are already
// unauthenticated by design at this stage, so a permissive CORS policy adds
// no new exposure.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS () {
  return new NextResponse(null, { status: 204, headers: CORS })
}
import fs from 'fs'
import path from 'path'
import seed from '../../../seed-registry.json'

const REGISTRY_PATH = path.join(process.cwd(), '.siml-registry.json')
const MATCH_THRESHOLD = 24
const UP_URL = process.env.UPSTASH_REDIS_REST_URL
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const KV_KEY = 'siml-registry'

function hammingHex (a: string, b: string): number {
  if (a.length !== b.length) return Infinity
  let dist = 0
  for (let i = 0; i < a.length; i += 2) {
    let xor = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16)
    while (xor > 0) { if (xor & 1) dist++; xor >>>= 1 }
  }
  return dist
}

async function loadStore (): Promise<Record<string, unknown>> {
  if (UP_URL && UP_TOKEN) {
    try {
      const res = await fetch(`${UP_URL}/hgetall/${KV_KEY}`, {
        headers: { Authorization: `Bearer ${UP_TOKEN}` },
        cache: 'no-store',
      })
      const json = await res.json()
      const out: Record<string, unknown> = {}
      const flat: string[] = json.result || []
      for (let i = 0; i + 1 < flat.length; i += 2) {
        try { out[flat[i]] = JSON.parse(flat[i + 1]) } catch {}
      }
      return out
    } catch { return {} }
  }
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) } catch { return {} }
}

async function saveEntry (hash: string, payload: unknown): Promise<void> {
  if (UP_URL && UP_TOKEN) {
    await fetch(`${UP_URL}/hset/${KV_KEY}/${hash}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UP_TOKEN}` },
      body: JSON.stringify(payload),
    })
    return
  }
  let reg: Record<string, unknown> = {}
  try { reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) } catch {}
  reg[hash] = payload
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2))
}

async function load (): Promise<Record<string, unknown>> {
  // seed first, store second: a re-registered hash overrides the bundled entry
  return { ...(seed as Record<string, unknown>), ...(await loadStore()) }
}

export async function GET (request: NextRequest) {
  const hash = request.nextUrl.searchParams.get('hash')
  if (!hash || hash.length !== 64) {
    return NextResponse.json({ error: 'hash required (64 hex chars)' }, { status: 400, headers: CORS })
  }
  const reg = await load()
  // §5.3.1 step 1: return the CANDIDATE SET (all within threshold), nearest first,
  // so the client can verify against pixels rather than trust a single nearest.
  const candidates: { key: string; dist: number; entry: unknown }[] = []
  for (const key of Object.keys(reg)) {
    if (key.length !== 64) continue
    const dist = hammingHex(hash, key)
    if (dist <= MATCH_THRESHOLD) candidates.push({ key, dist, entry: reg[key] })
  }
  candidates.sort((a, b) => a.dist - b.dist)
  if (candidates.length) {
    // `match`/`dist` kept for back-compat (nearest); `candidates` is the §5.3.1 set.
    return NextResponse.json({
      match: candidates[0].entry, dist: candidates[0].dist, key: candidates[0].key,
      candidates,
    }, { headers: CORS })
  }
  return NextResponse.json({ match: null, candidates: [] }, { headers: CORS })
}

export async function POST (request: NextRequest) {
  try {
    const body = await request.json()
    const { hash, payload } = body
    if (!hash || !payload || hash.length !== 64 || !/^[0-9a-f]{64}$/i.test(hash)) {
      return NextResponse.json({ error: 'hash (64 hex) and payload required' }, { status: 400, headers: CORS })
    }
    await saveEntry(hash, payload)
    return NextResponse.json({ ok: true, hash }, { headers: CORS })
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: CORS })
  }
}
