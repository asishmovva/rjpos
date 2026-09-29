import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import RootLayout, { metadata } from '../app/layout.js';
import Dashboard from '../app/page.js';

describe('RJ POS web foundation', () => {
  it('renders no register content on the server; the PIN screen or register appears after client-side session restore', () => {
    const markup = renderToStaticMarkup(<Dashboard />);
    expect(markup).not.toContain('Scan UPC');
    expect(markup).not.toContain('Walk-in customer');
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
      description: 'Retail register and merchant operations',
    });
  });

  it('server-renders without Electron or browser globals', () => {
    expect('window' in globalThis).toBe(false);
    expect('document' in globalThis).toBe(false);
    expect('electron' in globalThis).toBe(false);
    expect(() => renderToStaticMarkup(<Dashboard />)).not.toThrow();
  });
});
