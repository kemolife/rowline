import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import ChatItems from './ChatItems';

it('renders images as alt text and links as plain text', () => {
  const html = renderToStaticMarkup(
    <ChatItems items={[{ type: 'assistant', id: '1', text: '![x](https://e.com/a.png) and [y](https://e.com)', streaming: false }]} onAnswer={() => {}} />,
  );
  expect(html).not.toMatch(/<a[\s>]/);
  expect(html).not.toMatch(/<img[\s>/]/);
  expect(html).not.toContain('https://e.com');
  // the image becomes its alt text, the link keeps only its label
  expect(html).toContain('<p><span>x</span> and <span class="underline decoration-dotted">y</span></p>');
});
