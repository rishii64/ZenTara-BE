const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db/database');
const { JWT_SECRET, authenticateToken, requireRole } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const user = await db.queryOne('SELECT * FROM users WHERE username = ?', [username.trim()]);

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Account is deactivated. Contact Administrator.' });
    }

    const match = bcrypt.compareSync(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role
      }
    });
  } catch (err) {
    console.error('[Login Error]', err);
    res.status(500).json({ error: err.message || 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// GET /api/auth/users (Admin only)
router.get('/users', authenticateToken, requireRole('Admin'), async (req, res) => {
  try {
    const users = await db.query(`
      SELECT id, username, full_name, role, status, created_at
      FROM users
      ORDER BY id ASC
    `);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/users (Admin only)
router.post('/users', authenticateToken, requireRole('Admin'), async (req, res) => {
  const { username, password, full_name, role } = req.body;

  if (!username || !password || !full_name || !role) {
    return res.status(400).json({ error: 'All fields (username, password, full_name, role) are required.' });
  }

  const validRoles = ['Admin', 'Store Manager', 'Inventory Staff', 'Cashier'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
  }

  try {
    const existing = await db.queryOne('SELECT id FROM users WHERE username = ?', [username.trim()]);
    if (existing) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);

    const result = await db.execute(
      `INSERT INTO users (username, password_hash, full_name, role, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [username.trim(), hash, full_name.trim(), role]
    );

    const newUser = await db.queryOne(
      'SELECT id, username, full_name, role, status, created_at FROM users WHERE id = ?',
      [result.lastInsertRowid]
    );
    res.status(201).json(newUser);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/users/:id (Admin only)
router.put('/users/:id', authenticateToken, requireRole('Admin'), async (req, res) => {
  const { id } = req.params;
  const { full_name, role, status, password } = req.body;

  try {
    const user = await db.queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const validRoles = ['Admin', 'Store Manager', 'Inventory Staff', 'Cashier'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
    }

    const validStatus = ['active', 'inactive'];
    if (status && !validStatus.includes(status)) {
      return res.status(400).json({ error: `Status must be active or inactive.` });
    }

    if (password && password.trim().length > 0) {
      const salt = bcrypt.genSaltSync(10);
      const hash = bcrypt.hashSync(password, salt);
      await db.execute(
        `UPDATE users
         SET full_name = COALESCE(?, full_name),
             role = COALESCE(?, role),
             status = COALESCE(?, status),
             password_hash = ?
         WHERE id = ?`,
        [full_name, role, status, hash, id]
      );
    } else {
      await db.execute(
        `UPDATE users
         SET full_name = COALESCE(?, full_name),
             role = COALESCE(?, role),
             status = COALESCE(?, status)
         WHERE id = ?`,
        [full_name, role, status, id]
      );
    }

    const updated = await db.queryOne(
      'SELECT id, username, full_name, role, status, created_at FROM users WHERE id = ?',
      [id]
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
