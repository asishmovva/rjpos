'use client';
import { ADMIN_GROUPS } from './admin-links';
import { BrandMark } from '../brand';
import { SupportButton } from '../support';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { adminApi, createCatalogFlow, money, type CatalogLookupResult, type Category, type Customer, type Dashboard, type Employee, type GiftCardDetail, type InventoryRow, type LoyaltyProgram, type MasterImportSummary, type MasterProduct, type MovementRow, type OrderRow, type Product, type PurchaseOrderDetail, type PurchaseOrderRow, type PurchaseReceiptRow, type RefundRow, type ReplenishmentSuggestion, type Shift, type StockCount, type Store, type Vendor, type VendorAddress, type VendorMapping, type Transfer, type Promotion } from './admin-client';
import { EmployeeEditor } from './employee-editor';
import { PromotionsView, ReplenishmentView, StockCountsView, TransfersView } from './phase-five-views';
import './admin.css';
import './costing.css';

const areas = ['Dashboard', 'Products', 'Categories', 'Inventory', 'Transfers', 'Stock Counts', 'Inventory Variances', 'Replenishment', 'Promotions', 'Master Catalog', 'Vendors', 'Vendor Mappings', 'Purchase Orders', 'Receiving History', 'Orders', 'Refunds', 'Employees', 'Customers', 'Loyalty', 'Gift Cards', 'Stores', 'Registers', 'Settings'] as const;
type Area = (typeof areas)[number];
type RegisterRow = {
  id: string;
  name: string;
  code: string;
  status: string;
  store: Store;
  sessions: unknown[];
};

