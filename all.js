#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');

const args = process.argv.slice(2);
const forceFetch = args.includes('--fetch');
const url = args.find(a => !a.startsWith('-')) || process.env.GRAYLOG_URL;

function runStep(cmd, args, stepName) {
  console.log(`\n=== Running: ${stepName} ===`);
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`Step "${stepName}" failed.`);
    process.exit(result.status);
  }
}

// clean
runStep('npm', ['run', 'clean'], 'clean');

// fetch only if needed
const endpointsFile = 'graylog-swagger-endpoints.json';
const fileExists = fs.existsSync(endpointsFile);

if (forceFetch || !fileExists) {
  if (!url) {
    console.error('Error: No Graylog URL provided for fetch.');
    console.error('Usage: npm run all -- <graylog_base_url> [--fetch]');
    console.error('   or: GRAYLOG_URL=<graylog_base_url> npm run all [--fetch]');
    process.exit(1);
  }
  runStep('node', ['fetch-swagger.js', url], 'fetch');
} else {
  console.log(`Skipping fetch: ${endpointsFile} already exists (use --fetch to force)`);
}

// generate
runStep('npm', ['run', 'generate'], 'generate');

// combine
runStep('npm', ['run', 'combine'], 'combine');

// build-docs
runStep('npm', ['run', 'build-docs'], 'build-docs');

console.log('\n✅ All steps completed successfully!');