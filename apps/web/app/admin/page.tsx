'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminApi, createCatalogFlow, money, type Category, type Dashboard, type Employee, type InventoryRow, type MovementRow, type OrderRow, type Product, type RefundRow, type Store } from './admin-client';
import './admin.css';

const areas = ['Dashboard', 'Products', 'Categories', 'Inventory', 'Orders', 'Refunds', 'Employees', 'Stores', 'Registers', 'Settings'] as const;
type Area = typeof areas[number];
type RegisterRow = { id: string; name: string; code: string; status: string; store: Store; sessions: unknown[] };

export default function AdminPage(): React.ReactNode {
  const [area, setArea] = useState<Area>('Dashboard');
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
  const [stores, setStores] = useState<Store[]>([]);
  const [registers, setRegisters] = useState<RegisterRow[]>([]);
  const [audit, setAudit] = useState<Array<{ id: string; action: string; entityType: string; createdAt: string }>>([]);

  const load = useCallback(async (target = area, term = search) => {
    setLoading(true); setError('');
    try {
      if (target === 'Dashboard') setDashboard(await adminApi.dashboard());
      if (target === 'Products') { const [result, categoryResult, storeResult] = await Promise.all([adminApi.products(term), adminApi.categories(), adminApi.stores()]); setProducts(result.items); setCategories(categoryResult.items); setStores(storeResult); }
      if (target === 'Categories') setCategories((await adminApi.categories(term)).items);
      if (target === 'Inventory') setInventory((await adminApi.inventory(term)).items);
      if (target === 'Orders') setOrders((await adminApi.orders(term)).items);
      if (target === 'Refunds') setRefunds((await adminApi.refunds(term)).items);
      if (target === 'Employees') { const [employeeResult, storeResult] = await Promise.all([adminApi.employees(), adminApi.stores()]); setEmployees(employeeResult.items); setStores(storeResult); }
      if (target === 'Stores' || target === 'Settings') setStores(target === 'Settings' ? await adminApi.settings() : await adminApi.stores());
      if (target === 'Registers') { const [registerResult, storeResult] = await Promise.all([adminApi.registers(), adminApi.stores()]); setRegisters(registerResult); setStores(storeResult); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load this area.'); }
    finally { setLoading(false); }
  }, [area, search]);

  useEffect(() => { void load(); }, [load]);
  async function action(operation: () => Promise<unknown>, message: string): Promise<void> {
    setError(''); setNotice('');
    try { await operation(); setNotice(message); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Operation failed.'); }
  }
  function switchArea(next: Area): void { setArea(next); setSearch(''); setNotice(''); }

  return <main className="admin-shell">
    <aside className="admin-nav">
      <a className="admin-brand" href="/"><span className="eyebrow">RJ POS</span><strong>Back Office</strong></a>
      <nav aria-label="Back-office navigation">{areas.map((item) => <button className={area === item ? 'active' : ''} key={item} onClick={() => switchArea(item)}>{item}</button>)}</nav>
      <a className="register-link" href="/">Return to register</a>
    </aside>
    <section className="admin-main">
      <header className="admin-heading"><div><span className="eyebrow">Owner workspace</span><h1>{area}</h1></div>{['Products', 'Categories', 'Inventory', 'Orders', 'Refunds'].includes(area) && <form onSubmit={(event) => { event.preventDefault(); void load(area, search); }}><input aria-label={`Search ${area}`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${area.toLowerCase()}…`}/><button>Search</button></form>}</header>
      {error && <p role="alert" className="admin-alert error">{error}</p>}{notice && <p role="status" className="admin-alert success">{notice}</p>}
      {loading ? <div className="admin-empty">Loading authoritative data…</div> : <>
        {area === 'Dashboard' && (
          <DashboardView data={dashboard}/>
        )}
        {area === 'Categories' && (
          <CategoriesView categories={categories} run={action}/>
        )}
        {area === 'Products' && (
          <ProductsView products={products} categories={categories} stores={stores} run={action}/>
        )}
        {area === 'Inventory' && (
          <InventoryView rows={inventory} run={action}/>
        )}
        {area === 'Orders' && (
          <OrdersView rows={orders}/>
        )}
        {area === 'Refunds' && (
          <RefundsView rows={refunds}/>
        )}
        {area === 'Employees' && (
          <EmployeesView rows={employees} stores={stores} run={action}/>
        )}
        {area === 'Stores' && (
          <StoresView rows={stores} run={action}/>
        )}
        {area === 'Registers' && (
          <RegistersView rows={registers} stores={stores} run={action}/>
        )}
        {area === 'Settings' && (
          <SettingsView rows={stores} audit={audit} setAudit={setAudit} run={action}/>
        )}
      </>}
    </section>
  </main>;
}

function DashboardView({ data }: { data?: Dashboard }): React.ReactNode {
  if (!data) return <Empty label="No dashboard data is available."/>;
  const cards = [['Today’s sales', money(data.salesMinor)], ['Transactions', data.transactions], ['Refund total', money(data.refundMinor)], ['Open registers', data.openRegisters], ['Low-stock products', data.lowStockProducts]];
  return <div className="metric-grid">{cards.map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}</div>;
}

function CategoriesView({ categories, run }: { categories: Category[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  const [name, setName] = useState('');
  return <><form className="admin-form" onSubmit={(event) => { event.preventDefault(); void run(() => adminApi.createCategory(name), 'Category created.').then(() => setName('')); }}><label>Category name<input required value={name} onChange={(event) => setName(event.target.value)}/></label><button className="primary">Create category</button></form>
    <DataTable headers={['Category', 'Products', 'Status', 'Action']} empty="No categories match this search.">{categories.map((category) => <tr key={category.id}><td>{category.name}</td><td>{category._count?.products ?? 0}</td><td><Pill value={category.active ? 'ACTIVE' : 'INACTIVE'}/></td><td><button onClick={() => { const name = window.prompt('Category name', category.name); if (name) void run(() => adminApi.updateCategory(category.id, { name }), 'Category renamed.'); }}>Rename</button><button onClick={() => void run(() => adminApi.updateCategory(category.id, { active: !category.active }), `Category ${category.active ? 'deactivated' : 'activated'}.`)}>{category.active ? 'Deactivate' : 'Activate'}</button></td></tr>)}</DataTable></>;
}

function ProductsView({ products, categories, stores, run }: { products: Product[]; categories: Category[]; stores: Store[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  const [show, setShow] = useState(false);
  const [priceHistory, setPriceHistory] = useState<Array<{ id: string; amountMinor: string; effectiveFrom: string; effectiveTo: string | null }>>([]);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form);
    await run(() => createCatalogFlow({ categoryId: String(fields.get('categoryId')) || undefined, categoryName: String(fields.get('categoryName')) || undefined, productName: String(fields.get('productName')), brand: String(fields.get('brand')),
      variantName: String(fields.get('variantName')), sku: String(fields.get('sku')), barcode: String(fields.get('barcode')), storeId: String(fields.get('storeId')),
      priceMinor: String(fields.get('priceMinor')), openingQuantity: Number(fields.get('openingQuantity')), reason: String(fields.get('reason')), lowStockThreshold: Number(fields.get('threshold')) }), 'Product, variant, price, and opening inventory created.');
    form.reset(); setShow(false);
  }
  return <><div className="toolbar"><p>{products.length} products on this page</p><button className="primary" onClick={() => setShow(!show)}>{show ? 'Cancel' : 'New product'}</button></div>
    {show && <form className="admin-form wide" onSubmit={(event) => void submit(event)}><label>Existing category<select name="categoryId"><option value="">Create a new category</option>{categories.filter(({ active }) => active).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>New category<input name="categoryName" placeholder="Required if no existing category"/></label><label>Product name<input name="productName" required/></label><label>Brand<input name="brand"/></label><label>Variant<input name="variantName" required placeholder="750 ml"/></label><label>SKU<input name="sku" required/></label><label>UPC / barcode<input name="barcode" required/></label><label>Store<select name="storeId" required><option value="">Choose store</option>{stores.filter(({ status }) => status === 'ACTIVE').map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><label>Price, cents<input name="priceMinor" required inputMode="numeric"/></label><label>Opening quantity<input name="openingQuantity" required type="number" min="0"/></label><label>Low-stock threshold<input name="threshold" required type="number" min="0" defaultValue="2"/></label><label className="grow">Opening reason<input name="reason" required defaultValue="Opening count"/></label><button className="primary">Create sellable item</button></form>}
    {categories.length === 0 && <p className="hint">The workflow creates its category so a clean installation can be administered without seed changes.</p>}
    <DataTable headers={['Product', 'Category', 'Variants', 'Status', 'Actions']} empty="No products match this search.">{products.map((product) => <tr key={product.id}><td><strong>{product.name}</strong><small>{product.brand || 'No brand'}</small></td><td>{product.category.name}</td><td>{product.variants.map((variant) => <span className="stack" key={variant.id}>{variant.name} · {variant.sku} · {variant.barcodes[0]?.barcodeValue || 'No UPC'}</span>)}</td><td><Pill value={product.active ? 'ACTIVE' : 'INACTIVE'}/></td><td><button onClick={() => { const name = window.prompt('Product name', product.name); if (name) void run(() => adminApi.updateProduct(product.id, { name }), 'Product updated.'); }}>Edit</button><button onClick={() => void run(() => adminApi.updateProduct(product.id, { active: !product.active }), `Product ${product.active ? 'deactivated' : 'activated'}.`)}>{product.active ? 'Deactivate' : 'Activate'}</button>{product.variants[0] && <><button onClick={() => { const variant = product.variants[0]!; const name = window.prompt('Variant name', variant.name); const newSku = window.prompt('SKU', variant.sku); const barcode = window.prompt('UPC / barcode', variant.barcodes[0]?.barcodeValue ?? ''); if (name && newSku && barcode !== null) void run(() => adminApi.updateVariant(variant.id, { name, sku: newSku, barcode }), 'Variant updated.'); }}>Edit variant</button><button onClick={() => { const amountMinor = window.prompt('New price in cents'); if (amountMinor && stores[0]) void run(() => adminApi.schedulePrice({ variantId: product.variants[0]!.id, storeId: stores[0]!.id, amountMinor, effectiveFrom: new Date().toISOString() }), 'Future/current price scheduled; history preserved.'); }}>Schedule price</button><button onClick={() => void adminApi.priceHistory(product.variants[0]!.id, stores[0]?.id).then(setPriceHistory)}>Price history</button></>}</td></tr>)}</DataTable>{priceHistory.length > 0 && <DataTable headers={['Amount', 'Effective from', 'Effective to']} empty="No price history.">{priceHistory.map((price) => <tr key={price.id}><td>{money(price.amountMinor)}</td><td>{new Date(price.effectiveFrom).toLocaleString()}</td><td>{price.effectiveTo ? new Date(price.effectiveTo).toLocaleString() : 'Open-ended'}</td></tr>)}</DataTable>}</>;
}

function InventoryView({ rows, run }: { rows: InventoryRow[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  const [movements, setMovements] = useState<MovementRow[]>([]);
  return <><DataTable headers={['Item', 'Store', 'On hand', 'Reserved', 'Available', 'Status', 'Adjustment']} empty="No inventory matches this search.">{rows.map((row) => <tr key={row.id}><td><strong>{row.variant.product.name}</strong><small>{row.variant.name} · {row.variant.sku}</small></td><td>{row.store.name}</td><td>{row.onHand}</td><td>{row.reserved}</td><td>{row.available}</td><td><Pill value={row.inventoryStatus}/></td><td><button onClick={() => { const raw = window.prompt('Quantity change (negative for adjustment out)'); const reason = window.prompt('Required reason'); if (raw && reason) void run(() => adminApi.adjustInventory({ storeId: row.storeId, variantId: row.variant.id, quantityDelta: Number(raw), reason }), 'Inventory adjusted and ledger movement recorded.'); }}>Adjust</button><button onClick={() => void adminApi.movements(row.variant.id).then((result) => setMovements(result.items))}>History</button></td></tr>)}</DataTable>{movements.length > 0 && <><h2>Movement history</h2><DataTable headers={['Time', 'Item', 'Type', 'Quantity', 'Result', 'Employee', 'Reason / reference']} empty="No movements.">{movements.map((movement) => <tr key={movement.id}><td>{new Date(movement.createdAt).toLocaleString()}</td><td>{movement.variant.product.name}<small>{movement.store.name}</small></td><td>{movement.type}</td><td>{movement.quantityDelta}</td><td>{movement.resultingOnHand ?? '—'}</td><td>{movement.employee ? `${movement.employee.firstName} ${movement.employee.lastName}` : 'System'}</td><td>{movement.reason || `${movement.referenceType ?? ''} ${movement.referenceId ?? ''}`}</td></tr>)}</DataTable></>}</>;
}

function OrdersView({ rows }: { rows: OrderRow[] }): React.ReactNode { const [detail, setDetail] = useState<Record<string, unknown>>(); return <><DataTable headers={['Order', 'Date', 'Store / register', 'Cashier', 'Payment', 'Status', 'Total']} empty="No orders match this search.">{rows.map((order) => <tr key={order.id}><td><button onClick={() => void adminApi.order(order.id).then(setDetail)}>{order.orderNumber}</button></td><td>{new Date(order.createdAt).toLocaleString()}</td><td>{order.store.name}<small>{order.register.name}</small></td><td>{order.session.employee.firstName} {order.session.employee.lastName}</td><td>{order.payments[0]?.kind ?? '—'} · {order.payments[0]?.status ?? '—'}</td><td><Pill value={order.refunds.length ? 'REFUNDED' : order.status}/></td><td>{money(order.totalMinor)}</td></tr>)}</DataTable>{detail && <section className="order-detail"><h2>Order detail</h2><pre>{JSON.stringify(detail, null, 2)}</pre></section>}</>; }
function RefundsView({ rows }: { rows: RefundRow[] }): React.ReactNode { return <DataTable headers={['Refund', 'Original order', 'Employee', 'Reason', 'Status', 'Amount', 'Time']} empty="No refunds match this search.">{rows.map((refund) => <tr key={refund.id}><td>{refund.id.slice(0, 8)}</td><td>{refund.order.orderNumber}</td><td>{refund.employee.firstName} {refund.employee.lastName}</td><td>{refund.reason}</td><td><Pill value={refund.status}/></td><td>{money(refund.amountMinor)}</td><td>{new Date(refund.createdAt).toLocaleString()}</td></tr>)}</DataTable>; }

function EmployeesView({ rows, stores, run }: { rows: Employee[]; stores: Store[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> { event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form); await run(() => adminApi.createEmployee({ firstName: String(fields.get('firstName')), lastName: String(fields.get('lastName')), roleNames: [String(fields.get('role'))], storeIds: [String(fields.get('storeId'))] }), 'Employee created and assigned.'); form.reset(); }
  return <><form className="admin-form" onSubmit={(event) => void submit(event)}><label>First name<input name="firstName" required/></label><label>Last name<input name="lastName" required/></label><label>Role<select name="role"><option>CASHIER</option><option>MANAGER</option><option>OWNER</option></select></label><label>Store<select name="storeId" required><option value="">Choose store</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><button className="primary">Create employee</button></form><DataTable headers={['Employee', 'Role', 'Stores', 'Status', 'Actions']} empty="No employees found.">{rows.map((employee) => <tr key={employee.id}><td>{employee.firstName} {employee.lastName}</td><td>{employee.roles.map(({ role }) => role.name).join(', ')}</td><td>{employee.stores.map(({ store }) => store.name).join(', ')}</td><td><Pill value={employee.status}/></td><td><button onClick={() => { const firstName = window.prompt('First name', employee.firstName); const lastName = window.prompt('Last name', employee.lastName); if (firstName && lastName) void run(() => adminApi.updateEmployee(employee.id, { firstName, lastName }), 'Employee updated.'); }}>Edit</button><button onClick={() => { const role = window.prompt('Role: OWNER, MANAGER, or CASHIER', employee.roles[0]?.role.name); if (role) void run(() => adminApi.updateEmployee(employee.id, { roleNames: [role] }), 'Employee role updated.'); }}>Change role</button><button onClick={() => void run(() => adminApi.updateEmployee(employee.id, { status: employee.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }), 'Employee lifecycle updated.')}>{employee.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</button></td></tr>)}</DataTable></>;
}

function StoresView({ rows, run }: { rows: Store[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> { event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form); await run(() => adminApi.createStore({ name: String(fields.get('name')), timezone: String(fields.get('timezone')), taxRateBasisPoints: Number(fields.get('tax')) }), 'Store created.'); form.reset(); }
  return <><form className="admin-form" onSubmit={(event) => void submit(event)}><label>Store name<input name="name" required/></label><label>Timezone<input name="timezone" required defaultValue="America/New_York"/></label><label>Tax basis points<input name="tax" required type="number" min="0" max="10000"/></label><button className="primary">Create store</button></form><DataTable headers={['Store', 'Timezone', 'Tax', 'Status', 'Action']} empty="No stores found.">{rows.map((store) => <tr key={store.id}><td>{store.name}</td><td>{store.timezone}</td><td>{(store.taxRateBasisPoints / 100).toFixed(2)}%</td><td><Pill value={store.status}/></td><td><button onClick={() => { const name = window.prompt('Store name', store.name); const timezone = window.prompt('IANA timezone', store.timezone); const tax = window.prompt('Tax basis points', String(store.taxRateBasisPoints)); if (name && timezone && tax) void run(() => adminApi.updateStore(store.id, { name, timezone, taxRateBasisPoints: Number(tax) }), 'Store updated.'); }}>Edit</button><button onClick={() => void run(() => adminApi.updateStore(store.id, { status: store.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }), 'Store lifecycle updated.')}>{store.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</button></td></tr>)}</DataTable></>;
}

function RegistersView({ rows, stores, run }: { rows: RegisterRow[]; stores: Store[]; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> { event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form); await run(() => adminApi.createRegister({ storeId: String(fields.get('storeId')), name: String(fields.get('name')), code: String(fields.get('code')) }), 'Register created.'); form.reset(); }
  return <><form className="admin-form" onSubmit={(event) => void submit(event)}><label>Register name<input name="name" required/></label><label>Code<input name="code" required/></label><label>Store<select name="storeId" required><option value="">Choose store</option>{stores.filter(({ status }) => status === 'ACTIVE').map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><button className="primary">Create register</button></form><DataTable headers={['Register', 'Code', 'Store', 'Session', 'Status', 'Action']} empty="No registers found.">{rows.map((register) => <tr key={register.id}><td>{register.name}</td><td>{register.code}</td><td>{register.store.name}</td><td>{register.sessions.length ? 'OPEN' : 'CLOSED'}</td><td><Pill value={register.status}/></td><td><button onClick={() => { const name = window.prompt('Register name', register.name); const code = window.prompt('Register code', register.code); if (name && code) void run(() => adminApi.updateRegister(register.id, { name, code }), 'Register updated.'); }}>Edit</button><button onClick={() => void run(() => adminApi.updateRegister(register.id, { status: register.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }), 'Register lifecycle updated.')}>{register.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</button></td></tr>)}</DataTable></>;
}

function SettingsView({ rows, audit, setAudit, run }: { rows: Store[]; audit: Array<{ id: string; action: string; entityType: string; createdAt: string }>; setAudit: (rows: Array<{ id: string; action: string; entityType: string; createdAt: string }>) => void; run: (operation: () => Promise<unknown>, message: string) => Promise<void> }): React.ReactNode {
  return <><div className="settings-grid">{rows.map((store) => <article key={store.id}><h2>{store.name}</h2><p>{store.timezone} · {(store.taxRateBasisPoints / 100).toFixed(2)}% tax</p><p>Receipt footer: {store.receiptFooter || 'Not set'}</p><button onClick={() => { const receiptFooter = window.prompt('Receipt footer', store.receiptFooter ?? ''); if (receiptFooter !== null) void run(() => adminApi.updateStore(store.id, { receiptFooter }), 'Store settings updated.'); }}>Edit receipt settings</button></article>)}</div><div className="toolbar"><h2>Audit history</h2><button onClick={() => void adminApi.audit().then((result) => setAudit(result.items))}>Load audit history</button></div><DataTable headers={['Action', 'Entity', 'Time']} empty="Load audit history to review immutable administrative actions.">{audit.map((record) => <tr key={record.id}><td>{record.action}</td><td>{record.entityType}</td><td>{new Date(record.createdAt).toLocaleString()}</td></tr>)}</DataTable></>;
}

function DataTable({ headers, empty, children }: { headers: string[]; empty: string; children: React.ReactNode }): React.ReactNode { const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children); return <div className="admin-table-wrap">{hasRows ? <table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table> : <Empty label={empty}/>}</div>; }
function Empty({ label }: { label: string }): React.ReactNode { return <div className="admin-empty">{label}</div>; }
function Pill({ value }: { value: string }): React.ReactNode { return <span className={`pill ${value.includes('LOW') || value.includes('INACTIVE') ? 'warn' : ''}`}>{value.replaceAll('_', ' ')}</span>; }
