require('dotenv').config();

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

if (!process.env.JWT_SECRET ||
    process.env.JWT_SECRET.startsWith('replace_') ||
    !process.env.ADMIN_KEY ||
    process.env.ADMIN_KEY.startsWith('replace_')) {
  throw new Error('Set strong JWT_SECRET and ADMIN_KEY values in your .env file first.');
}

const app = express();
const dataDir = path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'soulfire.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

app.use(express.json({ limit: '30kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// DATABASE

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  ff_uid TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  coins INTEGER NOT NULL DEFAULT 0 CHECK(coins >= 0),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  game TEXT DEFAULT 'Free Fire',
  mode TEXT DEFAULT 'Squad',
  entry_coins INTEGER NOT NULL DEFAULT 0,
  prize TEXT DEFAULT 'SOUL COINS',
  match_time TEXT NOT NULL,
  status TEXT DEFAULT 'upcoming',
  max_players INTEGER DEFAULT 48,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  tournament_id INTEGER NOT NULL,
  team_name TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(player_id, tournament_id),
  FOREIGN KEY(player_id) REFERENCES players(id),
  FOREIGN KEY(tournament_id) REFERENCES tournaments(id)
);

CREATE TABLE IF NOT EXISTS coin_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  points INTEGER DEFAULT 0,
  position INTEGER DEFAULT 0
);


CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT 'My UPI',
  upi_id TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallet_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  request_type TEXT NOT NULL CHECK(request_type IN ('deposit','withdrawal')),
  amount_inr INTEGER NOT NULL,
  coins INTEGER NOT NULL,
  upi_id TEXT NOT NULL DEFAULT '',
  utr TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paid')),
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(player_id) REFERENCES players(id)
);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(
    `PRAGMA table_info(${table})`
  ).all().map(c => c.name);

  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// SAFE DATABASE UPDATES

ensureColumn('players', 'avatar', "TEXT NOT NULL DEFAULT '🔥'");

ensureColumn('tournaments', 'gc', "TEXT NOT NULL DEFAULT 'BR Full Map'");
ensureColumn('tournaments', 'registration_open', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('tournaments', 'details', "TEXT NOT NULL DEFAULT ''");
ensureColumn('tournaments', 'prize_coins', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('tournaments', 'room_id', "TEXT NOT NULL DEFAULT ''");
ensureColumn('tournaments', 'room_password', "TEXT NOT NULL DEFAULT ''");

ensureColumn('registrations', 'position', 'INTEGER');
ensureColumn('registrations', 'team_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('registrations', 'member_names', "TEXT NOT NULL DEFAULT ''");
ensureColumn('results', 'reward_coins', 'INTEGER NOT NULL DEFAULT 0');

ensureColumn('tournaments', 'per_kill_coins', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('tournaments', 'max_prize_coins', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('tournaments', 'host_fee_coins', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
CREATE TABLE IF NOT EXISTS match_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  kills INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT '',
  reward_coins INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tournament_id, player_id),
  FOREIGN KEY(tournament_id) REFERENCES tournaments(id),
  FOREIGN KEY(player_id) REFERENCES players(id)
);
`);

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_slot
ON registrations(tournament_id, position)
WHERE position IS NOT NULL
`);

// GC LIST

const GCS = [
  'BR Full Map',
  'LW 1v1 Body',
  'LW 2v2 Body',
  'LW 1v1 Head',
  'LW 2v2 Head',
  'CS 1v1 Body',
  'CS 2v2 Body',
  'CS 3v3 Body',
  'CS 4v4 Body',
  'CS 1v1 Head',
  'CS 2v2 Head',
  'CS 3v3 Head',
  'CS 4v4 Head'
];

const VALID_STATUSES = new Set([
  'upcoming',
  'ongoing',
  'results_pending',
  'completed'
]);

// AUTHENTICATION

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '')
      .replace(/^Bearer\s+/i, '');

    if (!token) throw new Error('Missing token');

    req.player = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Please login first' });
  }
}

function admin(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({
      error: 'Organizer access denied. Check your organizer key.'
    });
  }

  next();
}

function issueToken(playerId) {
  return jwt.sign(
    { id: playerId },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function cleanText(value, max = 200) {
  return typeof value === 'string'
    ? value.trim().slice(0, max)
    : '';
}

function addCoins(playerId, amount, reason) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Coin amount must be a positive integer');
  }

  db.prepare(
    'UPDATE players SET coins = coins + ? WHERE id = ?'
  ).run(amount, playerId);

  db.prepare(`
    INSERT INTO coin_history(player_id, amount, reason)
    VALUES(?,?,?)
  `).run(playerId, amount, reason);
}

// PUBLIC ROUTES

app.get('/api/config', (req, res) => {
  res.json({
    gcs: GCS,
    coin_name: 'SOUL COINS',
    starting_coins: 0,
    whatsapp_number: process.env.WHATSAPP_NUMBER || '919661954073',
    whatsapp_community: 'https://chat.whatsapp.com/FT98fdcWdS21s3SxEk6sQk',
    real_money_enabled: false
  });
});

