import { expect, it } from 'vitest';
import { disableAutocorrect } from './noAutocorrect';

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
