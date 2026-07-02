#!/usr/bin/env node
// src/cli.js
const { Command } = require('commander')
const path = require('path')
const fs = require('fs')
const { write } = require('./index')

const program = new Command()
program.name('siml-write').version('0.1.0')

program.command('create')
  .requiredOption('-i, --image <path>',      'Source image (jpg/png/webp)')
  .requiredOption('-d, --definition <path>', 'Text layer JSON file')
  .option('-o, --output <path>',             'Output path')
  .option('-f, --format <fmt>',              'Output format: auto|png|jpeg|webp', 'auto')
  .action(async opts => {
    try {
      const imagePath = path.resolve(opts.image)
      const definition = JSON.parse(fs.readFileSync(path.resolve(opts.definition), 'utf8'))
      const outputPath = opts.output
        ? path.resolve(opts.output)
        : imagePath

      const result = await write({ imagePath, definition, outputPath, format: opts.format })
      console.log(`✓  ${result.outputPath}  (${(result.size/1024).toFixed(1)} KB)`)
    } catch (err) {
      if (err.errors) { err.errors.forEach(e => console.error(' -', e)); process.exit(1) }
      console.error('Error:', err.message); process.exit(1)
    }
  })

program.command('preserve')
  .description('Level P: copy the SIML layer from a source image onto a re-encoded output')
  .requiredOption('-s, --source <path>', 'Original image carrying the SIML layer')
  .requiredOption('-o, --output <path>', 'Re-encoded image to receive the layer (overwritten)')
  .action(async opts => {
    try {
      const { preserveLayer } = require('./index')
      const source = fs.readFileSync(path.resolve(opts.source))
      const output = fs.readFileSync(path.resolve(opts.output))
      const result = await preserveLayer(source, output)
      fs.writeFileSync(path.resolve(opts.output), result)
      const changed = result.length !== output.length
      console.log(changed
        ? `✓  layer preserved → ${opts.output}  (${(result.length / 1024).toFixed(1)} KB)`
        : `•  no change (no source layer, already present, or not readably preservable)`)
    } catch (e) {
      console.error('Error:', e.message); process.exit(1)
    }
  })

program.command('inspect <file>')
  .description('Extract and print the SIML text layer from any supported file')
  .action(async file => {
    try {
      const buf = fs.readFileSync(path.resolve(file))
      // Import reader extraction logic (lightweight, no DOM)
      const { extractPayload } = require('../../siml-reader/src/extract')
      const result = await extractPayload(buf.buffer)
      if (!result) {
        console.error('Error: Not a SIML file or no metadata found')
        process.exit(1)
      }
      console.log(JSON.stringify(result.payload, null, 2))
    } catch (e) {
      console.error('Error:', e.message)
      process.exit(1)
    }
  })

program.parse()
