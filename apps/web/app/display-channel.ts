/**
 * Register → customer display messages. The display is a second window on the same origin, so a BroadcastChannel is enough:
 * no network, no credentials, and the display never sees employee or approval details. Nothing here carries support information.
 */
export const DISPLAY_CHANNEL = 'rjpos-customer-display';

export type DisplayPhase = 'idle' | 'sale' | 'age' | 'processing' | 'cash-complete' | 'thanks';
export type DisplayLine = { id: string; name: string; detail: string; quantity: number; totalMinor: string };
export type DisplayPromo = { id: string; title: string; subtitle: string | null; imageData: string | null };
export type DisplayState = {
  phase: DisplayPhase; storeName: string; lines: DisplayLine[]; itemCount: number;
  subtotalMinor: string; taxMinor: string; discountMinor: string; totalMinor: string; tenderedMinor?: string; changeDueMinor?: string;
  promos: DisplayPromo[];
};
export type DisplayMessage = { type: 'state'; state: DisplayState } | { type: 'request' };

export const emptyDisplayState = (storeName = ''): DisplayState => ({ phase: 'idle', storeName, lines: [], itemCount: 0, subtotalMinor: '0', taxMinor: '0', discountMinor: '0', totalMinor: '0', promos: [] });

function open(): BroadcastChannel | null { try { return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(DISPLAY_CHANNEL); } catch { return null; } }

export function publishDisplay(state: DisplayState): void {
  const channel = open(); if (!channel) return;
  channel.postMessage({ type: 'state', state } satisfies DisplayMessage); channel.close();
}
/** Register side: answer a newly opened display with the latest state. */
export function answerDisplayRequests(latest: () => DisplayState): () => void {
  const channel = open(); if (!channel) return () => undefined;
  channel.onmessage = (event: MessageEvent<DisplayMessage>) => { if (event.data?.type === 'request') channel.postMessage({ type: 'state', state: latest() } satisfies DisplayMessage); };
  return () => channel.close();
}
/** Display side: receive state, and ask the register for the current one. */
export function subscribeDisplay(onState: (state: DisplayState) => void): () => void {
  const channel = open(); if (!channel) return () => undefined;
  channel.onmessage = (event: MessageEvent<DisplayMessage>) => { if (event.data?.type === 'state') onState(event.data.state); };
  channel.postMessage({ type: 'request' } satisfies DisplayMessage);
  return () => channel.close();
}