app.get('/api/announcements', (req, res) => {
  res.json(db.prepare('SELECT id,title,body,created_at FROM announcements ORDER BY id DESC LIMIT 20').all());
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    name: 'SOULFIRE ESPORTS'
  });
});

app.get('/api/tournaments', (req, res) => {
  const { gc, status } = req.query;

  let sql = `
    SELECT id,name,game,mode,gc,entry_coins,prize,
    prize_coins,per_kill_coins,max_prize_coins,host_fee_coins,match_time,status,max_players,
    registration_open,details,created_at
    FROM tournaments
  `;

  const conditions = [];
  const params = [];

  if (gc && GCS.includes(gc)) {
    conditions.push('gc = ?');
    params.push(gc);
  }

  if (status && VALID_STATUSES.has(status)) {
    conditions.push('status = ?');
    params.push(status);
  }

  if (conditions.length) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY match_time ASC, id DESC';

  res.json(db.prepare(sql).all(...params));
});

app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT p.name,
    COALESCE(SUM(r.points),0) AS points,
    MIN(NULLIF(r.position,0)) AS best_position
    FROM results r
    JOIN players p ON p.name = r.player_name
    GROUP BY p.id
    ORDER BY points DESC, best_position ASC
    LIMIT 50
  `).all();

  res.json(rows);
});

// PLAYER ACCOUNT

app.post('/api/register-account', async (req, res) => {
  try {
    const name = cleanText(req.body.name, 60);
    const email = cleanText(req.body.email, 160).toLowerCase();
    const ff_uid = cleanText(String(req.body.ff_uid || ''), 40);
    const password = typeof req.body.password === 'string'
      ? req.body.password : '';

    if (
      !name ||
      !email ||
      !/^\S+@\S+\.\S+$/.test(email) ||
      !ff_uid ||
      password.length < 8
    ) {
      return res.status(400).json({
        error: 'Enter valid details. Password must be 8+ characters.'
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const info = db.prepare(`
      INSERT INTO players(name,email,ff_uid,password,coins)
      VALUES(?,?,?,?,0)
    `).run(name, email, ff_uid, hash);

    res.json({
      token: issueToken(info.lastInsertRowid),
      message: 'Account created',
      coins: 0
    });

  } catch {
    res.status(400).json({
      error: 'Email or Free Fire UID may already be registered'
    });
  }
});

app.post('/api/login', async (req, res) => {
  const email = cleanText(req.body.email, 160).toLowerCase();
  const password = typeof req.body.password === 'string'
    ? req.body.password : '';

  const player = db.prepare(
    'SELECT * FROM players WHERE email = ?'
  ).get(email);

  if (!player || !await bcrypt.compare(password, player.password)) {
    return res.status(401).json({
      error: 'Incorrect email or password'
    });
  }

  res.json({ token: issueToken(player.id) });
});

app.get('/api/me', auth, (req, res) => {
  const player = db.prepare(`
    SELECT id,name,email,ff_uid,coins,avatar,created_at
    FROM players WHERE id = ?
  `).get(req.player.id);

  if (!player) {
    return res.status(404).json({ error: 'Player not found' });
  }

  res.json(player);
});

app.get('/api/history', auth, (req, res) => {
  const history = db.prepare(`
    SELECT amount,reason,created_at
    FROM coin_history
    WHERE player_id = ?
    ORDER BY id DESC LIMIT 200
  `).all(req.player.id);

  res.json(history);
});

// UPI deposits are user-initiated and manually verified by the organizer.
const coinsPerRupee = Math.max(1, Math.min(100, Number(process.env.SOUL_COINS_PER_RUPEE || 1)));
app.post('/api/wallet/topup', auth, (req, res) => { return res.status(403).json({error:'Real-money coin purchases are disabled pending legal and provider approval. Contact the organizer for information.'});
  const amount = Number(req.body.amount_inr);
  const utr = cleanText(req.body.utr, 40).replace(/\s/g, '');
  if (!Number.isInteger(amount) || amount < 10 || amount > 10000 || !/^[A-Za-z0-9-]{8,40}$/.test(utr)) {
    return res.status(400).json({ error: 'Enter an amount between ₹10 and ₹10,000 and a valid UTR/reference number.' });
  }
  if (!process.env.UPI_ID) return res.status(503).json({ error: 'Organizer UPI ID is not configured yet. Ask the organizer to set UPI_ID in .env.' });
  try {
    const coins = amount * coinsPerRupee;
    const info = db.prepare(`INSERT INTO wallet_requests(player_id,request_type,amount_inr,coins,utr) VALUES(?,?,?,?,?)`)
      .run(req.player.id, 'deposit', amount, coins, utr);
    res.json({ message: 'Top-up request submitted. SOUL COINS will be credited only after organizer verifies the UPI payment.', request_id: info.lastInsertRowid, coins_pending: coins });
  } catch (e) { res.status(400).json({ error: 'This UTR/reference may already be used. Check it and try again.' }); }
});

app.get('/api/wallet/requests', auth, (req, res) => {
  res.json(db.prepare(`SELECT id,request_type,amount_inr,coins,upi_id,utr,status,admin_note,created_at FROM wallet_requests WHERE player_id=? ORDER BY id DESC LIMIT 100`).all(req.player.id));
});

app.post('/api/wallet/withdraw', auth, (req, res) => { return res.status(403).json({error:'Cash withdrawals are disabled pending legal and provider approval.'});
  const coins = Number(req.body.coins);
  const upi = cleanText(req.body.upi_id, 120);
  if (!Number.isInteger(coins) || coins < 100 || coins > 1000000 || !/^[\w.\-]{2,256}@[\w]{2,64}$/.test(upi)) return res.status(400).json({ error: 'Minimum withdrawal is 100 SOUL COINS. Enter a valid UPI ID.' });
  try {
    const result = db.transaction(() => {
      const player = db.prepare('SELECT coins FROM players WHERE id=?').get(req.player.id);
      if (!player || player.coins < coins) throw new Error('Not enough SOUL COINS.');
      const amount = Math.floor(coins / coinsPerRupee);
      if (amount < 1) throw new Error('Withdrawal amount is too small.');
      db.prepare('UPDATE players SET coins=coins-? WHERE id=?').run(coins, req.player.id);
      db.prepare('INSERT INTO coin_history(player_id,amount,reason) VALUES(?,?,?)').run(req.player.id, -coins, 'Withdrawal request pending');
      const info = db.prepare(`INSERT INTO wallet_requests(player_id,request_type,amount_inr,coins,upi_id) VALUES(?,'withdrawal',?,?,?)`).run(req.player.id, amount, coins, upi);
      return info.lastInsertRowid;
    })();
    res.json({ message: 'Withdrawal request submitted. Organizer will review and process it manually.', request_id: result });
  } catch (e) { res.status(400).json({ error: e.message || 'Could not submit withdrawal.' }); }
});

app.get('/api/payment-methods', auth, (req, res) => {
  res.json(db.prepare('SELECT id,label,upi_id,created_at FROM payment_methods WHERE player_id=? ORDER BY id DESC').all(req.player.id));
});
app.post('/api/payment-methods', auth, (req, res) => {
  const label = cleanText(req.body.label || 'My UPI', 40);
  const upi = cleanText(req.body.upi_id, 120);
  if (!/^[\w.\-]{2,256}@[\w]{2,64}$/.test(upi)) return res.status(400).json({ error: 'Enter a valid UPI ID, for example name@bank.' });
  const info = db.prepare('INSERT INTO payment_methods(player_id,label,upi_id) VALUES(?,?,?)').run(req.player.id,label,upi);
  res.json({ message: 'UPI payment method saved.', id: info.lastInsertRowid });
});
app.delete('/api/payment-methods/:id', auth, (req, res) => {
  const info = db.prepare('DELETE FROM payment_methods WHERE id=? AND player_id=?').run(req.params.id,req.player.id);
  if (!info.changes) return res.status(404).json({ error: 'Payment method not found.' });
  res.json({ message: 'Payment method removed.' });
});
app.patch('/api/profile/avatar', auth, (req, res) => {
  const allowed = ['🔥','⚡','🎯','🛡️','👑','🐉','💎','🌊','🌪️','🌿','☠️','⭐'];
  const avatar = req.body.avatar;
  if (!allowed.includes(avatar)) return res.status(400).json({ error: 'Choose an available profile avatar.' });
  db.prepare('UPDATE players SET avatar=? WHERE id=?').run(avatar,req.player.id);
  res.json({ message: 'Profile picture updated.', avatar });
});

// Organizer wallet review. Deposits credit coins only after manual UPI verification.
app.get('/api/admin/wallet-requests', admin, (req, res) => {
  res.json(db.prepare(`SELECT w.*,p.name,p.ff_uid,p.email FROM wallet_requests w JOIN players p ON p.id=w.player_id ORDER BY CASE w.status WHEN 'pending' THEN 0 ELSE 1 END,w.id DESC LIMIT 300`).all());
});
app.post('/api/admin/wallet-requests/:id/decision', admin, (req, res) => {
  const decision = req.body.decision;
  const note = cleanText(req.body.note || '', 250);
  if (!['approve','reject','paid'].includes(decision)) return res.status(400).json({ error: 'Invalid wallet decision.' });
  try {
    const result = db.transaction(() => {
      const row = db.prepare('SELECT * FROM wallet_requests WHERE id=?').get(req.params.id);
      if (!row || row.status !== 'pending') throw new Error('Request not found or already processed.');
      if (row.request_type === 'deposit') {
        if (decision === 'approve') {
          addCoins(row.player_id,row.coins,`Verified UPI top-up #${row.id}`);
          db.prepare("UPDATE wallet_requests SET status='approved',admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(note,row.id);
        } else if (decision === 'reject') {
          db.prepare("UPDATE wallet_requests SET status='rejected',admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(note,row.id);
        } else throw new Error('Deposit requests can only be approved or rejected.');
      } else {
        if (decision === 'paid') {
          db.prepare("UPDATE wallet_requests SET status='paid',admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(note,row.id);
        } else if (decision === 'reject') {
          db.prepare('UPDATE players SET coins=coins+? WHERE id=?').run(row.coins,row.player_id);
          db.prepare('INSERT INTO coin_history(player_id,amount,reason) VALUES(?,?,?)').run(row.player_id,row.coins,`Refund: withdrawal request #${row.id} rejected`);
          db.prepare("UPDATE wallet_requests SET status='rejected',admin_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(note,row.id);
        } else throw new Error('Withdrawal requests can only be marked paid or rejected.');
      }
      return row;
    })();
    res.json({ message: result.request_type === 'deposit' ? (decision === 'approve' ? 'Deposit verified and SOUL COINS credited.' : 'Deposit rejected.') : (decision === 'paid' ? 'Withdrawal marked paid. Complete the UPI transfer separately.' : 'Withdrawal rejected and coins refunded.') });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/tournaments/:id/results', (req, res) => {
  const tournament = db.prepare('SELECT gc FROM tournaments WHERE id=?').get(req.params.id);
  if (!tournament) return res.status(404).json({error:'Match not found.'});
  const rows = db.prepare(`SELECT p.name,m.kills,m.outcome,m.reward_coins
    FROM match_results m JOIN players p ON p.id=m.player_id
    WHERE m.tournament_id=? ORDER BY m.reward_coins DESC,m.kills DESC,p.name`).all(req.params.id);
  res.json({gc:tournament.gc,results:rows});
});

