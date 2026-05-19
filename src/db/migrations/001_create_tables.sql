-- Migration 001: Create products and store_policies tables

CREATE TABLE IF NOT EXISTS products (
    id           SERIAL PRIMARY KEY,
    client_id    VARCHAR(50)     NOT NULL,
    product_id   VARCHAR(50)     NOT NULL,
    name         TEXT            NOT NULL,
    brand        VARCHAR(100),
    type         VARCHAR(100),
    sub_type     VARCHAR(200),
    gender       VARCHAR(20)     DEFAULT 'female',
    price        DECIMAL(10,2),
    old_price    DECIMAL(10,2),
    has_discount BOOLEAN         DEFAULT false,
    discount_pct INTEGER         DEFAULT 0,
    color        TEXT,
    sizes        TEXT,
    materials    TEXT,
    styles       TEXT,
    collection   VARCHAR(200),
    product_url  TEXT,
    image_url    TEXT,
    description  TEXT,
    active       BOOLEAN         DEFAULT true,
    synced_at    TIMESTAMP       DEFAULT NOW(),
    UNIQUE(client_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_products_client_type   ON products(client_id, type);
CREATE INDEX IF NOT EXISTS idx_products_client_brand  ON products(client_id, brand);
CREATE INDEX IF NOT EXISTS idx_products_client_gender ON products(client_id, gender);
CREATE INDEX IF NOT EXISTS idx_products_price         ON products(client_id, price);
CREATE INDEX IF NOT EXISTS idx_products_active        ON products(client_id, active);

CREATE TABLE IF NOT EXISTS store_policies (
    id         SERIAL PRIMARY KEY,
    client_id  VARCHAR(50) NOT NULL,
    topic      VARCHAR(50) NOT NULL,
    content    JSONB       NOT NULL,
    updated_at TIMESTAMP   DEFAULT NOW(),
    UNIQUE(client_id, topic)
);
