import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import RootLayout, { metadata } from '../app/layout.js';
import Dashboard from '../app/page.js';

describe('RJ POS web foundation', () => {
  it('renders expected application identity and foundation copy', () => {
    const markup = renderToStaticMarkup(<Dashboard />);
    expect(markup).toContain('<h1>RJ POS</h1>');
    expect(markup).toContain('Merchant operations foundation');
  });

  it('renders through the root document shell with English metadata', () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <Dashboard />
      </RootLayout>,
    );
    expect(markup).toContain('<html lang="en">');
    expect(markup).toContain('<body>');
    expect(metadata).toMatchObject({
      title: 'RJ POS',
      description: 'Retail operations portal',
    });
  });

  it('server-renders without Electron or browser globals', () => {
    expect('window' in globalThis).toBe(false);
    expect('document' in globalThis).toBe(false);
    expect('electron' in globalThis).toBe(false);
    expect(() => renderToStaticMarkup(<Dashboard />)).not.toThrow();
  });
});
