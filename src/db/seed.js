const bcrypt = require('bcryptjs');
const { db, initSchema } = require('./database');

async function seedDatabase(options = {}) {
  await initSchema();

  const userCountRes = await db.queryOne('SELECT COUNT(*) as count FROM users');
  const userCount = parseInt(userCountRes.count, 10);

  if (userCount > 0 && !options.force) {
    console.log('[Seed] Database already contains data. Use --force to reset and re-seed demo data.');
    return;
  }

  console.log('[Seed] Seeding initial data for ZENTARA Retail Billing & Inventory...');

  if (options.force) {
    console.log('[Seed] Cleaning existing tables for clean seed...');
    await db.execute('TRUNCATE return_items, returns, sale_items, sales, stock_ledger, purchase_items, purchases, product_variants, products, suppliers, brands, categories, users, store_settings RESTART IDENTITY CASCADE');
  }

  // 1. Seed Store Settings
  const defaultSettings = [
    ['store_name', 'ZENTARA'],
    ['tagline', 'Premium Retail Garment & Fashion Flagship'],
    ['address_line1', '42, Commercial Boulevard, Fashion Avenue'],
    ['city_state_zip', 'Bengaluru, Karnataka - 560001'],
    ['phone', '+91 98765 43210'],
    ['email', 'billing@zentelex.com'],
    ['gstin', '29AABCG1234M1Z2'],
    ['currency_symbol', '₹'],
    ['receipt_footer', 'Thank you for shopping at ZENTARA! Exchanges within 7 days for unused garments with tags intact and original invoice.'],
    ['default_gst_rate', '5.0'],
    ['reorder_threshold', '5']
  ];

  for (const [k, v] of defaultSettings) {
    await db.execute(
      'INSERT INTO store_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [k, v]
    );
  }

  // 2. Seed Users
  const salt = bcrypt.genSaltSync(10);
  const users = [
    ['admin', bcrypt.hashSync('admin123', salt), 'Rajesh Verma (Admin)', 'Admin', 'active'],
    ['manager', bcrypt.hashSync('manager123', salt), 'Priya Sharma (Store Manager)', 'Store Manager', 'active'],
    ['inventory', bcrypt.hashSync('inventory123', salt), 'Arun Kumar (Inventory Head)', 'Inventory Staff', 'active'],
    ['cashier', bcrypt.hashSync('cashier123', salt), 'Sneha Patel (Cashier)', 'Cashier', 'active']
  ];

  for (const u of users) {
    await db.execute(
      `INSERT INTO users (username, password_hash, full_name, role, status)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (username) DO NOTHING`,
      u
    );
  }

  // 3. Seed Categories
  const categories = [
    ["Men's Formal", 'Formal shirts, trousers, blazers & formal waistcoats'],
    ["Men's Casual", 'Casual shirts, t-shirts, polos, chinos & cargo pants'],
    ["Women's Ethnic", 'Kurtas, anarkalis, sarees, lehengas & dupattas'],
    ["Women's Western", 'Tops, dresses, trousers, skirts & jackets'],
    ['Denim & Jeans', 'Stretch jeans, regular fit, skinny & distressed denims'],
    ['Kids & Juniors', 'Boys and girls apparel, festive wear & daily cottons']
  ];

  for (const c of categories) {
    await db.execute(
      'INSERT INTO categories (name, description) VALUES (?, ?) ON CONFLICT (name) DO NOTHING',
      c
    );
  }

  // 4. Seed Brands
  const brands = [
    'Raymond',
    'Allen Solly',
    'Peter England',
    'Van Heusen',
    "Levi's",
    'Biba',
    'Manyavar',
    'Zara Classics'
  ];

  for (const b of brands) {
    await db.execute('INSERT INTO brands (name) VALUES (?) ON CONFLICT (name) DO NOTHING', [b]);
  }

  // 5. Seed Suppliers
  const suppliers = [
    ['Arvind Mills Textile Hub', 'Sanjay Shah', '+91 98250 11223', 'orders@arvindmills.example.com', 'Naroda Road, Ahmedabad, Gujarat', '24AAACA1234A1Z1'],
    ['Vardhman Apparel Logistics', 'Vikram Mehra', '+91 98140 33445', 'sales@vardhman.example.com', 'Chandigarh Road, Ludhiana, Punjab', '03AABCV5678B1Z2'],
    ['Raymond Apparel Wholesalers', 'Deepak Joshi', '+91 99300 77889', 'dispatch@raymondtextiles.example.com', 'Thane West, Mumbai, Maharashtra', '27AABCR9988C1Z3']
  ];

  for (const s of suppliers) {
    await db.execute(
      `INSERT INTO suppliers (name, contact_person, phone, email, address, gstin)
       VALUES (?, ?, ?, ?, ?, ?)`,
      s
    );
  }

  // 6. Seed Products & Variants
  const productsData = [
    {
      name: 'Raymond Classic Formal Shirt',
      category: "Men's Formal",
      brand: 'Raymond',
      hsn: '6205',
      gst: 5.0,
      desc: '100% Giza Cotton Formal Shirt with structured collar',
      variants: [
        ['39 (M)', 'Navy Blue', 'RAY-SHIRT-M-NAVY', '8901001001', 850.0, 1899.0, 1599.0, 24, 0, 5],
        ['40 (L)', 'Navy Blue', 'RAY-SHIRT-L-NAVY', '8901001002', 850.0, 1899.0, 1599.0, 18, 0, 5],
        ['42 (XL)', 'Sky Blue', 'RAY-SHIRT-XL-SKY', '8901001003', 850.0, 1899.0, 1599.0, 12, 1, 5],
        ['39 (M)', 'Pure White', 'RAY-SHIRT-M-WHT', '8901001004', 850.0, 1899.0, 1599.0, 4, 0, 6]
      ]
    },
    {
      name: 'Allen Solly Smart Casual Chinos',
      category: "Men's Casual",
      brand: 'Allen Solly',
      hsn: '6203',
      gst: 12.0,
      desc: 'Stretch cotton blend comfortable casual trousers',
      variants: [
        ['32', 'Khaki Beige', 'AS-CHINO-32-KHK', '8901002001', 950.0, 2499.0, 2199.0, 15, 0, 4],
        ['34', 'Khaki Beige', 'AS-CHINO-34-KHK', '8901002002', 950.0, 2499.0, 2199.0, 20, 0, 4],
        ['32', 'Midnight Black', 'AS-CHINO-32-BLK', '8901002003', 950.0, 2499.0, 2199.0, 14, 0, 4],
        ['34', 'Navy Blue', 'AS-CHINO-34-NAVY', '8901002004', 950.0, 2499.0, 2199.0, 3, 0, 5]
      ]
    },
    {
      name: "Levi's 511 Slim Fit Jeans",
      category: 'Denim & Jeans',
      brand: "Levi's",
      hsn: '6203',
      gst: 12.0,
      desc: 'Original Levi Strauss authentic denim',
      variants: [
        ['30', 'Dark Indigo', 'LEV-511-30-IND', '8901003001', 1400.0, 3599.0, 3199.0, 16, 0, 5],
        ['32', 'Dark Indigo', 'LEV-511-32-IND', '8901003002', 1400.0, 3599.0, 3199.0, 22, 1, 5],
        ['34', 'Faded Blue', 'LEV-511-34-BLU', '8901003003', 1400.0, 3599.0, 3199.0, 10, 0, 5]
      ]
    },
    {
      name: 'Biba Embroidered Anarkali Set',
      category: "Women's Ethnic",
      brand: 'Biba',
      hsn: '6204',
      gst: 5.0,
      desc: 'Gold zari embroidered cotton silk anarkali with dupatta',
      variants: [
        ['M', 'Maroon Red', 'BIBA-ANK-M-RED', '8901004001', 1600.0, 4299.0, 3799.0, 12, 0, 4],
        ['L', 'Maroon Red', 'BIBA-ANK-L-RED', '8901004002', 1600.0, 4299.0, 3799.0, 15, 0, 4],
        ['M', 'Emerald Green', 'BIBA-ANK-M-GRN', '8901004003', 1600.0, 4299.0, 3799.0, 8, 0, 4]
      ]
    },
    {
      name: 'Peter England Cotton Polo T-Shirt',
      category: "Men's Casual",
      brand: 'Peter England',
      hsn: '6109',
      gst: 5.0,
      desc: 'Bio-washed combed cotton pique polo',
      variants: [
        ['M', 'Charcoal Grey', 'PE-POLO-M-GRY', '8901005001', 420.0, 1099.0, 899.0, 30, 0, 6],
        ['L', 'Charcoal Grey', 'PE-POLO-L-GRY', '8901005002', 420.0, 1099.0, 899.0, 25, 0, 6],
        ['XL', 'Crimson Red', 'PE-POLO-XL-RED', '8901005003', 420.0, 1099.0, 899.0, 2, 0, 5]
      ]
    },
    {
      name: 'Manyavar Festive Silk Kurta',
      category: "Women's Ethnic",
      brand: 'Manyavar',
      hsn: '6205',
      gst: 5.0,
      desc: 'Festive celebration silk blend kurta with self jacquard work',
      variants: [
        ['L', 'Golden Yellow', 'MAN-KUR-L-YEL', '8901006001', 1100.0, 2999.0, 2599.0, 14, 0, 4],
        ['XL', 'Royal Beige', 'MAN-KUR-XL-BEI', '8901006002', 1100.0, 2999.0, 2599.0, 9, 0, 4]
      ]
    }
  ];

  for (const p of productsData) {
    const cat = await db.queryOne('SELECT id FROM categories WHERE name = ?', [p.category]);
    const br = await db.queryOne('SELECT id FROM brands WHERE name = ?', [p.brand]);

    const pRes = await db.execute(
      `INSERT INTO products (name, category_id, brand_id, hsn_code, gst_rate, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [p.name, cat?.id || null, br?.id || null, p.hsn, p.gst, p.desc]
    );

    const productId = pRes.lastInsertRowid;

    for (const v of p.variants) {
      const vRes = await db.execute(
        `INSERT INTO product_variants (
          product_id, size, colour, sku, barcode, purchase_price, mrp, selling_price, saleable_stock, damaged_stock, reorder_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (sku) DO NOTHING`,
        [productId, ...v]
      );

      const variantId = vRes.lastInsertRowid;
      if (variantId) {
        await db.execute(
          `INSERT INTO stock_ledger (
            variant_id, transaction_type, reference_id, quantity_change, stock_type, stock_before, stock_after, user_id, notes
          ) VALUES (?, 'INITIAL_OPENING_STOCK', 'INIT-001', ?, 'saleable', 0, ?, 1, 'Opening stock initialization')`,
          [variantId, v[7], v[7]]
        );
      }
    }
  }

  console.log('[Seed] Demo data seeded successfully into PostgreSQL!');
}

module.exports = {
  seedDatabase
};

if (require.main === module) {
  const isForce = process.argv.includes('--force');
  seedDatabase({ force: isForce })
    .then(() => {
      db.pool.end();
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Seed Error]', err);
      db.pool.end();
      process.exit(1);
    });
}