export default function AdminPage(): React.ReactNode {
  const [area, setArea] = useState<Area>('Dashboard');
  const mainRef = useRef<HTMLElement>(null);
  // Each module starts at the top; the sidebar keeps its own scroll position.
  useEffect(() => { if (mainRef.current) mainRef.current.scrollTop = 0; window.scrollTo(0, 0); }, [area]);
  // Sub-pages link back to a section with #Section.
  useEffect(() => { const wanted = decodeURIComponent(window.location.hash.slice(1)); if ((areas as readonly string[]).includes(wanted)) setArea(wanted as Area); }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loyalty, setLoyalty] = useState<LoyaltyProgram>(null);
  const [giftCard, setGiftCard] = useState<GiftCardDetail>();
  const [stores, setStores] = useState<Store[]>([]);
  const [registers, setRegisters] = useState<RegisterRow[]>([]);
  const [audit, setAudit] = useState<Array<{ id: string; action: string; entityType: string; createdAt: string }>>([]);
  const [masterCatalog, setMasterCatalog] = useState<MasterProduct[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorMappings, setVendorMappings] = useState<VendorMapping[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderRow[]>([]);
  const [receivingHistory, setReceivingHistory] = useState<PurchaseReceiptRow[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [stockCounts, setStockCounts] = useState<StockCount[]>([]);
  const [replenishment, setReplenishment] = useState<ReplenishmentSuggestion[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);

  const load = useCallback(
    async (target = area, term = search) => {
      setLoading(true);
      setError('');
      try {
        if (target === 'Dashboard') setDashboard(await adminApi.dashboard());
        if (target === 'Products') {
          const [result, categoryResult, storeResult] = await Promise.all([adminApi.products(term), adminApi.categories(), adminApi.stores()]);
          setProducts(result.items);
          setCategories(categoryResult.items);
          setStores(storeResult);
        }
        if (target === 'Categories') setCategories((await adminApi.categories(term)).items);
        if (target === 'Inventory') setInventory((await adminApi.inventory(term)).items);
        if (target === 'Transfers') {
          const [transferResult, storeResult, inventoryResult] = await Promise.all([adminApi.transfers(), adminApi.stores(), adminApi.inventory()]);
          setTransfers(transferResult.items);
          setStores(storeResult);
          setInventory(inventoryResult.items);
        }
        if (target === 'Stock Counts' || target === 'Inventory Variances') {
          const [countResult, storeResult, inventoryResult] = await Promise.all([adminApi.stockCounts(), adminApi.stores(), adminApi.inventory()]);
          setStockCounts(countResult.items);
          setStores(storeResult);
          setInventory(inventoryResult.items);
        }
        if (target === 'Replenishment') setReplenishment(await adminApi.replenishment());
        if (target === 'Promotions') {
          const [promotionResult, storeResult, inventoryResult] = await Promise.all([adminApi.promotions(), adminApi.stores(), adminApi.inventory()]);
          setPromotions(promotionResult.items);
          setStores(storeResult);
          setInventory(inventoryResult.items);
        }
        if (target === 'Orders') setOrders((await adminApi.orders(term)).items);
        if (target === 'Refunds') setRefunds((await adminApi.refunds(term)).items);
        if (target === 'Employees') {
          const [employeeResult, storeResult, shiftResult] = await Promise.all([adminApi.employees(), adminApi.stores(), adminApi.shifts()]);
          setEmployees(employeeResult.items);
          setStores(storeResult);
          setShifts(shiftResult.items);
        }
        if (target === 'Customers') setCustomers((await adminApi.customers(term)).items);
        if (target === 'Loyalty') {
          const [program, customerResult] = await Promise.all([adminApi.loyaltyProgram(), adminApi.customers()]);
          setLoyalty(program);
          setCustomers(customerResult.items);
        }
        if (target === 'Gift Cards') setGiftCard(undefined);
        if (target === 'Stores' || target === 'Settings') setStores(target === 'Settings' ? await adminApi.settings() : await adminApi.stores());
        if (target === 'Registers') {
          const [registerResult, storeResult] = await Promise.all([adminApi.registers(), adminApi.stores()]);
          setRegisters(registerResult);
          setStores(storeResult);
        }
        if (target === 'Master Catalog') {
          const [result, categoryResult, storeResult] = await Promise.all([adminApi.masterCatalog(term), adminApi.categories(), adminApi.stores()]);
          setMasterCatalog(result.items);
          setCategories(categoryResult.items);
          setStores(storeResult);
        }
        if (target === 'Vendors') setVendors((await adminApi.vendors(term)).items);
        if (target === 'Vendor Mappings') {
          const [mappingResult, vendorResult] = await Promise.all([adminApi.vendorMappings('', term), adminApi.vendors()]);
          setVendorMappings(mappingResult.items);
          setVendors(vendorResult.items);
        }
        if (target === 'Purchase Orders') {
          const [poResult, vendorResult, storeResult] = await Promise.all([adminApi.purchaseOrders(term), adminApi.vendors('', true), adminApi.stores()]);
          setPurchaseOrders(poResult.items);
          setVendors(vendorResult.items);
          setStores(storeResult);
        }
        if (target === 'Receiving History') setReceivingHistory((await adminApi.receivingHistory()).items);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not load this area.');
      } finally {
        setLoading(false);
      }
    },
    [area, search],
  );

  useEffect(() => {
    void load();
  }, [load]);
  async function action(operation: () => Promise<unknown>, message: string): Promise<void> {
    setError('');
    setNotice('');
    try {
      await operation();
      setNotice(message);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Operation failed.');
    }
  }
  function switchArea(next: Area): void {
    setArea(next);
    setSearch('');
    setNotice('');
  }

  return (
    <main className="admin-shell">
      <aside className="admin-nav">
        <a className="admin-brand" href="/">
          <BrandMark size={30} />
          <strong>Back Office</strong>
        </a>
        <nav aria-label="Back-office navigation">
          {ADMIN_GROUPS.map((group) => <div className="nav-group" key={group.title}><span className="nav-heading">{group.title}</span>
            {group.items.map((item) => item.area
              ? <button className={area === item.area ? 'active' : ''} key={item.label} onClick={() => switchArea(item.area as Area)}>{item.label}</button>
              : <a className="nav-link" key={item.label} href={item.href}>{item.label}</a>)}</div>)}
        </nav>
        <div className="nav-foot"><SupportButton className="support-btn on-dark" /><a className="register-link" href="/">Return to register</a></div>
      </aside>
      <section className="admin-main" ref={mainRef}>
        <header className="admin-heading">
          <div>
            <span className="eyebrow">Owner workspace</span>
            <h1>{area}</h1>
          </div>
          {['Products', 'Categories', 'Inventory', 'Master Catalog', 'Vendors', 'Vendor Mappings', 'Purchase Orders', 'Orders', 'Refunds', 'Customers'].includes(area) && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void load(area, search);
              }}
            >
              <input aria-label={`Search ${area}`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${area.toLowerCase()}…`} />
              <button>Search</button>
            </form>
          )}
        </header>
        {error && (
          <p role="alert" className="admin-alert error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="admin-alert success">
            {notice}
          </p>
        )}
        {loading ? (
          <div className="admin-empty">Loading authoritative data…</div>
        ) : (
          <>
            {area === 'Dashboard' && <DashboardView data={dashboard} />}
            {area === 'Categories' && <CategoriesView categories={categories} run={action} />}
            {area === 'Products' && <ProductsView products={products} categories={categories} stores={stores} run={action} />}
            {area === 'Inventory' && <InventoryView rows={inventory} run={action} />}
            {area === 'Transfers' && <TransfersView rows={transfers} stores={stores} inventory={inventory} run={action} />}
            {area === 'Stock Counts' && <StockCountsView rows={stockCounts} stores={stores} inventory={inventory} run={action} />}
            {area === 'Inventory Variances' && <StockCountsView rows={stockCounts} stores={stores} inventory={inventory} run={action} variancesOnly />}
            {area === 'Replenishment' && <ReplenishmentView rows={replenishment} run={action} />}
            {area === 'Promotions' && <PromotionsView rows={promotions} stores={stores} inventory={inventory} run={action} />}
            {area === 'Master Catalog' && <MasterCatalogView rows={masterCatalog} categories={categories} stores={stores} run={action} />}
            {area === 'Vendors' && <VendorsView rows={vendors} run={action} />}
            {area === 'Vendor Mappings' && <VendorMappingsView rows={vendorMappings} vendors={vendors} run={action} />}
            {area === 'Purchase Orders' && <PurchaseOrdersView rows={purchaseOrders} vendors={vendors} stores={stores} run={action} />}
            {area === 'Receiving History' && <ReceivingHistoryView rows={receivingHistory} />}
            {area === 'Orders' && <OrdersView rows={orders} />}
            {area === 'Refunds' && <RefundsView rows={refunds} />}
            {area === 'Employees' && <EmployeesView rows={employees} stores={stores} shifts={shifts} run={action} />}
            {area === 'Customers' && <CustomersView rows={customers} run={action} />}
            {area === 'Loyalty' && <LoyaltyView program={loyalty} customers={customers} run={action} />}
            {area === 'Gift Cards' && <GiftCardsView detail={giftCard} setDetail={setGiftCard} run={action} />}
            {area === 'Stores' && <StoresView rows={stores} run={action} />}
            {area === 'Registers' && <RegistersView rows={registers} stores={stores} run={action} />}
            {area === 'Settings' && <SettingsView rows={stores} audit={audit} setAudit={setAudit} run={action} />}
          </>
        )}
      </section>
    </main>
  );
}

function DashboardView({ data }: { data?: Dashboard }): React.ReactNode {
  if (!data) return <Empty label="No dashboard data is available." />;
  const cards = [
    ['Net sales', money(data.salesMinor)],
    ['Transactions', data.transactions],
    ['Average sale', money(data.averageTransactionMinor)],
    ['Refund total', money(data.refundMinor)],
    ['Open registers', data.openRegisters],
    ['Low-stock products', data.lowStockProducts],
    ['Outstanding POs', data.outstandingPurchaseOrders],
  ];
  return (
    <>
      <div className="metric-grid">
        {cards.map(([label, value]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
      <p className="hint">Period: {data.from} through {data.to} · <a href="/admin/reports">Open full reports &amp; exports</a></p>
      {data.topProducts.length > 0 && (
        <div className="admin-table-wrap">
          <table>
            <thead><tr><th>Top product</th><th>Quantity sold</th><th>Revenue</th></tr></thead>
            <tbody>
              {data.topProducts.map((row) => (
                <tr key={row.label}><td>{row.label}</td><td>{row.quantitySold}</td><td>{money(row.revenueMinor)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CategoriesView({ categories, run }: { categories: Category[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  const [name, setName] = useState('');
  return (
    <>
      <form
        className="admin-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => adminApi.createCategory(name), 'Category created.').then(() => setName(''));
        }}
      >
        <label>
          Category name
          <input required value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button className="primary">Create category</button>
      </form>
      <DataTable headers={['Category', 'Products', 'Status', 'Action']} empty="No categories match this search.">
        {categories.map((category) => (
          <tr key={category.id}>
            <td>{category.name}</td>
            <td>{category._count?.products ?? 0}</td>
            <td>
              <Pill value={category.active ? 'ACTIVE' : 'INACTIVE'} />
            </td>
            <td>
              <button
                onClick={() => {
                  const name = window.prompt('Category name', category.name);
                  if (name) void run(() => adminApi.updateCategory(category.id, { name }), 'Category renamed.');
                }}
              >
                Rename
              </button>
              <button
                onClick={() =>
                  void run(
                    () =>
                      adminApi.updateCategory(category.id, {
                        active: !category.active,
                      }),
                    `Category ${category.active ? 'deactivated' : 'activated'}.`,
                  )
                }
              >
                {category.active ? 'Deactivate' : 'Activate'}
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}

function ProductsView({ products, categories, stores, run }: { products: Product[]; categories: Category[]; stores: Store[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  const [show, setShow] = useState(false);
  const [priceHistory, setPriceHistory] = useState<
    Array<{
      id: string;
      amountMinor: string;
      effectiveFrom: string;
      effectiveTo: string | null;
    }>
  >([]);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    await run(
      () =>
        createCatalogFlow({
          categoryId: String(fields.get('categoryId')) || undefined,
          categoryName: String(fields.get('categoryName')) || undefined,
          productName: String(fields.get('productName')),
          brand: String(fields.get('brand')),
          variantName: String(fields.get('variantName')),
          sku: String(fields.get('sku')),
          barcode: String(fields.get('barcode')),
          storeId: String(fields.get('storeId')),
          priceMinor: String(fields.get('priceMinor')),
          openingQuantity: Number(fields.get('openingQuantity')),
          reason: String(fields.get('reason')),
          lowStockThreshold: Number(fields.get('threshold')),
        }),
      'Product, variant, price, and opening inventory created.',
    );
    form.reset();
    setShow(false);
  }
  return (
    <>
      <div className="toolbar">
        <p>{products.length} products on this page</p>
        <button className="primary" onClick={() => setShow(!show)}>
          {show ? 'Cancel' : 'New product'}
        </button>
      </div>
      {show && (
        <form className="admin-form wide" onSubmit={(event) => void submit(event)}>
          <label>
            Existing category
            <select name="categoryId">
              <option value="">Create a new category</option>
              {categories
                .filter(({ active }) => active)
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            New category
            <input name="categoryName" placeholder="Required if no existing category" />
          </label>
          <label>
            Product name
            <input name="productName" required />
          </label>
          <label>
            Brand
            <input name="brand" />
          </label>
          <label>
            Variant
            <input name="variantName" required placeholder="750 ml" />
          </label>
          <label>
            SKU
            <input name="sku" required />
          </label>
          <label>
            UPC / barcode
            <input name="barcode" required />
          </label>
          <label>
            Store
            <select name="storeId" required>
              <option value="">Choose store</option>
              {stores
                .filter(({ status }) => status === 'ACTIVE')
                .map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Price, cents
            <input name="priceMinor" required inputMode="numeric" />
          </label>
          <label>
            Opening quantity
            <input name="openingQuantity" required type="number" min="0" />
          </label>
          <label>
            Low-stock threshold
            <input name="threshold" required type="number" min="0" defaultValue="2" />
          </label>
          <label className="grow">
            Opening reason
            <input name="reason" required defaultValue="Opening count" />
          </label>
          <button className="primary">Create sellable item</button>
        </form>
      )}
      {categories.length === 0 && <p className="hint">The workflow creates its category so a clean installation can be administered without seed changes.</p>}
      <DataTable headers={['Product', 'Category', 'Variants', 'Status', 'Actions']} empty="No products match this search.">
        {products.map((product) => (
          <tr key={product.id}>
            <td>
              <strong>{product.name}</strong>
              <small>{product.brand || 'No brand'}</small>
            </td>
            <td>{product.category.name}</td>
            <td>
              {product.variants.map((variant) => (
                <span className="stack" key={variant.id}>
                  {variant.name} · {variant.sku} · {variant.barcodes[0]?.barcodeValue || 'No UPC'}
                </span>
              ))}
            </td>
            <td>
              <Pill value={product.active ? 'ACTIVE' : 'INACTIVE'} />
            </td>
            <td>
              <a className="costing-link" href={`/admin/product/?id=${product.id}`}>Details</a>{' '}
              <button
                onClick={() => {
                  const name = window.prompt('Product name', product.name);
                  if (name) void run(() => adminApi.updateProduct(product.id, { name }), 'Product updated.');
                }}
              >
                Edit
              </button>
              <button
                onClick={() =>
                  void run(
                    () =>
                      adminApi.updateProduct(product.id, {
                        active: !product.active,
                      }),
                    `Product ${product.active ? 'deactivated' : 'activated'}.`,
                  )
                }
              >
                {product.active ? 'Deactivate' : 'Activate'}
              </button>
              {product.variants[0] && (
                <>
                  <button
                    onClick={() => {
                      const variant = product.variants[0]!;
                      const name = window.prompt('Variant name', variant.name);
                      const newSku = window.prompt('SKU', variant.sku);
                      const barcode = window.prompt('UPC / barcode', variant.barcodes[0]?.barcodeValue ?? '');
                      if (name && newSku && barcode !== null)
                        void run(
                          () =>
                            adminApi.updateVariant(variant.id, {
                              name,
                              sku: newSku,
                              barcode,
                            }),
                          'Variant updated.',
                        );
                    }}
                  >
                    Edit variant
                  </button>
                  <button
                    onClick={() => {
                      const amountMinor = window.prompt('New price in cents');
                      if (amountMinor && stores[0])
                        void run(
                          () =>
                            adminApi.schedulePrice({
                              variantId: product.variants[0]!.id,
                              storeId: stores[0]!.id,
                              amountMinor,
                              effectiveFrom: new Date().toISOString(),
                            }),
                          'Future/current price scheduled; history preserved.',
                        );
                    }}
                  >
                    Schedule price
                  </button>
                  <button onClick={() => void adminApi.priceHistory(product.variants[0]!.id, stores[0]?.id).then(setPriceHistory)}>Price history</button>
                </>
              )}
            </td>
          </tr>
        ))}
      </DataTable>
      {priceHistory.length > 0 && (
        <DataTable headers={['Amount', 'Effective from', 'Effective to']} empty="No price history.">
          {priceHistory.map((price) => (
            <tr key={price.id}>
              <td>{money(price.amountMinor)}</td>
              <td>{new Date(price.effectiveFrom).toLocaleString()}</td>
              <td>{price.effectiveTo ? new Date(price.effectiveTo).toLocaleString() : 'Open-ended'}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}

function InventoryView({ rows, run }: { rows: InventoryRow[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  const [movements, setMovements] = useState<MovementRow[]>([]);
  return (
    <>
      <DataTable headers={['Item', 'Store', 'On hand', 'Reserved', 'Available', 'Low / target', 'Status', 'Adjustment']} empty="No inventory matches this search.">
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              <strong>{row.variant.product.name}</strong>
              <small>
                {row.variant.name} · {row.variant.sku}
              </small>
            </td>
            <td>{row.store.name}</td>
            <td>{row.onHand}</td>
            <td>{row.reserved}</td>
            <td>{row.available}</td>
            <td>
              {row.lowStockThreshold} / {row.reorderTarget}
            </td>
            <td>
              <Pill value={row.inventoryStatus} />
            </td>
            <td>
              <button
                onClick={() => {
                  const low = window.prompt('Low-stock threshold', String(row.lowStockThreshold));
                  const target = window.prompt('Reorder target', String(row.reorderTarget));
                  if (low !== null && target !== null)
                    void run(
                      () =>
                        adminApi.updateInventoryPolicy({
                          storeId: row.storeId,
                          variantId: row.variant.id,
                          lowStockThreshold: Number(low),
                          reorderTarget: Number(target),
                        }),
                      'Store inventory policy updated.',
                    );
                }}
              >
                Policy
              </button>
              <button
                onClick={() => {
                  const raw = window.prompt('Quantity change (negative for adjustment out)');
                  const reason = window.prompt('Required reason');
                  if (raw && reason)
                    void run(
                      () =>
                        adminApi.adjustInventory({
                          storeId: row.storeId,
                          variantId: row.variant.id,
                          quantityDelta: Number(raw),
                          reason,
                        }),
                      'Inventory adjusted and ledger movement recorded.',
                    );
                }}
              >
                Adjust
              </button>
              <button onClick={() => void adminApi.movements(row.variant.id).then((result) => setMovements(result.items))}>History</button>
            </td>
          </tr>
        ))}
      </DataTable>
      {movements.length > 0 && (
        <>
          <h2>Movement history</h2>
          <DataTable headers={['Time', 'Item', 'Type', 'Quantity', 'Result', 'Employee', 'Reason / reference']} empty="No movements.">
            {movements.map((movement) => (
              <tr key={movement.id}>
                <td>{new Date(movement.createdAt).toLocaleString()}</td>
                <td>
                  {movement.variant.product.name}
                  <small>{movement.store.name}</small>
                </td>
                <td>{movement.type}</td>
                <td>{movement.quantityDelta}</td>
                <td>{movement.resultingOnHand ?? '—'}</td>
                <td>{movement.employee ? `${movement.employee.firstName} ${movement.employee.lastName}` : 'System'}</td>
                <td>{movement.reason || `${movement.referenceType ?? ''} ${movement.referenceId ?? ''}`}</td>
              </tr>
            ))}
          </DataTable>
        </>
      )}
    </>
  );
}

function OrdersView({ rows }: { rows: OrderRow[] }): React.ReactNode {
  const [detail, setDetail] = useState<Record<string, unknown>>();
  return (
    <>
      <DataTable headers={['Order', 'Date', 'Store / register', 'Cashier', 'Payment', 'Status', 'Total']} empty="No orders match this search.">
        {rows.map((order) => (
          <tr key={order.id}>
            <td>
              <button onClick={() => void adminApi.order(order.id).then(setDetail)}>{order.orderNumber}</button>
            </td>
            <td>{new Date(order.createdAt).toLocaleString()}</td>
            <td>
              {order.store.name}
              <small>{order.register.name}</small>
            </td>
            <td>
              {order.session.employee.firstName} {order.session.employee.lastName}
            </td>
            <td>
              {order.payments[0]?.kind ?? '—'} · {order.payments[0]?.status ?? '—'}
            </td>
            <td>
              <Pill value={order.refunds.length ? 'REFUNDED' : order.status} />
            </td>
            <td>{money(order.totalMinor)}</td>
          </tr>
        ))}
      </DataTable>
      {detail && (
        <section className="order-detail">
          <h2>Order detail</h2>
          <pre>{JSON.stringify(detail, null, 2)}</pre>
        </section>
      )}
    </>
  );
}
function RefundsView({ rows }: { rows: RefundRow[] }): React.ReactNode {
  return (
    <DataTable headers={['Refund', 'Original order', 'Employee', 'Reason', 'Status', 'Amount', 'Time']} empty="No refunds match this search.">
      {rows.map((refund) => (
        <tr key={refund.id}>
          <td>{refund.id.slice(0, 8)}</td>
          <td>{refund.order.orderNumber}</td>
          <td>
            {refund.employee.firstName} {refund.employee.lastName}
          </td>
          <td>{refund.reason}</td>
          <td>
            <Pill value={refund.status} />
          </td>
          <td>{money(refund.amountMinor)}</td>
          <td>{new Date(refund.createdAt).toLocaleString()}</td>
        </tr>
      ))}
    </DataTable>
  );
}

function EmployeesView({ rows, stores, shifts, run }: { rows: Employee[]; stores: Store[]; shifts: Shift[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  const [editing, setEditing] = useState<Employee | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    await run(
      () =>
        adminApi.createEmployee({
          firstName: String(fields.get('firstName')),
          lastName: String(fields.get('lastName')),
          roleNames: [String(fields.get('role'))],
          storeIds: [String(fields.get('storeId'))],
          ...(fields.get('pin') ? { pin: String(fields.get('pin')) } : {}),
        }),
      'Employee created and assigned.',
    );
    form.reset();
  }
  return (
    <>
      <form className="admin-form" onSubmit={(event) => void submit(event)}>
        <label>
          First name
          <input name="firstName" required />
        </label>
        <label>
          Last name
          <input name="lastName" required />
        </label>
        <label>
          Role
          <select name="role">
            <option>CASHIER</option>
            <option>MANAGER</option>
            <option>OWNER</option>
          </select>
        </label>
        <label>
          Store
          <select name="storeId" required>
            <option value="">Choose store</option>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          PIN (4–8 digits, optional)
          <input name="pin" type="password" inputMode="numeric" pattern="\d{4,8}" autoComplete="off" />
        </label>
        <button className="primary">Create employee</button>
      </form>
      {editing && <EmployeeEditor employee={editing} stores={stores} run={run} onClose={() => setEditing(null)} />}
      <DataTable headers={['Employee', 'Role', 'Stores', 'PIN', 'Status', 'Actions']} empty="No employees found.">
        {rows.map((employee) => (
          <tr key={employee.id}>
            <td>
              {employee.firstName} {employee.lastName}
            </td>
            <td>{employee.roles.map(({ role }) => role.name).join(', ')}</td>
            <td>{employee.stores.map(({ store }) => store.name).join(', ')}</td>
            <td>{employee.hasPin ? 'Set' : 'Not set'}</td>
            <td>
              <Pill value={employee.status} />
            </td>
            <td>
              <button onClick={() => setEditing(employee)}>Manage</button>
              <button
                onClick={() => {
                  const firstName = window.prompt('First name', employee.firstName);
                  const lastName = window.prompt('Last name', employee.lastName);
                  if (firstName && lastName)
                    void run(
                      () =>
                        adminApi.updateEmployee(employee.id, {
                          firstName,
                          lastName,
                        }),
                      'Employee updated.',
                    );
                }}
              >
                Edit
              </button>
              <button
                onClick={() => {
                  const role = window.prompt('Role: OWNER, MANAGER, or CASHIER', employee.roles[0]?.role.name);
                  if (role)
                    void run(
                      () =>
                        adminApi.updateEmployee(employee.id, {
                          roleNames: [role],
                        }),
                      'Employee role updated.',
                    );
                }}
              >
                Change role
              </button>
              <button
                onClick={() =>
                  void run(
                    () =>
                      adminApi.updateEmployee(employee.id, {
                        status: employee.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                      }),
                    'Employee lifecycle updated.',
                  )
                }
              >
                {employee.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
      <h2>Shift history</h2>
      <DataTable headers={['Employee', 'Store / register', 'Clock in', 'Clock out', 'Worked', 'Correction']} empty="No shifts recorded.">
        {shifts.map((shift) => (
          <tr key={shift.id}>
            <td>
              {shift.employee.firstName} {shift.employee.lastName}
            </td>
            <td>
              {shift.store.name}
              <small>{shift.register?.name ?? 'No register'}</small>
            </td>
            <td>{new Date(shift.correctedClockedInAt ?? shift.clockedInAt).toLocaleString()}</td>
            <td>{shift.clockedOutAt ? new Date(shift.correctedClockedOutAt ?? shift.clockedOutAt).toLocaleString() : 'ACTIVE'}</td>
            <td>{(shift.workedSeconds / 3600).toFixed(2)} h</td>
            <td>
              <button
                disabled={!shift.clockedOutAt}
                onClick={() => {
                  const clockedInAt = window.prompt('Corrected clock-in ISO time', shift.correctedClockedInAt ?? shift.clockedInAt);
                  const clockedOutAt = window.prompt('Corrected clock-out ISO time', shift.correctedClockedOutAt ?? shift.clockedOutAt ?? '');
                  const reason = window.prompt('Required correction reason');
                  if (clockedInAt && clockedOutAt && reason)
                    void run(
                      () =>
                        adminApi.correctShift(shift.id, {
                          clockedInAt,
                          clockedOutAt,
                          reason,
                        }),
                      'Shift correction audited.',
                    );
                }}
              >
                Correct
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}

function CustomersView({ rows, run }: { rows: Customer[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  const [detail, setDetail] = useState<Customer>();
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    await run(
      () =>
        adminApi.createCustomer({
          name: String(fields.get('name')),
          email: String(fields.get('email')) || undefined,
          phone: String(fields.get('phone')) || undefined,
          notes: String(fields.get('notes')) || undefined,
        }),
      'Customer created.',
    );
    form.reset();
  }
  return (
    <>
      <form className="admin-form" onSubmit={(event) => void submit(event)}>
        <label>
          Name
          <input name="name" required />
        </label>
        <label>
          Email
          <input name="email" type="email" />
        </label>
        <label>
          Phone
          <input name="phone" />
        </label>
        <label>
          Notes
          <input name="notes" />
        </label>
        <button className="primary">Create customer</button>
      </form>
      <DataTable headers={['Customer', 'Contact', 'Status', 'Actions']} empty="No customers match this search.">
        {rows.map((customer) => (
          <tr key={customer.id}>
            <td>
              <button onClick={() => void adminApi.customer(customer.id).then(setDetail)}>{customer.name}</button>
            </td>
            <td>
              {customer.email || 'No email'}
              <small>{customer.phone || 'No phone'}</small>
            </td>
            <td>
              <Pill value={customer.active ? 'ACTIVE' : 'INACTIVE'} />
            </td>
            <td>
              <button
                onClick={() => {
                  const name = window.prompt('Customer name', customer.name);
                  if (name) void run(() => adminApi.updateCustomer(customer.id, { name }), 'Customer updated.');
                }}
              >
                Edit
              </button>
              <button
                onClick={() =>
                  void run(
                    () =>
                      adminApi.updateCustomer(customer.id, {
                        active: !customer.active,
                      }),
                    'Customer lifecycle updated.',
                  )
                }
              >
                {customer.active ? 'Deactivate' : 'Activate'}
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
      {detail && (
        <section className="order-detail">
          <h2>{detail.name}</h2>
          <p>Loyalty balance: {detail.pointsBalance ?? 0} points</p>
          <h3>Purchase history</h3>
          {detail.orders?.map((order) => (
            <article className="history" key={order.id}>
              <strong>{order.orderNumber}</strong>
              <span>
                {order.status} · {order.payments.map((payment) => payment.kind).join(' + ')}
              </span>
              <b>{money(order.totalMinor)}</b>
            </article>
          ))}
          <h3>Loyalty history</h3>
          {detail.loyaltyTransactions?.map((entry) => (
            <p key={entry.id}>
              {entry.type}: {entry.points} · {entry.reason || 'Sale activity'}
            </p>
          ))}
        </section>
      )}
    </>
  );
}

function LoyaltyView({ program, customers, run }: { program: LoyaltyProgram; customers: Customer[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  return (
    <>
      <form
        className="admin-form"
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          void run(
            () =>
              adminApi.configureLoyalty({
                enabled: fields.get('enabled') === 'on',
                pointsEarned: Number(fields.get('pointsEarned')),
                spendMinor: String(fields.get('spendMinor')),
                redeemMinorPerPoint: String(fields.get('redeemMinorPerPoint')),
              }),
            'Loyalty configuration updated.',
          );
        }}
      >
        <label>
          Enabled
          <input name="enabled" type="checkbox" defaultChecked={program?.enabled} />
        </label>
        <label>
          Points earned
          <input name="pointsEarned" type="number" min="1" defaultValue={program?.pointsEarned ?? 1} />
        </label>
        <label>
          Per cents spent
          <input name="spendMinor" type="number" min="1" defaultValue={program?.spendMinor ?? '100'} />
        </label>
        <label>
          Redemption cents / point
          <input name="redeemMinorPerPoint" type="number" min="1" defaultValue={program?.redeemMinorPerPoint ?? '1'} />
        </label>
        <button className="primary">Save loyalty rule</button>
      </form>
      <DataTable headers={['Customer', 'Manual adjustment']} empty="No customers available.">
        {customers.map((customer) => (
          <tr key={customer.id}>
            <td>{customer.name}</td>
            <td>
              <button
                onClick={() => {
                  const points = window.prompt('Points change (negative removes points)');
                  const reason = window.prompt('Required reason');
                  if (points && reason)
                    void run(
                      () =>
                        adminApi.adjustLoyalty(customer.id, {
                          points: Number(points),
                          reason,
                        }),
                      'Loyalty adjustment recorded.',
                    );
                }}
              >
                Adjust points
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}

function GiftCardsView({ detail, setDetail, run }: { detail?: GiftCardDetail; setDetail: (detail: GiftCardDetail | undefined) => void; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  const [code, setCode] = useState('');
  const [issuedCode, setIssuedCode] = useState('');
  return (
    <>
      <form
        className="admin-form"
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          void adminApi
            .issueGiftCard({
              amountMinor: String(fields.get('amountMinor')),
              reason: String(fields.get('reason')),
            })
            .then((result) => {
              setIssuedCode(result.code);
              setCode(result.code);
              return adminApi.giftCard(result.code);
            })
            .then(setDetail);
        }}
      >
        <label>
          Issue amount, cents
          <input name="amountMinor" required type="number" min="1" />
        </label>
        <label>
          Reason
          <input name="reason" defaultValue="Customer purchase" />
        </label>
        <button className="primary">Issue gift card</button>
      </form>
      {issuedCode && (
        <p role="status" className="admin-alert success">
          New gift-card code (shown once): <strong>{issuedCode}</strong>
        </p>
      )}
      <form
        className="admin-form"
        onSubmit={(event) => {
          event.preventDefault();
          void adminApi.giftCard(code).then(setDetail);
        }}
      >
        <label>
          Gift-card code
          <input value={code} onChange={(event) => setCode(event.target.value)} required />
        </label>
        <button>Lookup</button>
        {detail && (
          <>
            <button
              type="button"
              onClick={() => {
                const amountMinor = window.prompt('Reload amount in cents');
                const reason = window.prompt('Required reason');
                if (amountMinor && reason) void run(() => adminApi.reloadGiftCard({ code, amountMinor, reason }), 'Gift card reloaded.').then(() => adminApi.giftCard(code).then(setDetail));
              }}
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => {
                const reason = window.prompt('Required disable reason');
                if (reason) void run(() => adminApi.disableGiftCard(detail.id, reason), 'Gift card disabled.');
              }}
            >
              Disable
            </button>
          </>
        )}
      </form>
      {detail && (
        <>
          <div className="metric-grid">
            <article>
              <span>Card</span>
              <strong>•••• {detail.lastFour}</strong>
            </article>
            <article>
              <span>Balance</span>
              <strong>{money(detail.balanceMinor)}</strong>
            </article>
            <article>
              <span>Status</span>
              <strong>{detail.status}</strong>
            </article>
          </div>
          <DataTable headers={['Time', 'Type', 'Status', 'Amount', 'Reason']} empty="No gift-card history.">
            {detail.history.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.createdAt).toLocaleString()}</td>
                <td>{entry.type}</td>
                <td>{entry.status}</td>
                <td>{money(entry.amountMinor)}</td>
                <td>{entry.reason || 'Sale activity'}</td>
              </tr>
            ))}
          </DataTable>
        </>
      )}
    </>
  );
}

function StoresView({ rows, run }: { rows: Store[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    await run(
      () =>
        adminApi.createStore({
          name: String(fields.get('name')),
          timezone: String(fields.get('timezone')),
          taxRateBasisPoints: Number(fields.get('tax')),
        }),
      'Store created.',
    );
    form.reset();
  }
  return (
    <>
      <form className="admin-form" onSubmit={(event) => void submit(event)}>
        <label>
          Store name
          <input name="name" required />
        </label>
        <label>
          Timezone
          <input name="timezone" required defaultValue="America/New_York" />
        </label>
        <label>
          Tax basis points
          <input name="tax" required type="number" min="0" max="10000" />
        </label>
        <button className="primary">Create store</button>
      </form>
      <DataTable headers={['Store', 'Timezone', 'Tax', 'Status', 'Action']} empty="No stores found.">
        {rows.map((store) => (
          <tr key={store.id}>
            <td>{store.name}</td>
            <td>{store.timezone}</td>
            <td>{(store.taxRateBasisPoints / 100).toFixed(2)}%</td>
            <td>
              <Pill value={store.status} />
            </td>
            <td>
              <button
                onClick={() => {
                  const name = window.prompt('Store name', store.name);
                  const timezone = window.prompt('IANA timezone', store.timezone);
                  const tax = window.prompt('Tax basis points', String(store.taxRateBasisPoints));
                  if (name && timezone && tax)
                    void run(
                      () =>
                        adminApi.updateStore(store.id, {
                          name,
                          timezone,
                          taxRateBasisPoints: Number(tax),
                        }),
                      'Store updated.',
                    );
                }}
              >
                Edit
              </button>
              <button
                onClick={() =>
                  void run(
                    () =>
                      adminApi.updateStore(store.id, {
                        status: store.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                      }),
                    'Store lifecycle updated.',
                  )
                }
              >
                {store.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}

function RegistersView({ rows, stores, run }: { rows: RegisterRow[]; stores: Store[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    await run(
      () =>
        adminApi.createRegister({
          storeId: String(fields.get('storeId')),
          name: String(fields.get('name')),
          code: String(fields.get('code')),
        }),
      'Register created.',
    );
    form.reset();
  }
  return (
    <>
      <form className="admin-form" onSubmit={(event) => void submit(event)}>
        <label>
          Register name
          <input name="name" required />
        </label>
        <label>
          Code
          <input name="code" required />
        </label>
        <label>
          Store
          <select name="storeId" required>
            <option value="">Choose store</option>
            {stores
              .filter(({ status }) => status === 'ACTIVE')
              .map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
          </select>
        </label>
        <button className="primary">Create register</button>
      </form>
      <DataTable headers={['Register', 'Code', 'Store', 'Session', 'Status', 'Action']} empty="No registers found.">
        {rows.map((register) => (
          <tr key={register.id}>
            <td>{register.name}</td>
            <td>{register.code}</td>
            <td>{register.store.name}</td>
            <td>{register.sessions.length ? 'OPEN' : 'CLOSED'}</td>
            <td>
              <Pill value={register.status} />
            </td>
            <td>
              <button
                onClick={() => {
                  const name = window.prompt('Register name', register.name);
                  const code = window.prompt('Register code', register.code);
                  if (name && code) void run(() => adminApi.updateRegister(register.id, { name, code }), 'Register updated.');
                }}
              >
                Edit
              </button>
              <button
                onClick={() =>
                  void run(
                    () =>
                      adminApi.updateRegister(register.id, {
                        status: register.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                      }),
                    'Register lifecycle updated.',
                  )
                }
              >
                {register.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}

function SettingsView({
  rows,
  audit,
  setAudit,
  run,
}: {
  rows: Store[];
  audit: Array<{
    id: string;
    action: string;
    entityType: string;
    createdAt: string;
  }>;
  setAudit: (
    rows: Array<{
      id: string;
      action: string;
      entityType: string;
      createdAt: string;
    }>,
  ) => void;
  run: (operation: () => Promise<unknown>, message: string) => Promise<void>;
}): React.ReactNode {
  return (
    <>
      <div className="settings-grid">
        {rows.map((store) => (
          <article key={store.id}>
            <h2>{store.name}</h2>
            <p>
              {store.timezone} · {(store.taxRateBasisPoints / 100).toFixed(2)}% tax
            </p>
            <p>Receipt footer: {store.receiptFooter || 'Not set'}</p>
            <button
              onClick={() => {
                const receiptFooter = window.prompt('Receipt footer', store.receiptFooter ?? '');
                if (receiptFooter !== null) void run(() => adminApi.updateStore(store.id, { receiptFooter }), 'Store settings updated.');
              }}
            >
              Edit receipt settings
            </button>
          </article>
        ))}
      </div>
      <div className="toolbar">
        <h2>Audit history</h2>
        <button onClick={() => void adminApi.audit().then((result) => setAudit(result.items))}>Load audit history</button>
      </div>
      <DataTable headers={['Action', 'Entity', 'Time']} empty="Load audit history to review immutable administrative actions.">
        {audit.map((record) => (
          <tr key={record.id}>
            <td>{record.action}</td>
            <td>{record.entityType}</td>
            <td>{new Date(record.createdAt).toLocaleString()}</td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}

function DataTable({ headers, empty, children }: { headers: string[]; empty: string; children: React.ReactNode }): React.ReactNode {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className="admin-table-wrap">
      {hasRows ? (
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
      ) : (
        <Empty label={empty} />
      )}
    </div>
  );
}
function Empty({ label }: { label: string }): React.ReactNode {
  return <div className="admin-empty">{label}</div>;
}
function Pill({ value }: { value: string }): React.ReactNode {
  return <span className={`pill ${value.includes('LOW') || value.includes('INACTIVE') ? 'warn' : ''}`}>{value.replaceAll('_', ' ')}</span>;
}
function flattenVariants(products: Product[]): Array<{ id: string; label: string }> {
  return products.flatMap((product) =>
    product.variants.map((variant) => ({
      id: variant.id,
      label: `${product.name} · ${variant.name} · ${variant.sku}`,
    })),
  );
}

function VariantPicker({ label, value, selectedLabel, name, required, onChange }: { label: string; value: string; selectedLabel?: string; name?: string; required?: boolean; onChange: (variantId: string, variantLabel: string) => void }): React.ReactNode {
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{
    items: Product[];
    page: number;
    pageSize: number;
    total: number;
  }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError('');
      void adminApi
        .products(searchTerm, page)
        .then((nextResult) => {
          if (active) setResult(nextResult);
        })
        .catch((cause: unknown) => {
          if (active) setError(cause instanceof Error ? cause.message : 'Could not load product variants.');
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [page, searchTerm]);

  const options = flattenVariants(result?.items ?? []);
  if (value && selectedLabel && !options.some((option) => option.id === value)) options.unshift({ id: value, label: selectedLabel });
  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / (result?.pageSize ?? 25)));

  return (
    <div className="variant-picker">
      <label>
        {label}
        <input
          aria-label={`Search ${label}`}
          type="search"
          value={searchTerm}
          onChange={(event) => {
            setSearchTerm(event.target.value);
            setPage(1);
          }}
          placeholder="Search products, brands, SKUs, or barcodes"
        />
      </label>
      <select aria-label={label} name={name} value={value} required={required} onChange={(event) => onChange(event.target.value, event.currentTarget.selectedOptions[0]?.textContent ?? '')}>
        <option value="">Choose product</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <div className="variant-picker-pages" aria-live="polite">
        <span>{loading ? 'Searching…' : result ? `${result.total} products · page ${result.page} of ${pageCount}` : 'Search products to select a variant'}</span>
        <button type="button" aria-label={`Previous ${label} page`} disabled={loading || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
          Previous
        </button>
        <button type="button" aria-label={`Next ${label} page`} disabled={loading || !result || page >= pageCount} onClick={() => setPage((current) => current + 1)}>
          Next
        </button>
      </div>
      {error && (
        <p role="alert" className="admin-alert error">
          {error}
        </p>
      )}
    </div>
  );
}

function MasterCatalogView({ rows, categories, stores, run }: { rows: MasterProduct[]; categories: Category[]; stores: Store[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  const [upc, setUpc] = useState('');
  const [lookup, setLookup] = useState<CatalogLookupResult>();
  const [lookupError, setLookupError] = useState('');
  const [importSummary, setImportSummary] = useState<MasterImportSummary>();
  const [importError, setImportError] = useState('');

  async function doLookup(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLookupError('');
    try {
      setLookup(await adminApi.lookupUpc(upc.trim()));
    } catch (cause) {
      setLookup(undefined);
      setLookupError(cause instanceof Error ? cause.message : 'Lookup failed.');
    }
  }
  async function doImport(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportError('');
    setImportSummary(undefined);
    try {
      const csv = await file.text();
      setImportSummary(await adminApi.importMasterCatalog(csv));
      await run(() => Promise.resolve(), 'Master catalog import complete.');
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : 'Import failed.');
    }
    event.target.value = '';
  }
  async function addToStore(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!lookup || lookup.status !== 'MASTER_ONLY') return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const upcValue = lookup.upc;
    await run(async () => {
      const result = await adminApi.addMasterProductToStore(upcValue, {
        categoryId: String(fields.get('categoryId')),
        sku: String(fields.get('sku')),
        variantName: String(fields.get('variantName')) || undefined,
        storeId: String(fields.get('storeId')) || undefined,
        priceMinor: String(fields.get('priceMinor')) || undefined,
        costMinor: String(fields.get('costMinor')) || undefined,
        inventoryTracked: fields.get('inventoryTracked') === 'on',
        lowStockThreshold: String(fields.get('lowStockThreshold')).trim() ? Number(fields.get('lowStockThreshold')) : undefined,
      });
      setLookup({
        status: 'IN_STORE',
        upc: upcValue,
        product: result.product,
        variant: result.variant,
      });
    }, 'Master catalog product added to store.');
  }

  return (
    <>
      <form className="admin-form" onSubmit={(event) => void doLookup(event)}>
        <label>
          UPC / barcode
          <input required value={upc} onChange={(event) => setUpc(event.target.value)} placeholder="Scan or type UPC" />
        </label>
        <button className="primary">Look up UPC</button>
      </form>
      {lookupError && (
        <p role="alert" className="admin-alert error">
          {lookupError}
        </p>
      )}
      {lookup && lookup.status === 'NOT_FOUND' && <Empty label={`UPC ${lookup.upc} was not found in the store catalog or the master catalog.`} />}
      {lookup && lookup.status === 'IN_STORE' && (
        <p className="hint">
          UPC {lookup.upc} is already sellable as <strong>{lookup.product.name}</strong> · {lookup.variant.name} · {lookup.variant.sku}.
        </p>
      )}
      {lookup && lookup.status === 'MASTER_ONLY' && (
        <form className="admin-form wide" onSubmit={(event) => void addToStore(event)}>
          <p className="full hint">
            Master catalog match: <strong>{lookup.product.name}</strong>
            {lookup.product.brand ? ` · ${lookup.product.brand}` : ''}
            {lookup.product.sizeLabel ? ` · ${lookup.product.sizeLabel}` : lookup.product.size ? ` · ${lookup.product.size} ${lookup.product.unit}` : ''}
            {lookup.product.packName ? ` · ${lookup.product.packName}` : ''}. Imported costs and prices are reference-only; choose store-specific values below. Adding never creates inventory automatically.
          </p>
          <label>
            Category
            <select name="categoryId" required>
              <option value="">Choose category</option>
              {categories
                .filter(({ active }) => active)
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            SKU
            <input name="sku" required />
          </label>
          <label>
            Variant name
            <input name="variantName" placeholder={lookup.product.sizeLabel ? [lookup.product.sizeLabel, lookup.product.packName].filter(Boolean).join(' ') : lookup.product.size ? `${lookup.product.size} ${lookup.product.unit}` : 'Default'} />
          </label>
          <label>
            Store
            <select name="storeId">
              <option value="">All stores</option>
              {stores
                .filter(({ status }) => status === 'ACTIVE')
                .map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Price, cents (optional)
            <input name="priceMinor" inputMode="numeric" />
          </label>
          <label>
            Cost, cents (optional)
            <input name="costMinor" inputMode="numeric" />
          </label>
          <label>
            Inventory tracked
            <input name="inventoryTracked" type="checkbox" defaultChecked />
          </label>
          <label>
            Low stock threshold (optional)
            <input name="lowStockThreshold" inputMode="numeric" min={0} step={1} placeholder="0" />
          </label>
          <button className="primary full">Add to store catalog</button>
        </form>
      )}

      <div className="toolbar">
        <p>Import the master catalog from a CSV export.</p>
        <label>
          Choose CSV
          <input type="file" accept=".csv,text/csv" onChange={(event) => void doImport(event)} />
        </label>
      </div>
      {importError && (
        <p role="alert" className="admin-alert error">
          {importError}
        </p>
      )}
      {importSummary && (
        <div className="import-summary">
          <span>Added {importSummary.added}</span>
          <span>Updated {importSummary.updated}</span>
          <span>Skipped {importSummary.skipped}</span>
          <span>Invalid {importSummary.invalid}</span>
          <span>Duplicate {importSummary.duplicate}</span>
        </div>
      )}
      {importSummary && importSummary.issues.length > 0 && (
        <DataTable headers={['Row', 'Issue', 'UPC']} empty="No issues.">
          {importSummary.issues.map((issue) => (
            <tr key={`${issue.row}-${issue.code}`}>
              <td>{issue.row}</td>
              <td>{issue.code}</td>
              <td>{issue.upc ?? '—'}</td>
            </tr>
          ))}
        </DataTable>
      )}

      <DataTable headers={['UPC', 'Product', 'Category', 'Size', 'Pack', 'Reference cost', 'Reference price']} empty="No master catalog products match this search.">
        {rows.map((product) => (
          <tr key={product.id}>
            <td>{product.upc}</td>
            <td>{product.name}</td>
            <td>{product.category ?? '—'}</td>
            <td>{product.sizeLabel ?? (product.size ? `${product.size} ${product.unit}` : '—')}</td>
            <td>{product.packName ?? '—'}</td>
            <td>{product.referenceCostMinor === null ? '—' : money(product.referenceCostMinor)}</td>
            <td>{product.referencePriceMinor === null ? '—' : money(product.referencePriceMinor)}</td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}

function VendorsView({ rows, run }: { rows: Vendor[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const address: VendorAddress = {
      line1: String(fields.get('line1')) || undefined,
      city: String(fields.get('city')) || undefined,
      state: String(fields.get('state')) || undefined,
      postalCode: String(fields.get('postalCode')) || undefined,
    };
    const hasAddress = Object.values(address).some((value) => value !== undefined);
    await run(
      () =>
        adminApi.createVendor({
          name: String(fields.get('name')),
          contactName: String(fields.get('contactName')) || undefined,
          email: String(fields.get('email')) || undefined,
          phone: String(fields.get('phone')) || undefined,
          address: hasAddress ? address : undefined,
          accountReference: String(fields.get('accountReference')) || undefined,
          notes: String(fields.get('notes')) || undefined,
        }),
      'Vendor created.',
    );
    form.reset();
  }
  function editVendor(vendor: Vendor): void {
    const name = window.prompt('Vendor name', vendor.name);
    if (!name) return;
    const contactName = window.prompt('Contact name', vendor.contactName ?? '') ?? '';
    const email = window.prompt('Email', vendor.email ?? '') ?? '';
    const phone = window.prompt('Phone', vendor.phone ?? '') ?? '';
    const accountReference = window.prompt('Account reference', vendor.accountReference ?? '') ?? '';
    const notes = window.prompt('Notes', vendor.notes ?? '') ?? '';
    const line1 = window.prompt('Address line 1', vendor.addressJson?.line1 ?? '') ?? '';
    const city = window.prompt('City', vendor.addressJson?.city ?? '') ?? '';
    const state = window.prompt('State', vendor.addressJson?.state ?? '') ?? '';
    const postalCode = window.prompt('Postal code', vendor.addressJson?.postalCode ?? '') ?? '';
    const address = {
      line1: line1 || undefined,
      city: city || undefined,
      state: state || undefined,
      postalCode: postalCode || undefined,
    };
    void run(
      () =>
        adminApi.updateVendor(vendor.id, {
          name,
          contactName: contactName || undefined,
          email: email || undefined,
          phone: phone || undefined,
          accountReference: accountReference || undefined,
          notes: notes || undefined,
          address: Object.values(address).some((value) => value !== undefined) ? address : undefined,
        }),
      'Vendor updated.',
    );
  }
  return (
    <>
      <form className="admin-form wide" onSubmit={(event) => void submit(event)}>
        <label>
          Name
          <input name="name" required />
        </label>
        <label>
          Contact name
          <input name="contactName" />
        </label>
        <label>
          Email
          <input name="email" type="email" />
        </label>
        <label>
          Phone
          <input name="phone" />
        </label>
        <label>
          Address line 1<input name="line1" />
        </label>
        <label>
          City
          <input name="city" />
        </label>
        <label>
          State
          <input name="state" />
        </label>
        <label>
          Postal code
          <input name="postalCode" />
        </label>
        <label>
          Account reference
          <input name="accountReference" />
        </label>
        <label className="grow">
          Notes
          <input name="notes" />
        </label>
        <button className="primary">Create vendor</button>
      </form>
      <DataTable headers={['Vendor', 'Contact', 'Account ref', 'Mappings / POs', 'Status', 'Actions']} empty="No vendors match this search.">
        {rows.map((vendor) => (
          <tr key={vendor.id}>
            <td>
              <strong>{vendor.name}</strong>
              {vendor.addressJson?.city && (
                <small>
                  {vendor.addressJson.city}
                  {vendor.addressJson.state ? `, ${vendor.addressJson.state}` : ''}
                </small>
              )}
            </td>
            <td>
              {vendor.contactName ?? '—'}
              <small>{vendor.email ?? vendor.phone ?? 'No contact info'}</small>
            </td>
            <td>{vendor.accountReference ?? '—'}</td>
            <td>
              {vendor._count?.mappings ?? 0} / {vendor._count?.purchaseOrders ?? 0}
            </td>
            <td>
              <Pill value={vendor.active ? 'ACTIVE' : 'INACTIVE'} />
            </td>
            <td>
              <button onClick={() => editVendor(vendor)}>Edit</button>
              <button
                onClick={() =>
                  void run(
                    () =>
                      adminApi.updateVendor(vendor.id, {
                        active: !vendor.active,
                      }),
                    `Vendor ${vendor.active ? 'deactivated' : 'activated'}.`,
                  )
                }
              >
                {vendor.active ? 'Deactivate' : 'Activate'}
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}

function VendorMappingsView({ rows, vendors, run }: { rows: VendorMapping[]; vendors: Vendor[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  const [editing, setEditing] = useState<VendorMapping>();
  const [show, setShow] = useState(false);
  const [selectedVariantId, setSelectedVariantId] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    await run(
      () =>
        adminApi.saveVendorMapping({
          id: editing?.id,
          vendorId: String(fields.get('vendorId')),
          variantId: String(fields.get('variantId')),
          vendorSku: String(fields.get('vendorSku')) || undefined,
          vendorCostMinor: String(fields.get('vendorCostMinor')),
          casePackQuantity: Number(fields.get('casePackQuantity')) || undefined,
          minimumOrderQuantity: Number(fields.get('minimumOrderQuantity')) || undefined,
          preferred: fields.get('preferred') === 'on',
          active: fields.get('active') === 'on',
        }),
      editing ? 'Vendor mapping updated.' : 'Vendor mapping created.',
    );
    form.reset();
    setShow(false);
    setEditing(undefined);
    setSelectedVariantId('');
  }
  return (
    <>
      <div className="toolbar">
        <p>{rows.length} vendor mappings on this page</p>
        <button
          className="primary"
          onClick={() => {
            if (show && !editing) setShow(false);
            else {
              setEditing(undefined);
              setSelectedVariantId('');
              setShow(true);
            }
          }}
        >
          {show && !editing ? 'Cancel' : 'New mapping'}
        </button>
      </div>
      {show && (
        <form className="admin-form wide" key={editing?.id ?? 'new-mapping'} onSubmit={(event) => void submit(event)}>
          <label>
            Vendor
            <select name="vendorId" required defaultValue={editing?.vendorId ?? ''}>
              <option value="">Choose vendor</option>
              {vendors
                .filter(({ active }) => active)
                .map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>
                    {vendor.name}
                  </option>
                ))}
            </select>
          </label>
          <VariantPicker label="Product / variant" name="variantId" required value={selectedVariantId} selectedLabel={editing ? `${editing.variant.product.name} · ${editing.variant.name} · ${editing.variant.sku}` : undefined} onChange={(variantId) => setSelectedVariantId(variantId)} />
          <label>
            Vendor SKU
            <input name="vendorSku" defaultValue={editing?.vendorSku ?? ''} />
          </label>
          <label>
            Vendor cost, cents
            <input name="vendorCostMinor" required inputMode="numeric" defaultValue={editing?.vendorCostMinor ?? ''} />
          </label>
          <label>
            Case pack quantity
            <input name="casePackQuantity" type="number" min="1" defaultValue={editing?.casePackQuantity ?? 1} />
          </label>
          <label>
            Minimum order quantity
            <input name="minimumOrderQuantity" type="number" min="1" defaultValue={editing?.minimumOrderQuantity ?? 1} />
          </label>
          <label>
            Preferred vendor
            <input name="preferred" type="checkbox" defaultChecked={editing?.preferred ?? false} />
          </label>
          <label>
            Active
            <input name="active" type="checkbox" defaultChecked={editing?.active ?? true} />
          </label>
          <button className="primary">{editing ? 'Save mapping' : 'Create mapping'}</button>
        </form>
      )}
      <DataTable headers={['Vendor', 'Product / variant', 'Vendor SKU', 'Cost', 'Case pack', 'MOQ', 'Preferred', 'Status', 'Actions']} empty="No vendor mappings match this search.">
        {rows.map((mapping) => (
          <tr key={mapping.id}>
            <td>{mapping.vendor.name}</td>
            <td>
              {mapping.variant.product.name} · {mapping.variant.name} · {mapping.variant.sku}
            </td>
            <td>{mapping.vendorSku ?? '—'}</td>
            <td>{money(mapping.vendorCostMinor)}</td>
            <td>{mapping.casePackQuantity}</td>
            <td>{mapping.minimumOrderQuantity}</td>
            <td>
              <Pill value={mapping.preferred ? 'PREFERRED' : 'STANDARD'} />
            </td>
            <td>
              <Pill value={mapping.active ? 'ACTIVE' : 'INACTIVE'} />
            </td>
            <td>
              <button
                onClick={() => {
                  setEditing(mapping);
                  setSelectedVariantId(mapping.variantId);
                  setShow(true);
                }}
              >
                Edit
              </button>
              <button
                onClick={() =>
                  void run(
                    () =>
                      adminApi.saveVendorMapping({
                        id: mapping.id,
                        vendorId: mapping.vendorId,
                        variantId: mapping.variantId,
                        vendorCostMinor: mapping.vendorCostMinor,
                        active: !mapping.active,
                      }),
                    `Vendor mapping ${mapping.active ? 'deactivated' : 'activated'}.`,
                  )
                }
              >
                {mapping.active ? 'Deactivate' : 'Activate'}
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}

type PurchaseDraftLine = {
  variantId: string;
  variantLabel?: string;
  quantity: number;
  unitCostMinor: string;
};
type PurchaseDraft = {
  id?: string;
  poNumber: string;
  vendorId: string;
  storeId: string;
  notes: string;
  lines: PurchaseDraftLine[];
};
type ReceivingLine = {
  purchaseOrderLineId: string;
  label: string;
  remaining: number;
  deliveredQuantity: string;
  damagedQuantity: string;
  rejectedQuantity: string;
  unitCostMinor: string;
};
type Receiving = {
  poId: string;
  idempotencyKey: string;
  vendorReferenceNumber: string;
  notes: string;
  lines: ReceivingLine[];
};

function PurchaseOrdersView({ rows, vendors, stores, run }: { rows: PurchaseOrderRow[]; vendors: Vendor[]; stores: Store[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  const [draft, setDraft] = useState<PurchaseDraft>();
  const [lowStock, setLowStock] = useState<InventoryRow[]>([]);
  const [selectedLowStock, setSelectedLowStock] = useState<string[]>([]);
  const [detail, setDetail] = useState<PurchaseOrderDetail>();
  const [receiving, setReceiving] = useState<Receiving>();

  function newDraft(): void {
    setDraft({
      poNumber: `PO-${Date.now()}`,
      vendorId: '',
      storeId: '',
      notes: '',
      lines: [],
    });
    setLowStock([]);
    setSelectedLowStock([]);
  }
  function editDraft(po: PurchaseOrderRow): void {
    setDraft({
      id: po.id,
      poNumber: po.poNumber,
      vendorId: po.vendorId,
      storeId: po.storeId,
      notes: po.notes ?? '',
      lines: po.lines.map((line) => ({
        variantId: line.variantId,
        variantLabel: `${line.productNameSnapshot} · ${line.variantNameSnapshot} · ${line.skuSnapshot}`,
        quantity: line.orderedQuantity,
        unitCostMinor: line.unitCostMinor,
      })),
    });
    setLowStock([]);
    setSelectedLowStock([]);
  }
  function addLine(): void {
    setDraft(
      (current) =>
        current && {
          ...current,
          lines: [...current.lines, { variantId: '', quantity: 1, unitCostMinor: '' }],
        },
    );
  }
  function updateLine(index: number, patch: Partial<PurchaseDraftLine>): void {
    setDraft(
      (current) =>
        current && {
          ...current,
          lines: current.lines.map((line, position) => (position === index ? { ...line, ...patch } : line)),
        },
    );
  }
  function removeLine(index: number): void {
    setDraft(
      (current) =>
        current && {
          ...current,
          lines: current.lines.filter((_, position) => position !== index),
        },
    );
  }
  async function loadLowStock(): Promise<void> {
    setLowStock((await adminApi.inventory('', true)).items);
  }
  function toggleLowStock(variantId: string): void {
    setSelectedLowStock((current) => (current.includes(variantId) ? current.filter((id) => id !== variantId) : [...current, variantId]));
  }
  function addSelectedLowStock(): void {
    setDraft((current) => {
      if (!current) return current;
      const existingIds = new Set(current.lines.map((line) => line.variantId));
      const additions = lowStock
        .filter((row) => selectedLowStock.includes(row.variant.id) && !existingIds.has(row.variant.id))
        .map((row) => ({
          variantId: row.variant.id,
          variantLabel: `${row.variant.product.name} · ${row.variant.name} · ${row.variant.sku}`,
          quantity: Math.max(row.variant.lowStockThreshold * 2 - row.onHand, 1),
          unitCostMinor: '',
        }));
      return { ...current, lines: [...current.lines, ...additions] };
    });
    setSelectedLowStock([]);
  }
  async function saveDraft(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!draft) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const vendorId = String(fields.get('vendorId'));
    const storeId = String(fields.get('storeId')) || undefined;
    const poNumber = String(fields.get('poNumber'));
    const notes = String(fields.get('notes')) || undefined;
    const lines = draft.lines
      .filter((line) => line.variantId && line.quantity > 0)
      .map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        unitCostMinor: line.unitCostMinor || undefined,
      }));
    if (draft.id)
      await run(
        () =>
          adminApi.updatePurchaseOrder(draft.id!, {
            vendorId,
            poNumber,
            notes: notes ?? null,
            lines,
          }),
        'Purchase order updated.',
      );
    else
      await run(
        () =>
          adminApi.createPurchaseOrder({
            vendorId,
            storeId,
            poNumber,
            notes,
            lines,
          }),
        'Purchase order draft created.',
      );
    setDraft(undefined);
  }
  async function viewDetail(id: string): Promise<void> {
    setDetail(await adminApi.purchaseOrder(id));
  }
  function startReceiving(po: PurchaseOrderRow): void {
    const remainingLines = po.lines.filter((line) => line.orderedQuantity - line.receivedQuantity > 0);
    setReceiving({
      poId: po.id,
      idempotencyKey: crypto.randomUUID(),
      vendorReferenceNumber: '',
      notes: '',
      lines: remainingLines.map((line) => ({
        purchaseOrderLineId: line.id,
        label: `${line.productNameSnapshot} · ${line.variantNameSnapshot} · ${line.skuSnapshot}`,
        remaining: line.orderedQuantity - line.receivedQuantity,
        deliveredQuantity: String(line.orderedQuantity - line.receivedQuantity),
        damagedQuantity: '0',
        rejectedQuantity: '0',
        unitCostMinor: line.unitCostMinor,
      })),
    });
    setDraft(undefined);
  }
  function updateReceivingLine(index: number, patch: Partial<ReceivingLine>): void {
    setReceiving(
      (current) =>
        current && {
          ...current,
          lines: current.lines.map((line, position) => (position === index ? { ...line, ...patch } : line)),
        },
    );
  }
  async function submitReceiving(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!receiving) return;
    const lines = receiving.lines
      .filter((line) => Number(line.deliveredQuantity) > 0 || Number(line.damagedQuantity) > 0 || Number(line.rejectedQuantity) > 0)
      .map((line) => ({
        purchaseOrderLineId: line.purchaseOrderLineId,
        deliveredQuantity: Number(line.deliveredQuantity) || 0,
        damagedQuantity: Number(line.damagedQuantity) || undefined,
        rejectedQuantity: Number(line.rejectedQuantity) || undefined,
        unitCostMinor: line.unitCostMinor || undefined,
      }));
    await run(
      () =>
        adminApi.receivePurchaseOrder(receiving.poId, {
          idempotencyKey: receiving.idempotencyKey,
          vendorReferenceNumber: receiving.vendorReferenceNumber || undefined,
          notes: receiving.notes || undefined,
          lines,
        }),
      'Receipt recorded.',
    );
    setReceiving(undefined);
  }

  return (
    <>
      <div className="toolbar">
        <p>{rows.length} purchase orders on this page</p>
        <button className="primary" onClick={() => (draft ? setDraft(undefined) : newDraft())}>
          {draft ? 'Cancel' : 'New purchase order'}
        </button>
      </div>
      {draft && (
        <form className="admin-form wide" key={draft.id ?? 'new-po'} onSubmit={(event) => void saveDraft(event)}>
          <label>
            PO number
            <input name="poNumber" required defaultValue={draft.poNumber} />
          </label>
          <label>
            Vendor
            <select name="vendorId" required defaultValue={draft.vendorId}>
              <option value="">Choose vendor</option>
              {vendors
                .filter(({ active }) => active)
                .map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>
                    {vendor.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Store
            <select name="storeId" defaultValue={draft.storeId}>
              <option value="">All stores</option>
              {stores
                .filter(({ status }) => status === 'ACTIVE')
                .map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="grow">
            Notes
            <input name="notes" defaultValue={draft.notes} />
          </label>
          <div className="full">
            <div className="toolbar">
              <p>Line items</p>
              <button type="button" onClick={addLine}>
                Add line
              </button>
              <button type="button" onClick={() => void loadLowStock()}>
                Load low-stock items
              </button>
            </div>
            <table className="line-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Quantity</th>
                  <th>Unit cost, cents</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {draft.lines.map((line, index) => (
                  <tr key={index}>
                    <td>
                      <VariantPicker label={`Product / variant ${index + 1}`} value={line.variantId} selectedLabel={line.variantLabel} onChange={(variantId, variantLabel) => updateLine(index, { variantId, variantLabel })} />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="1"
                        value={line.quantity}
                        onChange={(event) =>
                          updateLine(index, {
                            quantity: Number(event.target.value),
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        inputMode="numeric"
                        value={line.unitCostMinor}
                        onChange={(event) =>
                          updateLine(index, {
                            unitCostMinor: event.target.value,
                          })
                        }
                      />
                    </td>
                    <td>
                      <button type="button" onClick={() => removeLine(index)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {lowStock.length > 0 && (
              <>
                <p className="hint">Select low-stock items to add to this draft.</p>
                <table className="line-table">
                  <thead>
                    <tr>
                      <th />
                      <th>Item</th>
                      <th>Store</th>
                      <th>On hand</th>
                      <th>Threshold</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lowStock.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <input type="checkbox" checked={selectedLowStock.includes(row.variant.id)} onChange={() => toggleLowStock(row.variant.id)} />
                        </td>
                        <td>
                          {row.variant.product.name} · {row.variant.name}
                        </td>
                        <td>{row.store.name}</td>
                        <td>{row.onHand}</td>
                        <td>{row.variant.lowStockThreshold}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" onClick={addSelectedLowStock} disabled={selectedLowStock.length === 0}>
                  Add selected to draft
                </button>
              </>
            )}
          </div>
          <button className="primary">{draft.id ? 'Save draft' : 'Create draft'}</button>
        </form>
      )}

      {receiving && (
        <form className="admin-form wide" onSubmit={(event) => void submitReceiving(event)}>
          <label>
            Vendor reference number
            <input
              value={receiving.vendorReferenceNumber}
              onChange={(event) =>
                setReceiving({
                  ...receiving,
                  vendorReferenceNumber: event.target.value,
                })
              }
            />
          </label>
          <label>
            Notes
            <input value={receiving.notes} onChange={(event) => setReceiving({ ...receiving, notes: event.target.value })} />
          </label>
          <label>
            Idempotency key
            <input
              value={receiving.idempotencyKey}
              required
              onChange={(event) =>
                setReceiving({
                  ...receiving,
                  idempotencyKey: event.target.value,
                })
              }
            />
          </label>
          <div className="full">
            <table className="line-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Remaining</th>
                  <th>Delivered</th>
                  <th>Damaged</th>
                  <th>Rejected</th>
                  <th>Actual cost, cents</th>
                </tr>
              </thead>
              <tbody>
                {receiving.lines.map((line, index) => (
                  <tr key={line.purchaseOrderLineId}>
                    <td>{line.label}</td>
                    <td>{line.remaining}</td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        value={line.deliveredQuantity}
                        onChange={(event) =>
                          updateReceivingLine(index, {
                            deliveredQuantity: event.target.value,
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        value={line.damagedQuantity}
                        onChange={(event) =>
                          updateReceivingLine(index, {
                            damagedQuantity: event.target.value,
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        value={line.rejectedQuantity}
                        onChange={(event) =>
                          updateReceivingLine(index, {
                            rejectedQuantity: event.target.value,
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        inputMode="numeric"
                        value={line.unitCostMinor}
                        onChange={(event) =>
                          updateReceivingLine(index, {
                            unitCostMinor: event.target.value,
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="primary">Record receipt</button>
          <button type="button" onClick={() => setReceiving(undefined)}>
            Cancel
          </button>
        </form>
      )}

      {detail && (
        <section className="order-detail">
          <h2>Purchase order {detail.poNumber}</h2>
          <p>
            {detail.vendor.name} → {detail.store.name} · <Pill value={detail.status} /> · Total {money(detail.totalMinor)}
          </p>
          <DataTable headers={['Item', 'Ordered', 'Received', 'Unit cost']} empty="No lines.">
            {detail.lines.map((line) => (
              <tr key={line.id}>
                <td>
                  {line.variant.product.name} · {line.variant.name} · {line.variant.sku}
                </td>
                <td>{line.orderedQuantity}</td>
                <td>{line.receivedQuantity}</td>
                <td>{money(line.unitCostMinor)}</td>
              </tr>
            ))}
          </DataTable>
          <h3>Receipts</h3>
          <DataTable headers={['Received at', 'Reference', 'Received by']} empty="No receipts recorded yet.">
            {detail.receipts.map((receipt) => (
              <tr key={receipt.id}>
                <td>{new Date(receipt.receivedAt).toLocaleString()}</td>
                <td>{receipt.vendorReferenceNumber ?? '—'}</td>
                <td>
                  {receipt.receivedBy.firstName} {receipt.receivedBy.lastName}
                </td>
              </tr>
            ))}
          </DataTable>
          <button onClick={() => setDetail(undefined)}>Close</button>
        </section>
      )}

      <DataTable headers={['PO number', 'Vendor', 'Store', 'Status', 'Total', 'Actions']} empty="No purchase orders match this search.">
        {rows.map((po) => (
          <tr key={po.id}>
            <td>{po.poNumber}</td>
            <td>{po.vendor.name}</td>
            <td>{po.store.name}</td>
            <td>
              <Pill value={po.status} />
            </td>
            <td>{money(po.totalMinor)}</td>
            <td>
              <button onClick={() => void viewDetail(po.id)}>View</button>
              <button disabled={po.status !== 'DRAFT'} onClick={() => editDraft(po)}>
                Edit
              </button>
              <button disabled={po.status !== 'DRAFT'} onClick={() => void run(() => adminApi.submitPurchaseOrder(po.id), 'Purchase order submitted.')}>
                Submit
              </button>
              <button disabled={po.status !== 'DRAFT' && po.status !== 'SUBMITTED'} onClick={() => void run(() => adminApi.cancelPurchaseOrder(po.id), 'Purchase order cancelled.')}>
                Cancel
              </button>
              <button disabled={po.status !== 'SUBMITTED' && po.status !== 'PARTIALLY_RECEIVED'} onClick={() => startReceiving(po)}>
                Receive
              </button>
            </td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}

function ReceivingHistoryView({ rows }: { rows: PurchaseReceiptRow[] }): React.ReactNode {
  return (
    <DataTable headers={['Received at', 'PO number', 'Vendor', 'Store', 'Reference', 'Received by', 'Lines']} empty="No receiving history recorded.">
      {rows.map((receipt) => (
        <tr key={receipt.id}>
          <td>{new Date(receipt.receivedAt).toLocaleString()}</td>
          <td>{receipt.purchaseOrder?.poNumber ?? '—'}</td>
          <td>{receipt.purchaseOrder?.vendor.name ?? '—'}</td>
          <td>{receipt.purchaseOrder?.store.name ?? '—'}</td>
          <td>{receipt.vendorReferenceNumber ?? '—'}</td>
          <td>
            {receipt.receivedBy.firstName} {receipt.receivedBy.lastName}
          </td>
          <td>{receipt.lines.map((line) => `${line.deliveredQuantity} delivered${line.damagedQuantity ? ` · ${line.damagedQuantity} damaged` : ''}${line.rejectedQuantity ? ` · ${line.rejectedQuantity} rejected` : ''}`).join('; ')}</td>
        </tr>
      ))}
    </DataTable>
  );
}
