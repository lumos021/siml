const { write } = require('../src/index');
const { getWatermarkFromImageElement } = require('../../siml-reader/src/extract');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const definition = {
  contentId: 'test-webp-watermark',
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

async function test() {
  const basePng = path.resolve(__dirname, '../.sample-tmp/base.png');
  // Ensure .sample-tmp directory and base.png exist
  if (!fs.existsSync(basePng)) {
    console.log('Generating dummy base.png...');
    fs.mkdirSync(path.dirname(basePng), { recursive: true });
    await sharp({
      create: {
        width: 1024,
        height: 512,
        channels: 4,
        background: { r: 20, g: 10, b: 35, alpha: 1 }
      }
    }).png().toFile(basePng);
  }

  const outWebp = path.resolve(__dirname, 'test.webp');
  await write({
    imagePath: basePng,
    definition,
    outputPath: outWebp,
    format: 'webp',
    embedWatermark: true,
  });
  console.log('Written test.webp');

  // Load and attempt extraction
  const webpBuffer = fs.readFileSync(outWebp);
  const metadata = await sharp(outWebp).metadata();
  console.log('WebP format:', metadata.format);

  const { data } = await sharp(outWebp).raw().toBuffer({ resolveWithObject: true });
  // We simulate the reader library's extraction on raw pixels
  const { extractWatermark } = require('../../siml-reader/src/extract');
  const payloadBytes = extractWatermark(data, 1024, 512, 16);
  if (payloadBytes) {
    const text = new TextDecoder('utf-8').decode(payloadBytes).replace(/\0/g, '');
    console.log('Success! Extracted watermark:', text);
  } else {
    console.log('Failed to extract watermark from WebP.');
  }

  // Cleanup
  if (fs.existsSync(outWebp)) fs.unlinkSync(outWebp);
}

test().catch(console.error);
