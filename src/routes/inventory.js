const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/inventory - stock inventory table
router.get('/', authenticateToken, async (req, res) => {
  const { category_id, brand_id, search, low_stock, damaged_only } = req.query;

  let query = `
    SELECT 
      v.id as variant_id,
      v.product_id,
      p.name as product_name,
      c.name as category_name,
      b.name as brand_name,
      v.size,
      v.colour,
      v.sku,
      v.barcode,
      v.purchase_price,
      v.mrp,
      v.selling_price,
      v.saleable_stock,
      v.damaged_stock,
      v.reorder_level,
      p.hsn_code,
      p.gst_rate,
      CASE 
        WHEN v.saleable_stock <= 0 THEN 'OUT_OF_STOCK'
        WHEN v.saleable_stock <= v.reorder_level THEN 'LOW_STOCK'
        ELSE 'IN_STOCK'
      END as stock_status
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id
    WHERE 1=1
  `;
  const params = [];

  if (category_id) {
    query += ` AND p.category_id = ?`;
    params.push(category_id);
  }
  if (brand_id) {
    query += ` AND p.brand_id = ?`;
    params.push(brand_id);
  }
  if (search) {
    query += ` AND (p.name ILIKE ? OR v.sku ILIKE ? OR v.barcode ILIKE ? OR v.size ILIKE ? OR v.colour ILIKE ?)`;
    const term = `%${search.trim()}%`;
    params.push(term, term, term, term, term);
  }
  if (low_stock === 'true') {
    query += ` AND v.saleable_stock <= v.reorder_level`;
  }
  if (damaged_only === 'true') {
    query += ` AND v.damaged_stock > 0`;
  }

  query += ` ORDER BY p.name ASC, v.size ASC`;

  try {
    const inventory = await db.query(query, params);
    res.json(inventory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inventory/ledger - stock audit log / inward-outward history
router.get('/ledger', authenticateToken, async (req, res) => {
  const { variant_id, stock_type, transaction_type, limit = 100 } = req.query;

  let query = `
    SELECT 
      sl.*,
      v.sku,
      v.barcode,
      v.size,
      v.colour,
      p.name as product_name,
      u.full_name as performed_by_name,
      u.role as performed_by_role
    FROM stock_ledger sl
    JOIN product_variants v ON v.id = sl.variant_id
    JOIN products p ON p.id = v.product_id
    JOIN users u ON u.id = sl.user_id
    WHERE 1=1
  `;
  const params = [];

  if (variant_id) {
    query += ` AND sl.variant_id = ?`;
    params.push(variant_id);
  }
  if (stock_type) {
    query += ` AND sl.stock_type = ?`;
    params.push(stock_type);
  }
  if (transaction_type) {
    query += ` AND sl.transaction_type = ?`;
    params.push(transaction_type);
  }

  query += ` ORDER BY sl.created_at DESC, sl.id DESC LIMIT ?`;
  params.push(Number(limit) || 100);

  try {
    const logs = await db.query(query, params);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/inventory/adjust - Manual stock adjustment
// Restricted to Admin and Store Manager
router.post('/adjust', authenticateToken, requireRole('Admin', 'Store Manager'), async (req, res) => {
  const { variant_id, stock_type = 'saleable', new_quantity, reason, notes } = req.body;

  if (!variant_id || new_quantity === undefined || new_quantity === null || !reason) {
    return res.status(400).json({ error: 'Variant ID, new quantity, and adjustment reason are required.' });
  }

  const validStockTypes = ['saleable', 'damaged'];
  if (!validStockTypes.includes(stock_type)) {
    return res.status(400).json({ error: 'stock_type must be saleable or damaged.' });
  }

  const targetQty = Number(new_quantity);
  if (isNaN(targetQty) || targetQty < 0) {
    return res.status(400).json({ error: 'New quantity must be a non-negative number.' });
  }

  try {
    const variant = await db.queryOne('SELECT * FROM product_variants WHERE id = ?', [variant_id]);
    if (!variant) {
      return res.status(404).json({ error: 'Product variant not found.' });
    }

    const currentStock = stock_type === 'saleable' ? variant.saleable_stock : variant.damaged_stock;
    const difference = targetQty - currentStock;

    if (difference === 0) {
      return res.status(400).json({ error: 'New quantity is identical to current stock. No adjustment needed.' });
    }

    await db.transaction(async (tx) => {
      if (stock_type === 'saleable') {
        await tx.execute('UPDATE product_variants SET saleable_stock = ? WHERE id = ?', [targetQty, variant_id]);
      } else {
        await tx.execute('UPDATE product_variants SET damaged_stock = ? WHERE id = ?', [targetQty, variant_id]);
      }

      await tx.execute(`
        INSERT INTO stock_ledger (
          variant_id, transaction_type, reference_id, quantity_change, stock_type, stock_before, stock_after, user_id, notes
        ) VALUES (?, 'MANUAL_ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?)
      `, [
        variant_id,
        `ADJ-${Date.now()}`,
        difference,
        stock_type,
        currentStock,
        targetQty,
        req.user.id,
        `Reason: ${reason} | ${notes || ''}`
      ]);
    });

    const updated = await db.queryOne('SELECT * FROM product_variants WHERE id = ?', [variant_id]);
    res.json({ message: 'Stock adjusted successfully.', variant: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
