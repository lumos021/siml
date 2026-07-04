// app/api/stash/route.ts - short-lived download stash for host apps (Canva).
// Canva's sandboxed iframe blocks programmatic <a download>, and asset upload
// re-encodes (destroying the T0 chunk). So the app POSTs the finished SIML PNG
// bytes here, gets a token, and opens /api/stash?id=<token> via Canva's
// approved external-URL flow - the browser then downloads a byte-exact file.
//
// In-memory, single-use, TTL-bounded: this is a delivery shim for the demo,
// not storage. On serverless it lives only within a warm instance, which is
// fine for the immediate open-then-download round-trip.
import { NextRequest, NextResponse } from 'next/server'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}
export async function OPTIONS () {
  return new NextResponse(null, { status: 204, headers: CORS })
}

type Entry = { bytes: Uint8Array; name: string; mime: string; expires: number }
const STASH: Map<string, Entry> = (globalThis as { __simlStash?: Map<string, Entry> }).__simlStash
  ?? ((globalThis as { __simlStash?: Map<string, Entry> }).__simlStash = new Map())
const TTL_MS = 5 * 60 * 1000
const MAX_BYTES = 25 * 1024 * 1024

function sweep () {
  const now = Date.now()
  for (const [k, v] of STASH) if (v.expires < now) STASH.delete(k)
}

export async function POST (request: NextRequest) {
  sweep()
  const name = (request.nextUrl.searchParams.get('name') || 'design').replace(/[^\w.-]+/g, '-')
  const mime = request.headers.get('content-type') || 'image/png'
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
  const buf = new Uint8Array(await request.arrayBuffer())
  if (!buf.length || buf.length > MAX_BYTES) {
    return NextResponse.json({ error: 'empty or too large' }, { status: 400, headers: CORS })
  }
  const id = crypto.randomUUID()
  STASH.set(id, { bytes: buf, name: `${name}.siml.${ext}`, mime, expires: Date.now() + TTL_MS })
  return NextResponse.json({ id }, { headers: CORS })
}

export async function GET (request: NextRequest) {
  sweep()
  const id = request.nextUrl.searchParams.get('id')
  const entry = id ? STASH.get(id) : undefined
  if (!id || !entry) {
    return new NextResponse('not found or expired', { status: 404, headers: CORS })
  }
  STASH.delete(id) // single use
  return new NextResponse(entry.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': entry.mime,
      'Content-Disposition': `attachment; filename="${entry.name}"`,
      'Cache-Control': 'no-store',
    },
  })
}
