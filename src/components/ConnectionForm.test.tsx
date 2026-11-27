import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useApp } from '../store/app';
import ConnectionForm from './ConnectionForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('the PostgreSQL card sets its port and user, keeps typed ones, and warns about plain TLS on a remote host', () => {
  useApp.setState({ editing: { id: '', name: '', engine: 'mysql', environment: 'local', host: '127.0.0.1', port: 3306, user: 'root', database: '' } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<ConnectionForm />));

  // the engine cards hold the engine badge (aria-label = engine name)
  const card = (label: string) => host.querySelector(`[aria-label="${label}"]`)!.closest('button')!;
  const field = (label: string) => [...host.querySelectorAll('label')].find((l) => l.querySelector('.label')?.textContent?.startsWith(label))!.querySelector('input')!;
  const type = (input: HTMLInputElement, text: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  expect(card('PostgreSQL')).toBeDefined();
  act(() => card('PostgreSQL').click());
  expect(field('Port').value).toBe('5432');
  expect(field('User').value).toBe('postgres');

  // SQLite and back: the defaults come back
  act(() => card('SQLite').click());
  act(() => card('PostgreSQL').click());
  expect(field('Port').value).toBe('5432');

  // typed values stay when switching engines
  type(field('User'), 'reader');
  type(field('Port'), '6432');
  act(() => card('MySQL').click());
  expect(field('User').value).toBe('reader');
  expect(field('Port').value).toBe('6432');
  act(() => card('PostgreSQL').click());

  type(field('Host'), 'pg.example.com');
  expect(host.querySelector('[data-testid=tls-warning]')).toBeNull(); // new remote connection: Verify by default
  act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Off')!.click());
  expect(host.querySelector('[data-testid=tls-warning]')?.textContent).toMatch(/Not encrypted/);

  act(() => root.unmount());
  host.remove();
});
