'use client';
import { useState, type FormEvent } from 'react';
import { adminApi, type Employee, type Store } from './admin-client';

/** Edit name, role, stores, and (re)set the PIN. The current PIN is stored hashed and cannot be shown. */
export function EmployeeEditor({ employee, stores, run, onClose }: {
  employee: Employee; stores: Store[]; onClose: () => void;
  run: (operation: () => Promise<unknown>, message: string) => Promise<void>;
}): React.ReactNode {
  const [firstName, setFirstName] = useState(employee.firstName);
  const [lastName, setLastName] = useState(employee.lastName);
  const [role, setRole] = useState(employee.roles[0]?.role.name ?? 'CASHIER');
  const [storeIds, setStoreIds] = useState(new Set(employee.stores.map(({ store }) => store.id)));
  const [pin, setPin] = useState('');
  const pinValid = pin === '' || /^\d{4,8}$/.test(pin);
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    await run(async () => {
      await adminApi.updateEmployee(employee.id, { firstName, lastName, roleNames: [role], storeIds: [...storeIds] });
      if (pin) await adminApi.setEmployeePin(employee.id, pin);
    }, pin ? 'Employee saved and PIN reset.' : 'Employee saved.');
    onClose();
  }
  return <form className="admin-form" aria-label={`Manage ${employee.firstName} ${employee.lastName}`} onSubmit={(event) => void save(event)}>
    <h3>Manage {employee.firstName} {employee.lastName}</h3>
    <label>First name<input value={firstName} onChange={(event) => setFirstName(event.target.value)} required /></label>
    <label>Last name<input value={lastName} onChange={(event) => setLastName(event.target.value)} required /></label>
    <label>Role<select value={role} onChange={(event) => setRole(event.target.value)}><option>CASHIER</option><option>MANAGER</option><option>OWNER</option></select></label>
    <fieldset><legend>Stores</legend>{stores.map((store) => <label key={store.id}><input type="checkbox" checked={storeIds.has(store.id)} onChange={(event) => setStoreIds((current) => { const next = new Set(current); if (event.target.checked) next.add(store.id); else next.delete(store.id); return next; })} /> {store.name}</label>)}</fieldset>
    <label>{employee.hasPin ? 'Reset PIN' : 'Set PIN'} (4–8 digits, leave blank to keep)<input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))} /></label>
    {!pinValid && <p role="alert">PIN must be 4 to 8 digits.</p>}
    <button className="primary" disabled={!pinValid || storeIds.size === 0}>Save</button> <button type="button" onClick={onClose}>Cancel</button>
  </form>;
}
