'use strict';
// Serves /llms.txt from a template so the addresses an agent reads are the ones
// this server is actually configured with. A hand-maintained copy would go
// stale the first time the program is redeployed, and a stale address in an
// agent-facing manual is a wrong-chain transaction waiting to happen.

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_PATH = path.join(__dirname, 'llms.template.txt');
let cached = null;

function llmsTxt({ cluster, programId, configPda, treasury, rpcUrl, baseUrl, signInDomain }) {
  if (!cached || process.env.NODE_ENV === 'test') cached = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const values = {
    CLUSTER: cluster,
    PROGRAM_ID: programId,
    CONFIG_PDA: configPda,
    TREASURY: treasury,
    RPC_URL: rpcUrl,
    // Configured, never derived from the request. nginx forwards the client's
    // own Host header, so building this from the request would let anyone who
    // can reach the server publish an agent manual instructing agents to POST
    // their transactions at a domain of the attacker's choosing.
    BASE_URL: baseUrl || process.env.PUBLIC_BASE_URL || 'https://gitstarter.xyz',
    // The manual tells agents to reject any sign-in message that does not carry
    // this exact domain, so it has to be the domain the server actually signs
    // with. Hand-written, it was already wrong the day the site moved — and a
    // stale value here trains an agent to refuse the legitimate message.
    SIGN_IN_DOMAIN: signInDomain || process.env.SIGN_IN_DOMAIN || 'gitstarter.xyz',
  };
  return cached.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
}

module.exports = { llmsTxt, TEMPLATE_PATH };
