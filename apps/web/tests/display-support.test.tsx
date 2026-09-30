// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDisplayState, type DisplayState } from '../app/display-channel.js';

let push: (state: DisplayState) => void = () => undefined;
vi.mock('../app/display-channel.js', async (original) => ({ ...(await original<typeof import('../app/display-channel.js')>()), subscribeDisplay: (callback: (state: DisplayState) => void) => { push = callback; return () => undefined; } }));
const { default: CustomerDisplayPage } = await import('../app/customer-display/page.js');
const { SupportButton } = await import('../app/support.js');
afterEach(() => cleanup());

const sale: DisplayState = { ...emptyDisplayState('Downtown'), phase: 'sale', itemCount: 2, lines: [{ id: 'a', name: 'Cola', detail: '12 oz', quantity: 2, totalMinor: '398' }], subtotalMinor: '398', taxMinor: '26', discountMinor: '50', totalMinor: '374' };

describe('Customer display', () => {
  it('shows a welcome screen with no promotions, then the live order, savings, and total', () => {
    render(<CustomerDisplayPage />);
    expect(screen.getByText('Welcome. Thank you for shopping with us.')).toBeTruthy();
    act(() => push({ ...sale, storeName: 'Downtown' }));
    expect(screen.getByText('Cola')).toBeTruthy(); expect(screen.getByText('2 × 12 oz')).toBeTruthy();
    expect(screen.getByText('You saved')).toBeTruthy(); expect(screen.getAllByText('$3.74').length).toBeGreaterThan(0);
  });
  it('shows neutral states for age verification and payment, and a large change due', () => {
    render(<CustomerDisplayPage />);
    act(() => push({ ...sale, phase: 'age' })); expect(screen.getByText('Age verification required')).toBeTruthy();
    act(() => push({ ...sale, phase: 'processing' })); expect(screen.getByText('Processing payment…')).toBeTruthy();
    act(() => push({ ...sale, phase: 'cash-complete', tenderedMinor: '2000', changeDueMinor: '1626' })); expect(screen.getByText('$16.26')).toBeTruthy(); expect(screen.getByText('Change due')).toBeTruthy();
    act(() => push({ ...sale, phase: 'thanks' })); expect(screen.getByText('Thank you!')).toBeTruthy();
  });
  it('never renders support details or staff information', () => {
    const { container } = render(<CustomerDisplayPage />);
    act(() => push({ ...sale, promos: [{ id: 'p', title: 'Wine Wednesday', subtitle: '15% off', imageData: null }] }));
    expect(container.textContent).toContain('Wine Wednesday');
    expect(container.textContent).not.toMatch(/support|help|24\/7|cashier|manager/i);
  });
});

describe('Support dialog', () => {
  it('opens from the Help button, says when details are not configured, and closes with Escape', async () => {
    const user = userEvent.setup(); render(<SupportButton />);
    await user.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.getByRole('dialog', { name: 'RJ POS Support' })).toBeTruthy(); expect(screen.getByText('24/7 Support')).toBeTruthy();
    expect(screen.getAllByText('Not configured yet').length).toBe(3);
    await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog')).toBeNull();
  });
});
