#!/usr/bin/env node

/**
 * Retreive Swagger 1.2 API data from a Graylog instance 
 * 
 * Usage:
 *   node fetch-swagger.js <base_url_with_auth> [output_file]
 * 
 * Default output: graylog-swagger-endpoints.js
 */


const fs = require('fs');
const http = require('http');
const https = require('https');

// --- Minimal fetch polyfill for Node < 18 (GET/POST basics) ---
if (typeof fetch === 'undefined') {
  global.fetch = function (url, options = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const client = u.protocol === 'https:' ? https : http;

      const req = client.request(
        u,
        { method: options.method || 'GET', headers: options.headers || {} },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: res.headers,
              text: async () => data,
              json: async () => JSON.parse(data),
            });
          });
        }
      );

      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  };
}

// --- CLI args ---
const baseUrlArg = process.argv[2];
const outputFile = process.argv[3] || 'graylog-swagger-endpoints.json';

if (!baseUrlArg) {
  console.error('Usage: fetch-graylog.js <base_url_with_auth> [output_file]');
  process.exit(1);
}

// --- Helpers ---
const joinUrl = (a, b) => a.replace(/\/$/, '') + '/' + b.replace(/^\//, '');

function parseAuthAndSanitize(baseUrl) {
  const u = new URL(baseUrl);
  const username = decodeURIComponent(u.username || '');
  const password = decodeURIComponent(u.password || '');

  // Build Authorization header if creds present
  const authHeader =
    username || password
      ? 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
      : undefined;

  // Strip credentials from the URL (fetch forbids embedded creds)
  u.username = '';
  u.password = '';

  return { sanitizedBase: u.toString(), authHeader };
}

(async function main() {
  try {
    const { sanitizedBase, authHeader } = parseAuthAndSanitize(baseUrlArg);

    const commonHeaders = { Accept: 'application/json' };
    if (authHeader) commonHeaders.Authorization = authHeader;

    // 1) Fetch the index: base + /api/api-docs
    const indexUrl = new URL('/api/api-docs', sanitizedBase).href.replace(/\/$/, '');
    const idxRes = await fetch(indexUrl, { headers: commonHeaders });
    if (!idxRes.ok) throw new Error(`Index request failed: ${idxRes.status} ${idxRes.statusText}`);
    const indexJson = await idxRes.json();

    const apis = Array.isArray(indexJson?.apis) ? indexJson.apis : [];
    if (!apis.length) {
      fs.writeFileSync(outputFile, '[]\n');
      console.log(`No endpoints found. Wrote empty array to ${outputFile}`);
      return;
    }

    let completed = 0;
    const total = apis.length;
    const tick = (label) => {
      completed += 1;
      process.stdout.write(`\rFetching endpoints: ${completed}/${total} ${label ? `(${label})` : ''}`);
      if (completed === total) process.stdout.write('\n');
    };

    // 2) Fetch each endpoint JSON: sanitizedBase + /api/api-docs + <path>
    const endpointPromises = apis.map(async (entry) => {
      const path = String(entry?.path || '');
      if (!path) throw new Error('Malformed entry without "path" in index JSON.');
      const endpointUrl = joinUrl(indexUrl, path);

      try {
        const res = await fetch(endpointUrl, { headers: commonHeaders });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const obj = await res.json();
        tick(path);
        return obj;
      } catch (e) {
        tick(`${path} ✗`);
        throw new Error(`Failed ${path}: ${e.message || e}`);
      }
    });

    const endpoints = await Promise.all(endpointPromises);

    fs.writeFileSync(outputFile, JSON.stringify(endpoints, null, 2) + '\n');
    console.log(`Saved ${endpoints.length} endpoint objects to ${outputFile}`);
  } catch (err) {
    console.error('\nError:', err.message || err);
    process.exit(1);
  }
})();
