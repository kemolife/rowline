import { expect, it } from 'vitest';
import { defaultTls, isLocalHost, tlsWarning } from './tls';

it('knows local hosts', () => {
  for (const h of ['localhost', '127.0.0.1', '127.0.1.5', '::1', '[::1]', '', 'host.docker.internal', 'db.localhost']) expect(isLocalHost(h), h).toBe(true);
  for (const h of ['db.example.com', '10.0.0.5', 'mydb.abc.eu-west-1.rds.amazonaws.com', '192.168.1.20']) expect(isLocalHost(h), h).toBe(false);
});

it('new remote connections verify the server', () => {
  expect(defaultTls('127.0.0.1')).toBe('off');
  expect(defaultTls('prod.example.com')).toBe('verify');
});

it('warns about plain or unchecked TLS on remote MySQL only', () => {
  expect(tlsWarning({ engine: 'mysql', host: 'prod.example.com', tls: 'off' })).toMatch(/Not encrypted/);
  expect(tlsWarning({ engine: 'mysql', host: 'prod.example.com' })).toMatch(/Not encrypted/);
  expect(tlsWarning({ engine: 'mysql', host: 'prod.example.com', tls: 'required' })).toMatch(/not checked/);
  expect(tlsWarning({ engine: 'mysql', host: 'prod.example.com', tls: 'verify' })).toBeNull();
  expect(tlsWarning({ engine: 'mysql', host: '127.0.0.1', tls: 'off' })).toBeNull();
  expect(tlsWarning({ engine: 'sqlite', host: null, tls: undefined })).toBeNull();
});

it('treats remote Postgres like remote MySQL', () => {
  expect(defaultTls('pg.example.com')).toBe('verify');
  expect(tlsWarning({ engine: 'postgres', host: 'pg.example.com', tls: 'verify' })).toBeNull();
  expect(tlsWarning({ engine: 'postgres', host: 'pg.example.com', tls: 'off' })).toMatch(/Not encrypted/);
  expect(tlsWarning({ engine: 'postgres', host: 'pg.example.com', tls: 'required' })).toMatch(/not checked/);
  expect(tlsWarning({ engine: 'postgres', host: 'localhost', tls: 'off' })).toBeNull();
});
