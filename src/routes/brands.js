const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/brands
router.get('/', authenticateToken, async (req, res) => {
  try {
    const brands = await db.query(`
      SELECT b.*, COUNT(p.id)::int as product_count
      FROM brands b
      LEFT JOIN products p ON p.brand_id = b.id
      GROUP BY b.id
      ORDER BY b.name ASC
    `);
    res.json(brands);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/brands
router.post('/', authenticateToken, requireRole('Admin', 'Inventory Staff'), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Brand name is required.' });
  }

  try {
    const result = await db.execute('INSERT INTO brands (name) VALUES (?)', [name.trim()]);
    const brand = await db.queryOne('SELECT * FROM brands WHERE id = ?', [result.lastInsertRowid]);
    res.status(201).json(brand);
  } catch (err) {
    if (err.message && (err.message.includes('unique') || err.message.includes('UNIQUE'))) {
      return res.status(400).json({ error: 'Brand already exists.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/brands/:id
router.delete('/:id', authenticateToken, requireRole('Admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const linkedRes = await db.queryOne('SELECT COUNT(*) as count FROM products WHERE brand_id = ?', [id]);
    const linked = parseInt(linkedRes?.count || 0, 10);
    if (linked > 0) {
      return res.status(400).json({ error: `Cannot delete brand because it has ${linked} linked products.` });
    }

    await db.execute('DELETE FROM brands WHERE id = ?', [id]);
    res.json({ message: 'Brand deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
