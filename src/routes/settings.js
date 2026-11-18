const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/settings - get all store settings
router.get('/', authenticateToken, async (req, res) => {
  try {
    const rows = await db.query('SELECT key, value FROM store_settings');
    const settings = {};
    rows.forEach(r => {
      settings[r.key] = r.value;
    });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings - update store settings (Admin only)
router.post('/', authenticateToken, requireRole('Admin'), async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Settings object is required.' });
  }

  try {
    await db.transaction(async (tx) => {
      for (const [key, value] of Object.entries(updates)) {
        await tx.execute(
          'INSERT INTO store_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
          [key, String(value)]
        );
      }
    });

    const rows = await db.query('SELECT key, value FROM store_settings');
    const settings = {};
    rows.forEach(r => {
      settings[r.key] = r.value;
    });

    res.json({ message: 'Settings saved successfully.', settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
