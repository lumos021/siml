const { write } = require('../src/index');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { extractWatermark } = require('../../siml-reader/src/extract');

const definition = {
  contentId: 'webp-robustness-test',
  permissions: {
    platformCanDisableSelection: true,
    platformCanDisableLinks: true,
    platformCanDisableAll: false
  },
  textLayer: [
    {
      id: 'e1',
      text: '+91 98765 43210',
      type: 'phone',
      intent: 'actionable',
      primary: true,
      selectable: true,
      bounds: { x: 10, y: 10, w: 80, h: 80 }
    }
  ]
};

async function testQuality(qualitySetting) {
  const basePng = path.resolve(__dirname, '../.sample-tmp/base.png');
  const outWebp = path.resolve(__dirname, `test-${qualitySetting.label}.webp`);

  // We write with a custom webp quality option by intercepting inside write or writing manually
  // Wait! Let's just write using sharp directly to isolate the issue!
}

async function testDirect() {
  const basePng = path.resolve(__dirname, '../.sample-tmp/base.png');
  
  // 1. Generate watermarked raw pixels
  const { embedWatermark } = require('../src/watermark');
  const CANONICAL_WIDTH = 1024;
  const canonicalHeight = 512;
  
  const { data } = await sharp(basePng)
    .resize(CANONICAL_WIDTH, canonicalHeight)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
    
  embedWatermark(data, CANONICAL_WIDTH, canonicalHeight, Buffer.from('+91 98765 43210'.padEnd(16, '\0')));

  // Test different WebP compression formats
  const configs = [
    { label: 'lossless: true', options: { lossless: true } },
    { label: 'nearLossless: true', options: { nearLossless: true } },
    { label: 'quality: 100', options: { quality: 100 } },
    { label: 'quality: 98', options: { quality: 98 } },
    { label: 'quality: 95', options: { quality: 95 } },
    { label: 'quality: 92', options: { quality: 92 } },
    { label: 'quality: 90', options: { quality: 90 } },
    { label: 'quality: 80', options: { quality: 80 } }
  ];

  for (const conf of configs) {
    const tmpFile = path.resolve(__dirname, `tmp-${conf.label.replace(':', '').replace(' ', '')}.webp`);
    await sharp(data, {
      raw: { width: CANONICAL_WIDTH, height: canonicalHeight, channels: 4 }
    })
    .webp(conf.options)
    .toFile(tmpFile);

    // Read back and extract
    const { data: back, info } = await sharp(fs.readFileSync(tmpFile)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    console.log(`  Decoded back: ${info.width}x${info.height}, channels: ${info.channels}, length: ${back.length}`);
    const payloadBytes = extractWatermark(back, CANONICAL_WIDTH, canonicalHeight, 16);
    fs.unlinkSync(tmpFile);

    if (payloadBytes) {
      const text = new TextDecoder('utf-8').decode(payloadBytes).replace(/\0/g, '');
      console.log(`[${conf.label}] ✅ SUCCESS: extracted "${text}"`);
    } else {
      console.log(`[${conf.label}] ❌ FAILED`);
    }
  }

  // Double compression test: WebP q92 -> JPEG q40
  console.log('\nRunning double compression test: WebP q92 -> JPEG q40...');
  const webpFile = path.resolve(__dirname, 'tmp-webpq92.webp');
  await sharp(data, {
    raw: { width: CANONICAL_WIDTH, height: canonicalHeight, channels: 4 }
  })
  .webp({ quality: 92 })
  .toFile(webpFile);

  const jpegFile = path.resolve(__dirname, 'tmp-double.jpg');
  await sharp(fs.readFileSync(webpFile))
    .jpeg({ quality: 40 })
    .toFile(jpegFile);

  const backDouble = await sharp(fs.readFileSync(jpegFile)).ensureAlpha().raw().toBuffer();
  const resDouble = extractWatermark(backDouble, CANONICAL_WIDTH, canonicalHeight, 16);
  fs.unlinkSync(webpFile);
  fs.unlinkSync(jpegFile);

  if (resDouble) {
    const text = new TextDecoder('utf-8').decode(resDouble).replace(/\0/g, '');
    console.log(`[WebP q92 -> JPEG q40] ✅ SUCCESS: extracted "${text}"`);
  } else {
    console.log(`[WebP q92 -> JPEG q40] ❌ FAILED`);
  }
}

testDirect().catch(console.error);
