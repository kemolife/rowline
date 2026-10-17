SET SESSION cte_max_recursion_depth = 10000;
CREATE TABLE customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  full_name VARCHAR(120) NOT NULL,
  country CHAR(2) NOT NULL DEFAULT 'NL',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  stock INT NOT NULL DEFAULT 0,
  attributes JSON
);
CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  status ENUM('new','paid','shipped','cancelled') NOT NULL DEFAULT 'new',
  total DECIMAL(10,2) NOT NULL,
  note TEXT,
  ordered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_orders_status (status),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
);
CREATE VIEW active_customers AS SELECT * FROM customers WHERE is_active = 1;

INSERT INTO customers (email, full_name, country, is_active, created_at)
WITH RECURSIVE s(g) AS (SELECT 1 UNION ALL SELECT g+1 FROM s WHERE g<500)
SELECT CONCAT('user',g,'@example.com'), CONCAT('Customer ',g), ELT(1+g%5,'NL','DE','BE','FR','UA'), g%7<>0, NOW()-INTERVAL g DAY FROM s;
INSERT INTO products (sku, name, price, stock, attributes)
WITH RECURSIVE s(g) AS (SELECT 1 UNION ALL SELECT g+1 FROM s WHERE g<200)
SELECT CONCAT('SKU-',LPAD(g,5,'0')), CONCAT('Product ',g), ROUND(RAND()*200+5,2), FLOOR(RAND()*100),
       JSON_OBJECT('color',ELT(1+g%3,'red','blue','green'),'weight_kg',ROUND(RAND()*5,2)) FROM s;
INSERT INTO orders (customer_id, status, total, note, ordered_at)
WITH RECURSIVE s(g) AS (SELECT 1 UNION ALL SELECT g+1 FROM s WHERE g<5000)
SELECT 1+FLOOR(RAND()*499), ELT(1+g%4,'new','paid','shipped','cancelled'), ROUND(RAND()*500+10,2),
       IF(g%10=0,'Leave at the door',NULL), NOW()-INTERVAL FLOOR(RAND()*365) DAY FROM s;
