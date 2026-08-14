'use strict';
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

function openDatabase(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_nonces (
      wallet TEXT PRIMARY KEY,
      nonce TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commissions (
      address TEXT PRIMARY KEY,
      creator TEXT NOT NULL,
      tx_signature TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
      description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 10000),
      repository_url TEXT,
      license TEXT NOT NULL CHECK(length(license) BETWEEN 1 AND 64),
      labels_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS commissions_created_at ON commissions(created_at DESC);

    -- What an agent actually delivered.
    --
    -- The program stores a 32-byte SHA-256 commitment and never the content, so
    -- a creator could be handed finished work and have nothing to look at but a
    -- hash. This table holds the preimage of that commitment.
    --
    -- It is an index, never an authority: a row is only accepted if it hashes to
    -- the commitment already on chain, so the chain still decides what was
    -- committed and when. A lost or hostile database cannot invent a delivery,
    -- only fail to show one.
    --
    -- Keyed by the hash rather than the milestone, so a rejected delivery and
    -- the revision that followed it are both kept. Review history is evidence.
    CREATE TABLE IF NOT EXISTS deliveries (
      commission TEXT NOT NULL,
      milestone_index INTEGER NOT NULL CHECK(milestone_index BETWEEN 0 AND 7),
      evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64),
      evidence TEXT NOT NULL CHECK(length(evidence) BETWEEN 1 AND 4000),
      agent TEXT NOT NULL,
      submitted_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (commission, evidence_hash)
    );
    CREATE INDEX IF NOT EXISTS deliveries_commission ON deliveries(commission, submitted_at DESC);
  `);
  return db;
}
module.exports = { openDatabase };
