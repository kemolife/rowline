-- Test data for Rowline's Postgres tests. Test-only passwords.
CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE public.customers (
  id serial PRIMARY KEY,
  name text,
  email text UNIQUE,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public."Orders" (
  id bigserial PRIMARY KEY,
  customer_id int REFERENCES public.customers(id),
  total numeric(12,2),
  meta jsonb,
  tags text[],
  token uuid,
  raw bytea
);

CREATE TABLE billing.invoices (
  id int PRIMARY KEY,
  order_id bigint REFERENCES public."Orders"(id),
  due date
);

CREATE TABLE public.audit_log (
  at timestamptz,
  msg text
);

INSERT INTO public.customers (name, email)
SELECT 'Customer ' || g, 'c' || g || '@example.com' FROM generate_series(1, 20) g;

INSERT INTO public."Orders" (customer_id, total, meta, tags, token, raw)
SELECT g, g * 10.50, jsonb_build_object('n', g, 'ok', g % 2 = 0), ARRAY['t' || g, 'x'],
       gen_random_uuid(), decode(lpad(to_hex(g), 4, '0'), 'hex')
FROM generate_series(1, 20) g;

INSERT INTO billing.invoices (id, order_id, due)
SELECT g, g, current_date + g FROM generate_series(1, 20) g;

INSERT INTO public.audit_log (at, msg)
SELECT now() - (g || ' minutes')::interval, 'event ' || g FROM generate_series(1, 20) g;

CREATE VIEW public.big_orders AS
  SELECT * FROM public."Orders" WHERE total > 100;

CREATE ROLE reader LOGIN PASSWORD 'reader_pw';
GRANT USAGE ON SCHEMA public, billing TO reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public, billing TO reader;
