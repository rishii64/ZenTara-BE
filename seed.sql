-- ============================================================================
-- ZENTARA by ZENTELEX - Demo Seed Data (Optional)
-- Run this AFTER executing schema.sql if you want initial demo retail inventory
-- ============================================================================

BEGIN;

-- 1. Categories
INSERT INTO categories (name, description) VALUES
  ('Men''s Formal', 'Formal shirts, trousers, blazers & formal waistcoats'),
  ('Men''s Casual', 'Casual shirts, t-shirts, polos, chinos & cargo pants'),
  ('Women''s Ethnic', 'Kurtas, anarkalis, sarees, lehengas & dupattas'),
  ('Women''s Western', 'Tops, dresses, trousers, skirts & jackets'),
  ('Denim & Jeans', 'Stretch jeans, regular fit, skinny & distressed denims'),
  ('Kids & Juniors', 'Boys and girls apparel, festive wear & daily cottons')
ON CONFLICT (name) DO NOTHING;

-- 2. Brands
INSERT INTO brands (name) VALUES
  ('Raymond'),
  ('Allen Solly'),
  ('Peter England'),
  ('Van Heusen'),
  ('Levi''s'),
  ('Biba'),
  ('Manyavar'),
  ('Zara Classics')
ON CONFLICT (name) DO NOTHING;

-- 3. Suppliers
INSERT INTO suppliers (name, contact_person, phone, email, address, gstin) VALUES
  ('Arvind Mills Textile Hub', 'Sanjay Shah', '+91 98250 11223', 'orders@arvindmills.example.com', 'Naroda Road, Ahmedabad, Gujarat', '24AAACA1234A1Z1'),
  ('Vardhman Apparel Logistics', 'Vikram Mehra', '+91 98140 33445', 'sales@vardhman.example.com', 'Chandigarh Road, Ludhiana, Punjab', '03AABCV5678B1Z2'),
  ('Raymond Apparel Wholesalers', 'Deepak Joshi', '+91 99300 77889', 'dispatch@raymondtextiles.example.com', 'Thane West, Mumbai, Maharashtra', '27AABCR9988C1Z3')
ON CONFLICT DO NOTHING;

-- 4. Products Master
INSERT INTO products (id, name, category_id, brand_id, hsn_code, gst_rate, description) VALUES
  (1, 'Raymond Classic Formal Shirt', 1, 1, '6205', 5.0, '100% Giza Cotton Formal Shirt with structured collar'),
  (2, 'Allen Solly Smart Casual Chinos', 2, 2, '6203', 12.0, 'Stretch cotton blend comfortable casual trousers'),
  (3, 'Levi''s 511 Slim Fit Jeans', 5, 5, '6203', 12.0, 'Original Levi Strauss authentic denim'),
  (4, 'Biba Embroidered Anarkali Set', 3, 6, '6204', 5.0, 'Gold zari embroidered cotton silk anarkali with dupatta'),
  (5, 'Peter England Cotton Polo T-Shirt', 2, 3, '6109', 5.0, 'Bio-washed combed cotton pique polo'),
  (6, 'Manyavar Festive Silk Kurta', 3, 7, '6205', 5.0, 'Festive celebration silk blend kurta with self jacquard work')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  hsn_code = EXCLUDED.hsn_code,
  gst_rate = EXCLUDED.gst_rate;

SELECT setval('products_id_seq', (SELECT MAX(id) FROM products));