// PUBLIC SLOT AVAILABILITY
app.get('/api/tournaments/:id/slots', (req, res) => {
  const tournament = db.prepare('SELECT id,gc,max_players FROM tournaments WHERE id = ?').get(req.params.id);
  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
  const booked = db.prepare('SELECT position FROM registrations WHERE tournament_id = ? AND position IS NOT NULL ORDER BY position').all(tournament.id).map(x => x.position);
  res.json({ tournament_id: tournament.id, gc: tournament.gc, max_players: tournament.max_players, booked, available: Array.from({length: tournament.max_players}, (_, i) => i + 1).filter(n => !booked.includes(n)) });
});

// PLAYER'S REGISTRATIONS
app.get('/api/my-entries', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id AS registration_id, r.position, r.team_name, r.created_at AS registered_at,
      t.id AS tournament_id, t.name, t.gc, t.mode, t.match_time, t.status,
      t.entry_coins, t.room_id, t.room_password
    FROM registrations r JOIN tournaments t ON t.id = r.tournament_id
    WHERE r.player_id = ? ORDER BY t.match_time DESC, r.id DESC
  `).all(req.player.id);
  res.json(rows.map(row => {
    const reveal = Date.parse(row.match_time) - Date.now() <= 6 * 60 * 1000;
    return { ...row, room_id: reveal ? row.room_id : '', room_password: reveal ? row.room_password : '', room_details_visible: reveal && Boolean(row.room_id && row.room_password) };
  }));
});

// TOURNAMENT REGISTRATION

app.post('/api/tournaments/:id/join', auth, (req, res) => {
  try {
    const result = db.transaction(() => {
      const tournament = db.prepare(
        'SELECT * FROM tournaments WHERE id = ?'
      ).get(req.params.id);

      const player = db.prepare(
        'SELECT * FROM players WHERE id = ?'
      ).get(req.player.id);

      if (!tournament) throw new Error('Tournament not found');
      if (!player) throw new Error('Player not found');

      if (
        tournament.status !== 'upcoming' ||
        !tournament.registration_open
      ) {
        throw new Error('Registration is closed');
      }

      if (Date.parse(tournament.match_time) <= Date.now()) {
        throw new Error('Registration has closed');
      }

      const count = db.prepare(`
        SELECT COUNT(*) AS n
        FROM registrations WHERE tournament_id = ?
      `).get(tournament.id).n;

      if (count >= tournament.max_players) {
        throw new Error('Tournament is full');
      }

      const teamName = cleanText(req.body.team_name || '', 80);
      const memberNames = cleanText(req.body.member_names || '', 500);

      const already = db.prepare(`
        SELECT id FROM registrations
        WHERE player_id = ? AND tournament_id = ?
      `).get(player.id, tournament.id);

      if (already) {
        throw new Error('Already registered');
      }

      let position = null;

      if (tournament.gc === 'BR Full Map') {
        position = Number(req.body.position);

        if (
          !Number.isInteger(position) ||
          position < 1 ||
          position > tournament.max_players
        ) {
          throw new Error(
            `Choose a position between 1 and ${tournament.max_players}`
          );
        }

        const taken = db.prepare(`
          SELECT id FROM registrations
          WHERE tournament_id = ? AND position = ?
        `).get(tournament.id, position);

        if (taken) {
          throw new Error('This position is already booked');
        }
      }

      if (
        !Number.isInteger(tournament.entry_coins) ||
        tournament.entry_coins < 0
      ) {
        throw new Error('Invalid entry fee');
      }

      if (player.coins < tournament.entry_coins) {
        throw new Error('Not enough SOUL COINS. Please top up your wallet.');
      }

      db.prepare(`
        UPDATE players SET coins = coins - ? WHERE id = ?
      `).run(tournament.entry_coins, player.id);

      db.prepare(`
        INSERT INTO registrations(player_id,tournament_id,position,team_name,member_names)
        VALUES(?,?,?,?,?)
      `).run(player.id, tournament.id, position, teamName, memberNames);

      if (tournament.entry_coins > 0) {
        db.prepare(`
          INSERT INTO coin_history(player_id,amount,reason)
          VALUES(?,?,?)
        `).run(
          player.id,
          -tournament.entry_coins,
          `Tournament entry: ${tournament.name}`
        );
      }

      return {
        message: 'Successfully registered!',
        tournament_id: tournament.id,
        position,
        coins_remaining: player.coins - tournament.entry_coins,
        refund_policy:
          'Entry coins are not refunded if you do not join the match.'
      };
    })();

    res.json(result);

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PLAYER MATCH DETAILS

app.get('/api/tournaments/:id/my-entry', auth, (req, res) => {
  const entry = db.prepare(`
    SELECT
      r.id AS registration_id,
      r.position,
      r.created_at AS registered_at,
      t.id AS tournament_id,
      t.name,
      t.gc,
      t.mode,
      t.match_time,
      t.status,
      t.entry_coins,
      t.room_id,
      t.room_password
    FROM registrations r
    JOIN tournaments t ON t.id = r.tournament_id
    WHERE r.tournament_id = ? AND r.player_id = ?
  `).get(req.params.id, req.player.id);

  if (!entry) {
    return res.status(404).json({
      error: 'Registration not found'
    });
  }

  const reveal =
    Date.parse(entry.match_time) - Date.now() <= 6 * 60 * 1000;

  const roster = db.prepare(`
    SELECT p.name AS player_name, r.position
    FROM registrations r
    JOIN players p ON p.id = r.player_id
    WHERE r.tournament_id = ?
    ORDER BY r.position IS NULL, r.position ASC, r.id ASC
  `).all(entry.tournament_id);

  res.json({
    ...entry,
    room_id: reveal ? entry.room_id : '',
    room_password: reveal ? entry.room_password : '',
    room_details_visible:
      reveal && Boolean(entry.room_id && entry.room_password),
    roster
  });
});

// ORGANIZER TOURNAMENTS

app.get('/api/admin/tournaments', admin, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM tournaments
    ORDER BY match_time ASC, id DESC
  `).all();

  res.json(rows);
});

