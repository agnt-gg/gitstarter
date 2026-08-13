'use strict';
// Serves /llms.txt from a template so the addresses an agent reads are the ones
// this server is actually configured with. A hand-maintained copy would go
// stale the first time the program is redeployed, and a stale address in an
// agent-facing manual is a wrong-chain transaction waiting to happen.

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_PATH = path.join(__dirname, 'llms.template.txt');
let cached = null;

function llmsTxt({ cluster, programId, configPda, treasury, rpcUrl, baseUrl }) {
  if (!cached || process.env.NODE_ENV === 'test') cached = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const values = {
    CLUSTER: cluster,
    PROGRAM_ID: programId,
    CONFIG_PDA: configPda,
    TREASURY: treasury,
    RPC_URL: rpcUrl,
    BASE_URL: baseUrl || process.env.PUBLIC_BASE_URL || 'https://gitstarter.agnt.gg',
  };
  return cached.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
}

module.exports = { llmsTxt, TEMPLATE_PATH };
