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
  `);
  return db;
}
module.exports = { openDatabase };