app.get('/api/admin/players', admin, (req, res) => {
  res.json(db.prepare('SELECT id,name,email,ff_uid,coins,avatar,created_at FROM players ORDER BY id DESC LIMIT 500').all());
});
app.post('/api/admin/announcements', admin, (req, res) => {
  const title = cleanText(req.body.title, 100);
  const body = cleanText(req.body.body, 2000);
  if (!title || !body) return res.status(400).json({ error: 'Announcement title and message are required.' });
  const info = db.prepare('INSERT INTO announcements(title,body) VALUES(?,?)').run(title,body);
  res.json({ message: 'Announcement published.', id: info.lastInsertRowid });
});

app.get('/api/admin/registrations', admin, (req, res) => {
  const rows = db.prepare(`
    SELECT
      r.id,
      r.position,
      r.team_name,
      r.member_names,
      r.created_at,
      p.name,
      p.ff_uid,
      p.email,
      t.id AS tournament_id,
      t.name AS tournament,
      t.gc,
      t.mode
    FROM registrations r
    JOIN players p ON p.id = r.player_id
    JOIN tournaments t ON t.id = r.tournament_id
    ORDER BY r.id DESC
  `).all();

  res.json(rows);
});

// CREATE TOURNAMENT

app.post('/api/admin/tournaments', admin, (req, res) => {
  const name = cleanText(req.body.name, 100);
  const gc = cleanText(req.body.gc, 100);
  const mode = cleanText(req.body.mode || 'Squad', 40);
  const entry = Number(req.body.entry_coins);
  let prizeCoins = 0;
  let perKillCoins = 0;
  let maxPrizeCoins = 0;
  let hostFeeCoins = 0;
  const max = gc === 'BR Full Map' ? 48 : (Number((gc.match(/([1-4])v[1-4]/i) || [])[1] || 1) * 2);
  const matchTime = req.body.match_time;
  const details = cleanText(req.body.details, 2000);
  if (gc === 'BR Full Map') {
    perKillCoins = Math.max(0, entry - 2);
    hostFeeCoins = 20;
    maxPrizeCoins = Math.max(0, (entry * 48) - hostFeeCoins);
    prizeCoins = maxPrizeCoins;
  } else {
    hostFeeCoins = max * 10;
    prizeCoins = Math.max(0, (entry * 2) - 10); // per winning player
  }

  if (
    !name ||
    !GCS.includes(gc) ||
    !matchTime ||
    !Number.isFinite(Date.parse(matchTime)) ||
    !Number.isInteger(entry) ||
    entry < 0 || entry > 100000 ||
    !Number.isInteger(max) ||
    max < 2 ||
    max > 48
  ) {
    return res.status(400).json({
      error: 'Check tournament name, GC, date, entry coins, prize coins and player limit.'
    });
  }

  const info = db.prepare(`
    INSERT INTO tournaments(
      name,gc,mode,entry_coins,prize,prize_coins,
      per_kill_coins,max_prize_coins,host_fee_coins,
      match_time,max_players,details,
      registration_open,status
    )
    VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,1,'upcoming')
  `).run(
    name,
    gc,
    mode,
    entry,
    'SOUL COINS',
    prizeCoins,
    perKillCoins,
    maxPrizeCoins,
    hostFeeCoins,
    new Date(matchTime).toISOString(),
    max,
    details
  );

  res.json({
    id: info.lastInsertRowid,
    message: gc === 'BR Full Map' ? `BR match scheduled. Per kill ${perKillCoins} coins; max prize ${maxPrizeCoins} coins.` : `Match scheduled. Each winning player receives ${prizeCoins} coins.`
  });
});

