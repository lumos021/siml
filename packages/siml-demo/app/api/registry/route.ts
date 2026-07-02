// app/api/registry/route.ts - T2 fingerprint registry HTTP endpoint
// GET  /api/registry?hash=<64-hex-char pHash>  → { match: payload | null, dist, key }
// POST /api/registry                           → body { hash, payload }  → { ok, hash }
//
// Stores entries in .siml-registry.json alongside the Next.js project root.
// Hamming-distance lookup (≤ 24) matches the spec §5.3 ratified threshold.
import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const REGISTRY_PATH = path.join(process.cwd(), '.siml-registry.json')
const MATCH_THRESHOLD = 24

function hammingHex (a: string, b: string): number {
  if (a.length !== b.length) return Infinity
  let dist = 0
  for (let i = 0; i < a.length; i += 2) {
    let xor = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16)
    while (xor > 0) { if (xor & 1) dist++; xor >>>= 1 }
  }
  return dist
}

function load (): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) } catch { return {} }
}

function save (reg: Record<string, unknown>) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2))
}

export async function GET (request: NextRequest) {
  const hash = request.nextUrl.searchParams.get('hash')
  if (!hash || hash.length !== 64) {
    return NextResponse.json({ error: 'hash required (64 hex chars)' }, { status: 400 })
  }
  const reg = load()
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
    })
  }
  return NextResponse.json({ match: null, candidates: [] })
}

export async function POST (request: NextRequest) {
  try {
    const body = await request.json()
    const { hash, payload } = body
    if (!hash || !payload || hash.length !== 64) {
      return NextResponse.json({ error: 'hash (64 hex) and payload required' }, { status: 400 })
    }
    const reg = load()
    reg[hash as string] = payload
    save(reg)
    return NextResponse.json({ ok: true, hash })
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }
}
