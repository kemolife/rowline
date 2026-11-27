import { isServer } from './engine';
import type { ConnectionConfig, TlsMode } from './types';

/** Hosts on this machine (or a local Docker): plain TCP never leaves the computer. */
export function isLocalHost(host: string | null | undefined): boolean {
  const h = (host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '' || h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === 'host.docker.internal' || h.endsWith('.localhost') || /^127\./.test(h);
}

/** TLS for a new connection: off on this machine, verified everywhere else. */
export function defaultTls(host: string | null | undefined): TlsMode {
  return isLocalHost(host) ? 'off' : 'verify';
}

/** A short warning when a remote server connection (MySQL, PostgreSQL) is not encrypted or does not check the server; null when fine. */
export function tlsWarning(c: Pick<ConnectionConfig, 'engine' | 'host' | 'tls'>): string | null {
  if (!isServer(c.engine) || isLocalHost(c.host)) return null;
  const mode = c.tls ?? 'off';
  if (mode === 'off') return 'Not encrypted: the password and the data travel as plain text over the network. Use Verify, or an SSH tunnel / VPN.';
  if (mode === 'required') return 'Encrypted, but the server is not checked: someone in the middle could pretend to be it. Use Verify when you can.';
  return null;
}