// CHANGE TOURNAMENT STATUS

app.patch('/api/admin/tournaments/:id/status', admin, (req, res) => {
  const status = req.body.status;

  if (!VALID_STATUSES.has(status)) {
    return res.status(400).json({
      error: 'Invalid tournament status'
    });
  }

  const info = db.prepare(`
    UPDATE tournaments SET status = ? WHERE id = ?
  `).run(status, req.params.id);

  if (!info.changes) {
    return res.status(404).json({
      error: 'Tournament not found'
    });
  }

  res.json({ message: 'Tournament status updated' });
});

// OPEN / CLOSE REGISTRATION

app.patch('/api/admin/tournaments/:id/registration', admin, (req, res) => {
  const open = req.body.open;

  if (![true, false, 0, 1].includes(open)) {
    return res.status(400).json({
      error: 'Choose open or closed'
    });
  }

  const info = db.prepare(`
    UPDATE tournaments
    SET registration_open = ?
    WHERE id = ?
  `).run(open ? 1 : 0, req.params.id);

  if (!info.changes) {
    return res.status(404).json({
      error: 'Tournament not found'
    });
  }

  res.json({
    message: open ? 'Registration opened' : 'Registration closed'
  });
});

// ORGANIZER ADDS ROOM ID AND PASSWORD

