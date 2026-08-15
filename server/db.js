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
      -- Signature of the SubmitDelivery transaction, when the submitter
      -- supplied it. The submission ACCOUNT is closed at settlement, but the
      -- transaction that created it is permanent — so this is the anchor that
      -- lets anyone re-verify the evidence text against the committed hash
      -- from a public RPC, forever, without trusting this database.
      submit_signature TEXT,
      PRIMARY KEY (commission, evidence_hash)
    );
    CREATE INDEX IF NOT EXISTS deliveries_commission ON deliveries(commission, submitted_at DESC);

    -- What the chain used to say, kept after it stops saying it.
    --
    -- Submission and intent accounts are closed when a commission settles, so
    -- their deposits go home without anyone being asked. That is right for the
    -- money and wrong for the record: an agent's proof of work disappeared at
    -- the exact moment they earned it, and a reputation lookup reported zero
    -- deliveries for a wallet that had just been paid three times.
    --
    -- These tables are an INDEX, never an authority. Every row is a copy of
    -- something the program said, written only while the account still exists,
    -- and nothing here can create a delivery that never happened: an entry is
    -- only ever reconciled against the commission's own on-chain counters.
    CREATE TABLE IF NOT EXISTS delivery_history (
      commission TEXT NOT NULL,
      milestone_index INTEGER NOT NULL CHECK(milestone_index BETWEEN 0 AND 7),
      agent TEXT NOT NULL,
      -- Position in that milestone's queue, which is what decides who was
      -- judged and in what order once the accounts are gone.
      sequence INTEGER NOT NULL,
      submitted_at INTEGER NOT NULL,
      evidence_hash TEXT NOT NULL,
      -- Last state observed on chain. 'pending' here means the account was
      -- swept before anyone read it again, which the reconciler resolves.
      last_state TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (commission, milestone_index, agent)
    );
    CREATE INDEX IF NOT EXISTS delivery_history_agent ON delivery_history(agent);

    CREATE TABLE IF NOT EXISTS intent_history (
      commission TEXT NOT NULL,
      agent TEXT NOT NULL,
      signalled_at INTEGER NOT NULL,
      withdrawn INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (commission, agent)
    );
    CREATE INDEX IF NOT EXISTS intent_history_agent ON intent_history(agent);

    -- A name a wallet chose for itself.
    --
    -- Purely a label. The wallet is the identity of record everywhere that
    -- matters: every payment, every signature and every reputation figure is
    -- keyed by address, and a handle is never accepted anywhere an address is
    -- expected. It exists because a 44-character base58 string cannot be
    -- recognised, recommended, or remembered.
    --
    -- Only the wallet itself can set one: the route behind this requires a
    -- session proven by signature, so a handle always means "this key said so".
    CREATE TABLE IF NOT EXISTS handles (
      wallet TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      -- Lower-cased form, so uniqueness cannot be dodged with capitals.
      handle_key TEXT NOT NULL UNIQUE,
      bio TEXT NOT NULL DEFAULT '' CHECK(length(bio) <= 280),
      link TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Every name ever held, and by whom.
    --
    -- This is what stops a handle from being inherited. If names could be
    -- recycled, an agent could build a record as "alice", rename, and leave the
    -- name free for somebody else to take and be mistaken for — arriving with a
    -- reputation they did not earn, at the exact moment somebody is deciding
    -- whether to trust them with money. A name is bound to the first wallet
    -- that took it, permanently, even after that wallet abandons it.
    -- Something that happened that a specific wallet needs to know about.
    --
    -- The review clock runs whether or not anybody has the page open. A creator
    -- who is handed finished work and never looks pays out automatically when
    -- the window lapses; an agent whose delivery matured has money sitting there
    -- unclaimed. Both were discoverable only by opening the right dialog and
    -- reading it, which is not a mechanism, it is a hope.
    --
    -- Written by the same scan that already reads the whole board, so a
    -- notification is a state TRANSITION that was actually observed on chain,
    -- never an intention recorded ahead of time.
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT NOT NULL,
      kind TEXT NOT NULL,
      commission TEXT NOT NULL,
      milestone_index INTEGER,
      body TEXT NOT NULL,
      -- Identifies the transition, so re-observing the same board state cannot
      -- tell somebody twice. This is the whole idempotency story.
      dedupe_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS notifications_wallet ON notifications(wallet, read_at, id DESC);

    -- An agent's answer to being refused.
    --
    -- On chain a rejection is final and one-sided: the creator says no, the
    -- queue advances, and nothing records that the agent disagreed. Between
    -- people who know each other that is fine. Between strangers it means a
    -- creator can take delivery, refuse, and carry no cost for it.
    --
    -- This CANNOT move money — the escrow is the program's and stays that way.
    -- What it does is make a refusal answerable in public: a contested rejection
    -- appears on the creator's own profile, where the next agent deciding
    -- whether to spend compute on their bounty will read it.
    CREATE TABLE IF NOT EXISTS disputes (
      commission TEXT NOT NULL,
      milestone_index INTEGER NOT NULL,
      agent TEXT NOT NULL,
      creator TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(length(reason) <= 2000),
      -- The creator's answer, if they give one. Silence is itself a signal and
      -- is displayed as such.
      response TEXT NOT NULL DEFAULT '',
      responded_at INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (commission, milestone_index, agent)
    );
    CREATE INDEX IF NOT EXISTS disputes_creator ON disputes(creator);
    CREATE INDEX IF NOT EXISTS disputes_agent ON disputes(agent);

    CREATE TABLE IF NOT EXISTS handle_claims (
      handle_key TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      claimed_at INTEGER NOT NULL
    );
  `);

  // Databases created before the durable anchor existed lack the column, and
  // SQLite has no ADD COLUMN IF NOT EXISTS — probe, then alter. Existing rows
  // stay NULL until their owner re-posts the text with the signature attached,
  // which the insert path accepts as a backfill.
  const deliveryColumns = db.prepare(`SELECT name FROM pragma_table_info('deliveries')`).all().map(column => column.name);
  if (!deliveryColumns.includes('submit_signature')) db.exec('ALTER TABLE deliveries ADD COLUMN submit_signature TEXT');

  // Recover the deliveries made before this index existed.
  //
  // Their submission accounts have already been swept, so the chain no longer
  // remembers them — but every one of them was recorded here at submission time
  // by an agent proving their evidence against the on-chain commitment. That is
  // the same information, captured earlier.
  //
  // Queue position is not stored, and does not need to be: the program assigns
  // it in order of arrival, so ordering by the timestamp the chain itself
  // reported reproduces it exactly. Nothing is invented, and the outcome is
  // still reconciled against the commission's own counters at read time.
  db.exec(`
    INSERT OR IGNORE INTO delivery_history
      (commission, milestone_index, agent, sequence, submitted_at, evidence_hash, last_state, first_seen, last_seen)
    SELECT commission, milestone_index, agent,
      ROW_NUMBER() OVER (PARTITION BY commission, milestone_index ORDER BY submitted_at, created_at) - 1,
      submitted_at, evidence_hash, 'pending', submitted_at, submitted_at
    FROM deliveries;
  `);
  return db;
}
module.exports = { openDatabase };
