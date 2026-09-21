/**
 * PWA 用アイコン(PNG)を生成するスクリプト。外部ライブラリは使わない。
 *   node scripts/generate-icons.mjs
 *
 * 緑の盤に、黒と白で塗り分けた石を1つ置いたデザイン。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons')

const BOARD = [28, 118, 76] // 盤の緑
const BOARD_EDGE = [13, 61, 39] // 盤の縁
const BLACK = [16, 22, 20]
const WHITE = [244, 248, 246]

function crc32(buf) {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

function encodePng(size, colorAt) {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  let offset = 0
  const SAMPLES = 3 // 3x3 で平均してギザギザを抑える
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = (x + (sx + 0.5) / SAMPLES) / size
          const py = (y + (sy + 0.5) / SAMPLES) / size
          const c = colorAt(px, py)
          r += c[0]
          g += c[1]
          b += c[2]
        }
      }
      const n = SAMPLES * SAMPLES
      raw[offset++] = Math.round(r / n)
      raw[offset++] = Math.round(g / n)
      raw[offset++] = Math.round(b / n)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** x, y は 0..1。scale を小さくすると絵柄が内側に寄る（maskable 用）。 */
function colorAt(x, y, scale) {
  const nx = (x - 0.5) / scale + 0.5
  const ny = (y - 0.5) / scale + 0.5

  // 盤の縁
  if (nx < 0.06 || nx > 0.94 || ny < 0.06 || ny > 0.94) return BOARD_EDGE

  const dx = nx - 0.5
  const dy = ny - 0.5
  const dist = Math.sqrt(dx * dx + dy * dy)

  if (dist > 0.33) {
    // 盤面のマス目を薄く描く
    const gx = Math.abs(((nx - 0.06) / 0.22) % 1)
    const gy = Math.abs(((ny - 0.06) / 0.22) % 1)
    if (gx < 0.03 || gy < 0.03) return BOARD_EDGE
    return BOARD
  }
  if (dist > 0.30) return BOARD_EDGE // 石の影
  return dx + dy < 0 ? BLACK : WHITE
}

function makeIcon(size, { maskable }) {
  const scale = maskable ? 0.74 : 1
  return encodePng(size, (x, y) => colorAt(x, y, scale))
}

mkdirSync(OUT_DIR, { recursive: true })
const files = [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: false }],
]
for (const [name, size, options] of files) {
  writeFileSync(join(OUT_DIR, name), makeIcon(size, options))
  console.log('generated', name)
}
