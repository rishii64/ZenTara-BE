const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/suppliers
router.get('/', authenticateToken, async (req, res) => {
  try {
    const suppliers = await db.query(`
      SELECT s.*, COUNT(p.id)::int as purchase_count
      FROM suppliers s
      LEFT JOIN purchases p ON p.supplier_id = s.id
      GROUP BY s.id
      ORDER BY s.name ASC
    `);
    res.json(suppliers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/suppliers/:id
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const supplier = await db.queryOne('SELECT * FROM suppliers WHERE id = ?', [req.params.id]);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found.' });

    const purchases = await db.query(`
      SELECT id, purchase_number, supplier_invoice_no, purchase_date, total_amount, created_at
      FROM purchases
      WHERE supplier_id = ?
      ORDER BY purchase_date DESC
    `, [req.params.id]);

    res.json({ ...supplier, purchases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/suppliers
router.post('/', authenticateToken, requireRole('Admin', 'Inventory Staff'), async (req, res) => {
  const { name, contact_person, phone, email, address, gstin } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Supplier name is required.' });
  }

  try {
    const result = await db.execute(`
      INSERT INTO suppliers (name, contact_person, phone, email, address, gstin)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      name.trim(),
      contact_person ? contact_person.trim() : null,
      phone ? phone.trim() : null,
      email ? email.trim() : null,
      address ? address.trim() : null,
      gstin ? gstin.trim().toUpperCase() : null
    ]);

    const supplier = await db.queryOne('SELECT * FROM suppliers WHERE id = ?', [result.lastInsertRowid]);
    res.status(201).json(supplier);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/suppliers/:id
router.put('/:id', authenticateToken, requireRole('Admin', 'Inventory Staff'), async (req, res) => {
  const { id } = req.params;
  const { name, contact_person, phone, email, address, gstin } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Supplier name is required.' });
  }

  try {
    await db.execute(`
      UPDATE suppliers
      SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?, gstin = ?
      WHERE id = ?
    `, [
      name.trim(),
      contact_person ? contact_person.trim() : null,
      phone ? phone.trim() : null,
      email ? email.trim() : null,
      address ? address.trim() : null,
      gstin ? gstin.trim().toUpperCase() : null,
      id
    ]);

    const updated = await db.queryOne('SELECT * FROM suppliers WHERE id = ?', [id]);
    if (!updated) return res.status(404).json({ error: 'Supplier not found.' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/suppliers/:id
router.delete('/:id', authenticateToken, requireRole('Admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const linkedRes = await db.queryOne('SELECT COUNT(*) as count FROM purchases WHERE supplier_id = ?', [id]);
    const linked = parseInt(linkedRes?.count || 0, 10);
    if (linked > 0) {
      return res.status(400).json({ error: `Cannot delete supplier because it has ${linked} purchase transactions.` });
    }

    await db.execute('DELETE FROM suppliers WHERE id = ?', [id]);
    res.json({ message: 'Supplier deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
