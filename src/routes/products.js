const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET /api/products - list all products with their variants
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { category_id, brand_id, search, low_stock } = req.query;

    let query = `
      SELECT 
        p.id,
        p.name,
        p.category_id,
        c.name as category_name,
        p.brand_id,
        b.name as brand_name,
        p.hsn_code,
        p.gst_rate,
        p.description,
        p.created_at,
        COUNT(v.id) as variant_count,
        COALESCE(SUM(v.saleable_stock), 0) as total_saleable_stock,
        COALESCE(SUM(v.damaged_stock), 0) as total_damaged_stock,
        MIN(v.selling_price) as min_selling_price,
        MAX(v.selling_price) as max_selling_price
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN product_variants v ON v.product_id = p.id
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
      query += ` AND (p.name ILIKE ? OR p.hsn_code ILIKE ? OR v.sku ILIKE ? OR v.barcode ILIKE ?)`;
      const term = `%${search.trim()}%`;
      params.push(term, term, term, term);
    }

    query += ` GROUP BY p.id, c.name, b.name ORDER BY p.name ASC`;

    const products = await db.query(query, params);

    // Fetch variants for all products in this result set
    if (products.length === 0) {
      return res.json([]);
    }

    const productIds = products.map(p => p.id);
    const variantsQuery = `
      SELECT * FROM product_variants 
      WHERE product_id = ANY($1) 
      ORDER BY size ASC, colour ASC
    `;
    const allVariants = await db.pool.query(variantsQuery, [productIds]);
    const variantsByProduct = {};
    for (const v of allVariants.rows) {
      if (!variantsByProduct[v.product_id]) {
        variantsByProduct[v.product_id] = [];
      }
      variantsByProduct[v.product_id].push(v);
    }

    const results = products.map(p => {
      let variants = variantsByProduct[p.id] || [];
      if (low_stock === 'true') {
        variants = variants.filter(v => Number(v.saleable_stock) <= Number(v.reorder_level));
      }
      return {
        ...p,
        variants
      };
    });

    if (low_stock === 'true') {
      return res.json(results.filter(p => p.variants.length > 0));
    }

    res.json(results);
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products/variants - flat list of all variants (useful for POS / inventory)
router.get('/variants', authenticateToken, async (req, res) => {
  try {
    const { search, low_stock } = req.query;

    let query = `
      SELECT 
        v.*,
        p.name as product_name,
        p.hsn_code,
        p.gst_rate,
        c.name as category_name,
        b.name as brand_name
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      query += ` AND (v.barcode ILIKE ? OR v.sku ILIKE ? OR p.name ILIKE ? OR v.colour ILIKE ? OR v.size ILIKE ?)`;
      const term = `%${search.trim()}%`;
      params.push(term, term, term, term, term);
    }

    if (low_stock === 'true') {
      query += ` AND v.saleable_stock <= v.reorder_level`;
    }

    query += ` ORDER BY p.name ASC, v.size ASC`;

    const variants = await db.query(query, params);
    res.json(variants);
  } catch (err) {
    console.error('Error fetching variants:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products/lookup/:barcode - fast lookup for POS scanner
router.get('/lookup/:barcode', authenticateToken, async (req, res) => {
  try {
    const barcode = req.params.barcode.trim();
    const variant = await db.queryOne(`
      SELECT 
        v.*,
        p.name as product_name,
        p.hsn_code,
        p.gst_rate,
        c.name as category_name,
        b.name as brand_name
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE v.barcode = ? OR v.sku = ?
    `, [barcode, barcode]);

    if (!variant) {
      return res.status(404).json({ error: `No product variant found matching barcode or SKU: ${barcode}` });
    }

    res.json(variant);
  } catch (err) {
    console.error('Error looking up barcode:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products/:id - single product with variants
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const product = await db.queryOne(`
      SELECT 
        p.*,
        c.name as category_name,
        b.name as brand_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE p.id = ?
    `, [req.params.id]);

    if (!product) return res.status(404).json({ error: 'Product not found.' });

    const variants = await db.query(
      'SELECT * FROM product_variants WHERE product_id = ? ORDER BY id ASC',
      [product.id]
    );
    res.json({ ...product, variants });
  } catch (err) {
    console.error('Error fetching product by id:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/products - Create product with 1 or more variants
router.post('/', authenticateToken, requireRole('Admin', 'Inventory Staff'), async (req, res) => {
  const {
    name,
    category_id,
    brand_id,
    hsn_code = '6109',
    gst_rate = 5.0,
    description,
    variants
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Product name is required.' });
  }

  if (!variants || !Array.isArray(variants) || variants.length === 0) {
    return res.status(400).json({ error: 'At least one variant (size, colour, SKU, barcode, price) is required.' });
  }

  // Pre-validate all variant SKUs and barcodes for uniqueness
  const skuSet = new Set();
  const barcodeSet = new Set();

  for (const v of variants) {
    if (!v.size || !v.colour || !v.sku || !v.barcode) {
      return res.status(400).json({ error: 'Each variant must have size, colour, SKU, and barcode.' });
    }
    const cleanSku = v.sku.trim();
    const cleanBarcode = v.barcode.trim();

    if (skuSet.has(cleanSku)) {
      return res.status(400).json({ error: `Duplicate SKU in request: ${cleanSku}` });
    }
    if (barcodeSet.has(cleanBarcode)) {
      return res.status(400).json({ error: `Duplicate barcode in request: ${cleanBarcode}` });
    }
    skuSet.add(cleanSku);
    barcodeSet.add(cleanBarcode);

    // Check DB for duplicates
    const existingSku = await db.queryOne('SELECT id, sku FROM product_variants WHERE sku = ?', [cleanSku]);
    if (existingSku) {
      return res.status(400).json({ error: `SKU '${cleanSku}' already exists in database.` });
    }

    const existingBarcode = await db.queryOne('SELECT id, barcode FROM product_variants WHERE barcode = ?', [cleanBarcode]);
    if (existingBarcode) {
      return res.status(400).json({ error: `Barcode '${cleanBarcode}' already exists in database.` });
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Insert product
      const prodResult = await tx.execute(`
        INSERT INTO products (name, category_id, brand_id, hsn_code, gst_rate, description)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        name.trim(),
        category_id || null,
        brand_id || null,
        hsn_code ? hsn_code.trim() : '6109',
        Number(gst_rate) || 5.0,
        description ? description.trim() : null
      ]);
      const productId = prodResult.lastInsertRowid;

      for (const v of variants) {
        const initialStock = Number(v.saleable_stock) || 0;
        const vResult = await tx.execute(`
          INSERT INTO product_variants (
            product_id, size, colour, sku, barcode, purchase_price, mrp, selling_price, saleable_stock, damaged_stock, reorder_level
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          productId,
          v.size.trim(),
          v.colour.trim(),
          v.sku.trim(),
          v.barcode.trim(),
          Number(v.purchase_price) || 0,
          Number(v.mrp) || 0,
          Number(v.selling_price) || 0,
          initialStock,
          Number(v.damaged_stock) || 0,
          Number(v.reorder_level) || 5
        ]);

        const variantId = vResult.lastInsertRowid;

        if (initialStock > 0) {
          await tx.execute(`
            INSERT INTO stock_ledger (
              variant_id, transaction_type, reference_id, quantity_change, stock_type, stock_before, stock_after, user_id, notes
            ) VALUES (?, 'INITIAL_PRODUCT_CREATION', ?, ?, 'saleable', 0, ?, ?, 'Initial creation stock')
          `, [
            variantId,
            `PROD-${productId}`,
            initialStock,
            initialStock,
            req.user.id
          ]);
        }
      }

      const created = await tx.queryOne('SELECT * FROM products WHERE id = ?', [productId]);
      const createdVariants = await tx.query('SELECT * FROM product_variants WHERE product_id = ?', [productId]);
      return { ...created, variants: createdVariants };
    });

    res.status(201).json(result);
  } catch (err) {
    console.error('Error creating product:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/products/:id - Update product & manage variants
router.put('/:id', authenticateToken, requireRole('Admin', 'Inventory Staff'), async (req, res) => {
  const { id } = req.params;
  const {
    name,
    category_id,
    brand_id,
    hsn_code,
    gst_rate,
    description,
    variants
  } = req.body;

  const product = await db.queryOne('SELECT * FROM products WHERE id = ?', [id]);
  if (!product) return res.status(404).json({ error: 'Product not found.' });

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(`
        UPDATE products
        SET name = COALESCE(?, name),
            category_id = ?,
            brand_id = ?,
            hsn_code = COALESCE(?, hsn_code),
            gst_rate = COALESCE(?, gst_rate),
            description = ?
        WHERE id = ?
      `, [
        name ? name.trim() : null,
        category_id || null,
        brand_id || null,
        hsn_code ? hsn_code.trim() : null,
        gst_rate !== undefined ? Number(gst_rate) : null,
        description !== undefined ? description : null,
        id
      ]);

      if (variants && Array.isArray(variants)) {
        for (const v of variants) {
          if (v.id) {
            // Check uniqueness for changed SKU/barcode
            const existingSku = await tx.queryOne(
              'SELECT id FROM product_variants WHERE sku = ? AND id != ?',
              [v.sku.trim(), v.id]
            );
            if (existingSku) {
              throw new Error(`SKU '${v.sku}' is used by another variant.`);
            }
            const existingBarcode = await tx.queryOne(
              'SELECT id FROM product_variants WHERE barcode = ? AND id != ?',
              [v.barcode.trim(), v.id]
            );
            if (existingBarcode) {
              throw new Error(`Barcode '${v.barcode}' is used by another variant.`);
            }

            await tx.execute(`
              UPDATE product_variants
              SET size = ?,
                  colour = ?,
                  sku = ?,
                  barcode = ?,
                  purchase_price = ?,
                  mrp = ?,
                  selling_price = ?,
                  reorder_level = ?
              WHERE id = ? AND product_id = ?
            `, [
              v.size.trim(),
              v.colour.trim(),
              v.sku.trim(),
              v.barcode.trim(),
              Number(v.purchase_price) || 0,
              Number(v.mrp) || 0,
              Number(v.selling_price) || 0,
              Number(v.reorder_level) || 5,
              v.id,
              id
            ]);
          } else {
            // New variant for existing product
            const existingSku = await tx.queryOne('SELECT id FROM product_variants WHERE sku = ?', [v.sku.trim()]);
            if (existingSku) throw new Error(`SKU '${v.sku}' already exists.`);

            const existingBarcode = await tx.queryOne('SELECT id FROM product_variants WHERE barcode = ?', [v.barcode.trim()]);
            if (existingBarcode) throw new Error(`Barcode '${v.barcode}' already exists.`);

            await tx.execute(`
              INSERT INTO product_variants (
                product_id, size, colour, sku, barcode, purchase_price, mrp, selling_price, saleable_stock, damaged_stock, reorder_level
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `, [
              id,
              v.size.trim(),
              v.colour.trim(),
              v.sku.trim(),
              v.barcode.trim(),
              Number(v.purchase_price) || 0,
              Number(v.mrp) || 0,
              Number(v.selling_price) || 0,
              Number(v.saleable_stock) || 0,
              Number(v.reorder_level) || 5
            ]);
          }
        }
      }

      const updated = await tx.queryOne('SELECT * FROM products WHERE id = ?', [id]);
      const updatedVariants = await tx.query('SELECT * FROM product_variants WHERE product_id = ?', [id]);
      return { ...updated, variants: updatedVariants };
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/products/:id - Admin only
router.delete('/:id', authenticateToken, requireRole('Admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const product = await db.queryOne('SELECT id, name FROM products WHERE id = ?', [id]);
    if (!product) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    // 1. Check if product has sales history
    const salesRow = await db.queryOne(`
      SELECT COUNT(*) as count 
      FROM sale_items si 
      JOIN product_variants v ON v.id = si.variant_id 
      WHERE v.product_id = ?
    `, [id]);

    if (parseInt(salesRow?.count || 0, 10) > 0) {
      return res.status(400).json({ error: 'Cannot delete product because it has sales history.' });
    }

    // 2. Check if product has supplier purchase inward history
    const purchaseRow = await db.queryOne(`
      SELECT COUNT(*) as count
      FROM purchase_items pi
      JOIN product_variants v ON v.id = pi.variant_id
      WHERE v.product_id = ?
    `, [id]);

    if (parseInt(purchaseRow?.count || 0, 10) > 0) {
      return res.status(400).json({ error: 'Cannot delete product because it has purchase inward history.' });
    }

    // 3. Atomically remove associated stock ledger records and the product (cascades to variants)
    await db.transaction(async (tx) => {
      await tx.execute(`
        DELETE FROM stock_ledger
        WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = ?)
      `, [id]);

      await tx.execute('DELETE FROM products WHERE id = ?', [id]);
    });

    res.json({ message: 'Product deleted successfully.' });
  } catch (err) {
    console.error('Error deleting product:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
