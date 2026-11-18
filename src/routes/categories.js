const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/categories - all logged in users can view
router.get('/', authenticateToken, async (req, res) => {
  try {
    const categories = await db.query(`
      SELECT c.*, COUNT(p.id)::int as product_count
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id
      GROUP BY c.id
      ORDER BY c.name ASC
    `);
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categories - Admin and Inventory Staff can create
router.post('/', authenticateToken, requireRole('Admin', 'Inventory Staff'), async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Category name is required.' });
  }

  try {
    const result = await db.execute(
      'INSERT INTO categories (name, description) VALUES (?, ?)',
      [name.trim(), description ? description.trim() : null]
    );
    const category = await db.queryOne('SELECT * FROM categories WHERE id = ?', [result.lastInsertRowid]);
    res.status(201).json(category);
  } catch (err) {
    if (err.message && (err.message.includes('unique') || err.message.includes('UNIQUE'))) {
      return res.status(400).json({ error: 'Category with this name already exists.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/categories/:id - Admin and Inventory Staff
router.put('/:id', authenticateToken, requireRole('Admin', 'Inventory Staff'), async (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Category name is required.' });
  }

  try {
    await db.execute(
      'UPDATE categories SET name = ?, description = ? WHERE id = ?',
      [name.trim(), description ? description.trim() : null, id]
    );
    const updated = await db.queryOne('SELECT * FROM categories WHERE id = ?', [id]);
    if (!updated) return res.status(404).json({ error: 'Category not found.' });
    res.json(updated);
  } catch (err) {
    if (err.message && (err.message.includes('unique') || err.message.includes('UNIQUE'))) {
      return res.status(400).json({ error: 'Category with this name already exists.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/categories/:id - Admin only
router.delete('/:id', authenticateToken, requireRole('Admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const linkedRes = await db.queryOne('SELECT COUNT(*) as count FROM products WHERE category_id = ?', [id]);
    const linked = parseInt(linkedRes?.count || 0, 10);
    if (linked > 0) {
      return res.status(400).json({ error: `Cannot delete category because it has ${linked} linked products.` });
    }

    await db.execute('DELETE FROM categories WHERE id = ?', [id]);
    res.json({ message: 'Category deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