app.patch('/api/admin/tournaments/:id/room', admin, (req, res) => {
  const roomId = cleanText(String(req.body.room_id || ''), 100);
  const roomPassword = cleanText(
    String(req.body.room_password || ''),
    100
  );

  if (!roomId || !roomPassword) {
    return res.status(400).json({
      error: 'Room ID and password are required'
    });
  }

  const info = db.prepare(`
    UPDATE tournaments
    SET room_id = ?, room_password = ?
    WHERE id = ?
  `).run(roomId, roomPassword, req.params.id);

  if (!info.changes) {
    return res.status(404).json({
      error: 'Tournament not found'
    });
  }

  res.json({
    message: 'Room details saved. Players can see them in the final 6 minutes.'
  });
});
// ORGANIZER AWARDS SOUL COINS

app.post('/api/admin/coins', admin, (req, res) => {
  const ff_uid = cleanText(
    String(req.body.ff_uid || ''),
    40
  );

  const amount = Number(req.body.amount);
  const reason = cleanText(req.body.reason, 200);

  if (
    !ff_uid ||
    !Number.isInteger(amount) ||
    amount < 1 ||
    amount > 100000 ||
    !reason
  ) {
    return res.status(400).json({
      error: 'Enter a valid Free Fire UID, amount and reason'
    });
  }

  const player = db.prepare(`
    SELECT id,coins FROM players WHERE ff_uid = ?
  `).get(ff_uid);

  if (!player) {
    return res.status(404).json({
      error: 'Player not found'
    });
  }

  db.transaction(() => {
    addCoins(player.id, amount, reason);
  })();

  res.json({
    message: 'SOUL COINS awarded',
    coins_added: amount,
    new_balance: player.coins + amount
  });
});

// PUBLISH RESULTS AND REWARD WINNERS