-- 5. Product Variants (SKU, Barcode, Prices, Initial Quantities)
INSERT INTO product_variants (id, product_id, size, colour, sku, barcode, purchase_price, mrp, selling_price, saleable_stock, damaged_stock, reorder_level) VALUES
  -- Raymond Classic Formal Shirt
  (1, 1, '39 (M)', 'Navy Blue', 'RAY-SHIRT-M-NAVY', '8901001001', 850.0, 1899.0, 1599.0, 24, 0, 5),
  (2, 1, '40 (L)', 'Navy Blue', 'RAY-SHIRT-L-NAVY', '8901001002', 850.0, 1899.0, 1599.0, 18, 0, 5),
  (3, 1, '42 (XL)', 'Sky Blue', 'RAY-SHIRT-XL-SKY', '8901001003', 850.0, 1899.0, 1599.0, 12, 1, 5),
  (4, 1, '39 (M)', 'Pure White', 'RAY-SHIRT-M-WHT', '8901001004', 850.0, 1899.0, 1599.0, 4, 0, 6),
  
  -- Allen Solly Smart Casual Chinos
  (5, 2, '32', 'Khaki Beige', 'AS-CHINO-32-KHK', '8901002001', 950.0, 2499.0, 2199.0, 15, 0, 4),
  (6, 2, '34', 'Khaki Beige', 'AS-CHINO-34-KHK', '8901002002', 950.0, 2499.0, 2199.0, 20, 0, 4),
  (7, 2, '32', 'Midnight Black', 'AS-CHINO-32-BLK', '8901002003', 950.0, 2499.0, 2199.0, 14, 0, 4),
  (8, 2, '34', 'Navy Blue', 'AS-CHINO-34-NAVY', '8901002004', 950.0, 2499.0, 2199.0, 3, 0, 5),

  -- Levi's 511 Slim Fit Jeans
  (9, 3, '30', 'Dark Indigo', 'LEV-511-30-IND', '8901003001', 1400.0, 3599.0, 3199.0, 16, 0, 5),
  (10, 3, '32', 'Dark Indigo', 'LEV-511-32-IND', '8901003002', 1400.0, 3599.0, 3199.0, 22, 1, 5),
  (11, 3, '34', 'Faded Blue', 'LEV-511-34-BLU', '8901003003', 1400.0, 3599.0, 3199.0, 10, 0, 5),

  -- Biba Embroidered Anarkali Set
  (12, 4, 'M', 'Maroon Red', 'BIBA-ANK-M-RED', '8901004001', 1600.0, 4299.0, 3799.0, 12, 0, 4),
  (13, 4, 'L', 'Maroon Red', 'BIBA-ANK-L-RED', '8901004002', 1600.0, 4299.0, 3799.0, 15, 0, 4),
  (14, 4, 'M', 'Emerald Green', 'BIBA-ANK-M-GRN', '8901004003', 1600.0, 4299.0, 3799.0, 8, 0, 4),

  -- Peter England Cotton Polo T-Shirt
  (15, 5, 'M', 'Charcoal Grey', 'PE-POLO-M-GRY', '8901005001', 420.0, 1099.0, 899.0, 30, 0, 6),
  (16, 5, 'L', 'Charcoal Grey', 'PE-POLO-L-GRY', '8901005002', 420.0, 1099.0, 899.0, 25, 0, 6),
  (17, 5, 'XL', 'Crimson Red', 'PE-POLO-XL-RED', '8901005003', 420.0, 1099.0, 899.0, 2, 0, 5),

  -- Manyavar Festive Silk Kurta
  (18, 6, 'L', 'Golden Yellow', 'MAN-KUR-L-YEL', '8901006001', 1100.0, 2999.0, 2599.0, 14, 0, 4),
  (19, 6, 'XL', 'Royal Beige', 'MAN-KUR-XL-BEI', '8901006002', 1100.0, 2999.0, 2599.0, 9, 0, 4)
ON CONFLICT (sku) DO NOTHING;

SELECT setval('product_variants_id_seq', (SELECT MAX(id) FROM product_variants));

-- 6. Initial Opening Stock Audit Trail in Stock Ledger
INSERT INTO stock_ledger (variant_id, transaction_type, reference_id, quantity_change, stock_type, stock_before, stock_after, user_id, notes)
SELECT id, 'INITIAL_OPENING_STOCK', 'INIT-001', saleable_stock, 'saleable', 0, saleable_stock, 1, 'Opening stock initialization'
FROM product_variants
WHERE NOT EXISTS (
  SELECT 1 FROM stock_ledger WHERE transaction_type = 'INITIAL_OPENING_STOCK'
);

COMMIT;
