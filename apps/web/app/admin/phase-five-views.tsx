'use client';

import { useState, type FormEvent } from 'react';
import {
  adminApi,
  type InventoryRow,
  type Promotion,
  type ReplenishmentSuggestion,
  type StockCount,
  type Store,
  type Transfer,
} from './admin-client';

type Run = (
  operation: () => Promise<unknown>,
  message: string,
) => Promise<void>;
const Table = ({
  headers,
  children,
}: {
  headers: string[];
  children: React.ReactNode;
}) => (
  <div className="admin-table-wrap">
    <table>
      <thead>
        <tr>
          {headers.map((header) => (
            <th key={header}>{header}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

export function TransfersView({
  rows,
  stores,
  inventory,
  run,
}: {
  rows: Transfer[];
  stores: Store[];
  inventory: InventoryRow[];
  run: Run;
}) {
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(
      () =>
        adminApi.createTransfer({
          sourceStoreId: String(form.get('source')),
          destinationStoreId: String(form.get('destination')),
          notes: String(form.get('notes') ?? ''),
          lines: [
            {
              variantId: String(form.get('variant')),
              quantity: Number(form.get('quantity')),
            },
          ],
        }),
      'Transfer draft created.',
    );
    event.currentTarget.reset();
  }
  const actionLines = (row: Transfer, kind: 'ship' | 'receive') =>
    row.lines.map((line) => ({
      transferLineId: line.id,
      quantity:
        kind === 'ship'
          ? line.requestedQuantity
          : line.shippedQuantity - line.receivedQuantity,
    }));
  return (
    <>
      <form className="admin-form" onSubmit={(event) => void create(event)}>
        <label>
          Source store
          <select name="source" required>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Destination store
          <select name="destination" required>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Product
          <select name="variant" required>
            {inventory.map((row) => (
              <option key={row.variant.id} value={row.variant.id}>
                {row.variant.product.name} · {row.variant.sku}
              </option>
            ))}
          </select>
        </label>
        <label>
          Quantity
          <input
            name="quantity"
            type="number"
            min="1"
            defaultValue="1"
            required
          />
        </label>
        <label>
          Notes
          <input name="notes" />
        </label>
        <button className="primary">Create transfer</button>
      </form>
      <Table headers={['Transfer', 'Route', 'Status', 'Lines', 'Actions']}>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              {row.transferNumber}
              <small>{new Date(row.createdAt).toLocaleString()}</small>
            </td>
            <td>
              {row.sourceStore.name} → {row.destinationStore.name}
            </td>
            <td>{row.status}</td>
            <td>
              {row.lines
                .map(
                  (line) =>
                    `${line.variant.product.name}: ${line.requestedQuantity}/${line.shippedQuantity}/${line.receivedQuantity}`,
                )
                .join('; ')}
            </td>
            <td>
              <button
                disabled={row.status !== 'DRAFT'}
                onClick={() =>
                  void run(
                    () => adminApi.submitTransfer(row.id),
                    'Transfer submitted.',
                  )
                }
              >
                Submit
              </button>
              <button
                disabled={row.status !== 'SUBMITTED'}
                onClick={() =>
                  void run(
                    () =>
                      adminApi.shipTransfer(row.id, {
                        idempotencyKey: crypto.randomUUID(),
                        lines: actionLines(row, 'ship'),
                      }),
                    'Transfer shipped.',
                  )
                }
              >
                Ship
              </button>
              <button
                disabled={row.status !== 'IN_TRANSIT'}
                onClick={() =>
                  void run(
                    () =>
                      adminApi.receiveTransfer(row.id, {
                        idempotencyKey: crypto.randomUUID(),
                        lines: actionLines(row, 'receive'),
                      }),
                    'Transfer received.',
                  )
                }
              >
                Receive remaining
              </button>
              <button
                disabled={!['DRAFT', 'SUBMITTED'].includes(row.status)}
                onClick={() =>
                  void run(
                    () => adminApi.cancelTransfer(row.id),
                    'Transfer cancelled.',
                  )
                }
              >
                Cancel
              </button>
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}

export function StockCountsView({
  rows,
  stores,
  inventory,
  run,
  variancesOnly = false,
}: {
  rows: StockCount[];
  stores: Store[];
  inventory: InventoryRow[];
  run: Run;
  variancesOnly?: boolean;
}) {
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(
      () =>
        adminApi.createStockCount({
          storeId: String(form.get('store')),
          variantIds: [String(form.get('variant'))],
          notes: String(form.get('notes') ?? ''),
        }),
      'Stock count created.',
    );
    event.currentTarget.reset();
  }
  const visible = variancesOnly
    ? rows.filter((row) =>
        row.lines.some((line) => line.variance !== null && line.variance !== 0),
      )
    : rows;
  return (
    <>
      {!variancesOnly && (
        <form className="admin-form" onSubmit={(event) => void create(event)}>
          <label>
            Store
            <select name="store" required>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Product
            <select name="variant" required>
              {inventory.map((row) => (
                <option key={row.variant.id} value={row.variant.id}>
                  {row.variant.product.name} · {row.variant.sku}
                </option>
              ))}
            </select>
          </label>
          <label>
            Notes
            <input name="notes" />
          </label>
          <button className="primary">Start count</button>
        </form>
      )}
      <Table
        headers={[
          'Count',
          'Store',
          'Status',
          'Expected / counted / variance',
          'Actions',
        ]}
      >
        {visible.map((row) => (
          <tr key={row.id}>
            <td>{row.countNumber}</td>
            <td>{row.store.name}</td>
            <td>{row.status}</td>
            <td>
              {row.lines
                .map(
                  (line) =>
                    `${line.variant.product.name}: ${line.expectedQuantity} / ${line.countedQuantity ?? '—'} / ${line.variance ?? '—'}`,
                )
                .join('; ')}
            </td>
            <td>
              {!variancesOnly && (
                <>
                  <button
                    disabled={row.status !== 'DRAFT'}
                    onClick={() => {
                      const values = row.lines.map((line) =>
                        window.prompt(
                          `Counted quantity for ${line.variant.product.name}`,
                          String(line.expectedQuantity),
                        ),
                      );
                      if (values.some((value) => value === null)) return;
                      void run(
                        () =>
                          adminApi.reviewStockCount(row.id, {
                            lines: row.lines.map((line, index) => ({
                              stockCountLineId: line.id,
                              countedQuantity: Number(values[index]),
                            })),
                          }),
                        'Count reviewed.',
                      );
                    }}
                  >
                    Review
                  </button>
                  <button
                    disabled={row.status !== 'REVIEWED'}
                    onClick={() =>
                      void run(
                        () => adminApi.finalizeStockCount(row.id),
                        'Count finalized and variance movements posted.',
                      )
                    }
                  >
                    Finalize
                  </button>
                </>
              )}
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}

export function ReplenishmentView({
  rows,
  run,
}: {
  rows: ReplenishmentSuggestion[];
  run: Run;
}) {
  return (
    <Table
      headers={[
        'Item',
        'Store',
        'Available / target',
        'Suggested',
        'Preferred vendor',
        'Action',
      ]}
    >
      {rows.map((row) => (
        <tr key={`${row.storeId}-${row.variantId}`}>
          <td>
            {row.productName}
            <small>
              {row.variantName} · {row.sku}
            </small>
          </td>
          <td>{row.storeName}</td>
          <td>
            {row.available} / {row.reorderTarget}
          </td>
          <td>
            {row.suggestedUnits} units · {row.suggestedCases} cases
          </td>
          <td>{row.vendorName ?? 'No preferred vendor'}</td>
          <td>
            <button
              disabled={!row.vendorId || !row.unitCostMinor}
              onClick={() =>
                void run(
                  () =>
                    adminApi.createPurchaseOrder({
                      storeId: row.storeId,
                      vendorId: row.vendorId!,
                      poNumber: `REPL-${Date.now()}`,
                      notes: 'Created from replenishment suggestion',
                      lines: [
                        {
                          variantId: row.variantId,
                          quantity: row.suggestedUnits,
                          ...(row.vendorProductMappingId
                            ? {
                                vendorProductMappingId:
                                  row.vendorProductMappingId,
                              }
                            : {}),
                          unitCostMinor: row.unitCostMinor!,
                        },
                      ],
                    }),
                  'Draft purchase order created from suggestion.',
                )
              }
            >
              Add to draft PO
            </button>
          </td>
        </tr>
      ))}
    </Table>
  );
}

export function PromotionsView({
  rows,
  stores,
  inventory,
  run,
}: {
  rows: Promotion[];
  stores: Store[];
  inventory: InventoryRow[];
  run: Run;
}) {
  const [type, setType] = useState<'PERCENTAGE' | 'FIXED' | 'MULTIBUY'>(
    'PERCENTAGE',
  );
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const now = new Date();
    const end = new Date(now);
    end.setFullYear(end.getFullYear() + 1);
    const body: Record<string, unknown> = {
      name: String(form.get('name')),
      type,
      scope: 'VARIANT',
      variantId: String(form.get('variant')),
      storeId: String(form.get('store')) || null,
      minimumQuantity: Number(form.get('minimumQuantity')),
      minimumSpendMinor: String(form.get('minimumSpendMinor')),
      priority: Number(form.get('priority')),
      startsAt: now.toISOString(),
      endsAt: end.toISOString(),
      active: true,
    };
    if (type === 'PERCENTAGE')
      body.percentageBasisPoints = Number(form.get('percentageBasisPoints'));
    if (type === 'FIXED')
      body.fixedAmountMinor = String(form.get('fixedAmountMinor'));
    if (type === 'MULTIBUY') {
      body.bundleQuantity = Number(form.get('bundleQuantity'));
      body.bundlePriceMinor = String(form.get('bundlePriceMinor'));
    }
    await run(() => adminApi.createPromotion(body), 'Promotion created.');
    event.currentTarget.reset();
  }
  return (
    <>
      <form
        className="admin-form wide"
        onSubmit={(event) => void create(event)}
      >
        <label>
          Name
          <input name="name" required />
        </label>
        <label>
          Type
          <select
            value={type}
            onChange={(event) => setType(event.target.value as typeof type)}
          >
            <option value="PERCENTAGE">Percentage</option>
            <option value="FIXED">Fixed amount</option>
            <option value="MULTIBUY">Multi-buy</option>
          </select>
        </label>
        <label>
          Variant
          <select name="variant" required>
            {inventory.map((row) => (
              <option key={row.variant.id} value={row.variant.id}>
                {row.variant.product.name} · {row.variant.sku}
              </option>
            ))}
          </select>
        </label>
        <label>
          Store
          <select name="store">
            <option value="">All stores</option>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
        {type === 'PERCENTAGE' && (
          <label>
            Percent off
            <input
              name="percentageBasisPoints"
              type="number"
              min="1"
              max="10000"
              defaultValue="1000"
              required
            />
          </label>
        )}
        {type === 'FIXED' && (
          <label>
            Fixed discount cents
            <input
              name="fixedAmountMinor"
              type="number"
              min="1"
              defaultValue="100"
              required
            />
          </label>
        )}
        {type === 'MULTIBUY' && (
          <>
            <label>
              Bundle quantity
              <input
                name="bundleQuantity"
                type="number"
                min="1"
                defaultValue="3"
                required
              />
            </label>
            <label>
              Bundle price cents
              <input
                name="bundlePriceMinor"
                type="number"
                min="0"
                defaultValue="1000"
                required
              />
            </label>
          </>
        )}
        <label>
          Minimum quantity
          <input
            name="minimumQuantity"
            type="number"
            min="1"
            defaultValue="1"
          />
        </label>
        <label>
          Minimum spend cents
          <input
            name="minimumSpendMinor"
            type="number"
            min="0"
            defaultValue="0"
          />
        </label>
        <label>
          Priority
          <input name="priority" type="number" defaultValue="0" />
        </label>
        <button className="primary">Create promotion</button>
      </form>
      <Table
        headers={[
          'Promotion',
          'Type',
          'Scope',
          'Schedule',
          'Priority',
          'Status / action',
        ]}
      >
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{row.name}</td>
            <td>{row.type}</td>
            <td>
              {row.scope}
              {row.storeId ? ' · store-specific' : ' · all stores'}
            </td>
            <td>
              {new Date(row.startsAt).toLocaleDateString()} –{' '}
              {new Date(row.endsAt).toLocaleDateString()}
            </td>
            <td>{row.priority}</td>
            <td>
              {row.active ? 'ACTIVE' : 'INACTIVE'}{' '}
              <button
                disabled={!row.active}
                onClick={() =>
                  void run(
                    () =>
                      adminApi.updatePromotion(row.id, {
                        ...row,
                        active: false,
                      }),
                    'Promotion deactivated.',
                  )
                }
              >
                Deactivate
              </button>
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}