app.post('/api/admin/results', admin, (req, res) => {
  const tournamentId = Number(req.body.tournament_id);
  const playerName = cleanText(req.body.player_name, 60);
  const playerUid = cleanText(
    String(req.body.player_ff_uid || ''),
    40
  );

  const points = Number(req.body.points);
  const position = Number(req.body.position);
  const reward = Number(req.body.reward_coins || 0);

  if (
    !Number.isInteger(tournamentId) ||
    tournamentId < 1 ||
    !playerName ||
    !Number.isInteger(points) ||
    points < 0 ||
    !Number.isInteger(position) ||
    position < 1 ||
    !Number.isInteger(reward) ||
    reward < 0 ||
    reward > 100000
  ) {
    return res.status(400).json({
      error: 'Invalid result or reward values'
    });
  }

  const tournament = db.prepare(`
    SELECT id,name FROM tournaments WHERE id = ?
  `).get(tournamentId);

  if (!tournament) {
    return res.status(404).json({
      error: 'Tournament not found'
    });
  }

  let player;

  if (playerUid) {
    player = db.prepare(`
      SELECT id,name,ff_uid FROM players WHERE ff_uid = ?
    `).get(playerUid);
  } else {
    player = db.prepare(`
      SELECT id,name,ff_uid
      FROM players
      WHERE name = ? COLLATE NOCASE
    `).get(playerName);
  }

  if (!player) {
    return res.status(404).json({
      error: 'Player not found. Check player name or Free Fire UID.'
    });
  }

  const registered = db.prepare(`
    SELECT r.id
    FROM registrations r
    WHERE r.player_id = ?
    AND r.tournament_id = ?
  `).get(player.id, tournamentId);

  if (!registered) {
    return res.status(400).json({
      error: 'This player is not registered in this tournament'
    });
  }

  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO results(
          tournament_id,
          player_name,
          points,
          position,
          reward_coins
        )
        VALUES(?,?,?,?,?)
      `).run(
        tournamentId,
        player.name,
        points,
        position,
        reward
      );

      if (reward > 0) {
        addCoins(
          player.id,
          reward,
          `Tournament reward: ${tournament.name}`
        );
      }
    })();

    res.json({
      message: 'Result published and reward credited',
      player: player.name,
      reward_coins: reward
    });

  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

// ADMIN PLAYER SEARCH AND WALLET ADJUSTMENT (virtual wallet only)
app.get('/api/admin/player-search', admin, (req, res) => {
  const q = cleanText(String(req.query.q || ''), 160);
  if (!q) return res.json([]);
  const like = `%${q}%`;
  res.json(db.prepare(`SELECT id,name,email,ff_uid,coins,avatar FROM players
    WHERE email LIKE ? OR ff_uid LIKE ? OR name LIKE ? OR CAST(id AS TEXT)=?
    ORDER BY id DESC LIMIT 30`).all(like, like, like, q));
});

app.post('/api/admin/players/:id/coins', admin, (req, res) => {
  const action = req.body.action;
  const amount = Number(req.body.amount);
  const reason = cleanText(req.body.reason || 'Organizer wallet adjustment', 200);
  if (!['add','remove'].includes(action) || !Number.isInteger(amount) || amount < 1 || amount > 100000) {
    return res.status(400).json({error:'Choose add/remove and enter a valid whole coin amount.'});
  }
  const player = db.prepare('SELECT id,coins,name FROM players WHERE id=?').get(req.params.id);
  if (!player) return res.status(404).json({error:'Player not found.'});
  try {
    db.transaction(() => {
      if (action === 'add') addCoins(player.id, amount, reason);
      else {
        const info = db.prepare('UPDATE players SET coins=coins-? WHERE id=? AND coins>=?').run(amount, player.id, amount);
        if (!info.changes) throw new Error('Player does not have enough coins.');
        db.prepare('INSERT INTO coin_history(player_id,amount,reason) VALUES(?,?,?)').run(player.id, -amount, reason);
      }
    })();
    const balance = db.prepare('SELECT coins FROM players WHERE id=?').get(player.id).coins;
    res.json({message:`${amount} coins ${action==='add'?'added to':'removed from'} ${player.name}.`, balance});
  } catch(e) { res.status(400).json({error:e.message}); }
});

// ADMIN RESULT EDITOR: registered players for a single match
app.get('/api/admin/tournaments/:id/participants', admin, (req, res) => {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id=?').get(req.params.id);
  if (!tournament) return res.status(404).json({error:'Match not found.'});
  const players = db.prepare(`SELECT p.id,p.name,p.email,p.ff_uid,p.coins,r.position,r.team_name,m.kills,m.outcome,m.reward_coins
    FROM registrations r JOIN players p ON p.id=r.player_id
    LEFT JOIN match_results m ON m.player_id=p.id AND m.tournament_id=r.tournament_id
    WHERE r.tournament_id=? ORDER BY COALESCE(r.position,999),p.name`).all(tournament.id);
  const submitted = db.prepare('SELECT COUNT(*) AS n FROM match_results WHERE tournament_id=?').get(tournament.id).n > 0;
  res.json({submitted,tournament:{id:tournament.id,name:tournament.name,gc:tournament.gc,entry_coins:tournament.entry_coins,prize_coins:tournament.prize_coins,per_kill_coins:tournament.per_kill_coins,max_prize_coins:tournament.max_prize_coins,host_fee_coins:tournament.host_fee_coins,max_players:tournament.max_players},players});
});

app.post('/api/admin/tournaments/:id/submit-results', admin, (req, res) => {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id=?').get(req.params.id);
  if (!tournament) return res.status(404).json({error:'Match not found.'});
  const players = db.prepare('SELECT p.id,p.name FROM registrations r JOIN players p ON p.id=r.player_id WHERE r.tournament_id=? ORDER BY p.id').all(tournament.id);
  const submitted = Array.isArray(req.body.results) ? req.body.results : [];
  if (!players.length || submitted.length !== players.length) return res.status(400).json({error:'Select a result for every registered player before submitting.'});
  const byId = new Map(submitted.map(x => [Number(x.player_id), x]));
  if (players.some(p => !byId.has(p.id))) return res.status(400).json({error:'Every registered player must be included.'});
  const isBR = tournament.gc === 'BR Full Map';
  let rewards = new Map();
  if (isBR) {
    let totalRaw = 0;
    const raw = new Map();
    for (const p of players) {
      const kills = Number(byId.get(p.id).kills);
      if (!Number.isInteger(kills) || kills < 0 || kills > 48) return res.status(400).json({error:'Kills must be between 0 and 48.'});
      const value = kills * Number(tournament.per_kill_coins || Math.max(0,tournament.entry_coins-2));
      raw.set(p.id, value); totalRaw += value;
    }
    const cap = Number(tournament.max_prize_coins || Math.max(0,tournament.entry_coins*48-20));
    if (totalRaw <= cap) rewards = raw;
    else if (totalRaw > 0 && cap > 0) {
      const scaled = players.map(p => ({id:p.id, exact:raw.get(p.id)*cap/totalRaw}));
      let used = 0;
      for (const x of scaled) { x.value=Math.floor(x.exact); used+=x.value; }
      scaled.sort((a,b)=>(b.exact-b.value)-(a.exact-a.value));
      for (let i=0;i<cap-used;i++) scaled[i % scaled.length].value++;
      rewards = new Map(scaled.map(x=>[x.id,x.value]));
    } else rewards = new Map(players.map(p=>[p.id,0]));
  } else {
    const winners = [];
    const losers = [];
    for (const p of players) {
      const outcome = byId.get(p.id).outcome;
      if (outcome === 'win') winners.push(p);
      else if (outcome === 'lose') losers.push(p);
      else return res.status(400).json({error:'Select Win or Lose for every player.'});
    }
    if (players.length < 2 || winners.length !== players.length/2) return res.status(400).json({error:'Winner count must be exactly half of the registered players.'});
    const prizeEach = Math.max(0, Number(tournament.prize_coins || (tournament.entry_coins*2-10)));
    rewards = new Map(players.map(p=>[p.id,winners.some(w=>w.id===p.id)?prizeEach:0]));
  }
  try {
    db.transaction(() => {
      const existing = db.prepare('SELECT COUNT(*) AS n FROM match_results WHERE tournament_id=?').get(tournament.id).n;
      if (existing) throw new Error('Results have already been submitted for this match.');
      for (const p of players) {
        const data = byId.get(p.id);
        const kills = isBR ? Number(data.kills) : 0;
        const outcome = isBR ? '' : String(data.outcome);
        const reward = Number(rewards.get(p.id) || 0);
        db.prepare('INSERT INTO match_results(tournament_id,player_id,kills,outcome,reward_coins) VALUES(?,?,?,?,?)').run(tournament.id,p.id,kills,outcome,reward);
        db.prepare('INSERT INTO results(tournament_id,player_name,points,position,reward_coins) VALUES(?,?,?,?,?)').run(tournament.id,p.name,isBR?kills:(outcome==='win'?1:0),0,reward);
        if (reward > 0) addCoins(p.id,reward,`${isBR?'BR kill reward':'Match winner reward'}: ${tournament.name}`);
      }
      db.prepare("UPDATE tournaments SET status='completed' WHERE id=?").run(tournament.id);
    })();
    const totalPaid = [...rewards.values()].reduce((a,b)=>a+b,0);
    res.json({message:`Results submitted. ${players.length} players processed; ${totalPaid} virtual SOUL COINS credited.`,total_reward:totalPaid,results:players.map(p=>({player_id:p.id,name:p.name,kills:isBR?Number(byId.get(p.id).kills):null,outcome:isBR?'':byId.get(p.id).outcome,reward_coins:rewards.get(p.id)||0}))});
  } catch(e) { res.status(400).json({error:e.message}); }
});

// ERROR HANDLING

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: 'Internal server error'
  });
});

// START SERVER

const port = Number(process.env.PORT || 3000);

app.listen(port, '0.0.0.0', () => {
  console.log(
    'SOULFIRE ESPORTS running on port ' + port
  );
});