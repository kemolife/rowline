import { expect, it } from 'vitest';
import { disableAutocorrect } from './noAutocorrect';

const tick = () => new Promise((r) => setTimeout(r, 0));

it('a focused field gets no spelling correction, also one added later', () => {
  const stop = disableAutocorrect();
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  expect(input.spellcheck).toBe(false);
  expect(input.getAttribute('autocorrect')).toBe('off');
  expect(input.getAttribute('autocapitalize')).toBe('off');
  expect(input.getAttribute('autocomplete')).toBe('off');

  const area = document.createElement('textarea');
  area.setAttribute('autocomplete', 'on');
  document.body.append(area);
  area.focus();
  expect(area.getAttribute('autocorrect')).toBe('off');
  expect(area.getAttribute('autocomplete')).toBe('on');
  stop();
  input.remove();
  area.remove();
});

it('fields get the attributes when added, before any focus; checkboxes are left alone', async () => {
  const before = document.createElement('input');
  document.body.append(before);
  const stop = disableAutocorrect();
  expect(before.getAttribute('autocorrect')).toBe('off');

  const box = document.createElement('div');
  box.innerHTML = '<label><input placeholder="Filter tables"></label><input type="checkbox">';
  document.body.append(box);
  await tick();
  const [search, check] = box.querySelectorAll('input');
  expect(search.getAttribute('autocorrect')).toBe('off');
  expect(search.spellcheck).toBe(false);
  expect(check.hasAttribute('autocorrect')).toBe(false);
  stop();
  before.remove();
  box.remove();
});
