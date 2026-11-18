import { ChevronDown, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SiliconEmployee } from '../../features/enterprise/types';
import { EmployeeFace } from './EmployeeFace';
import { useAnchoredPopover } from './use-anchored-popover';
import '../../styles/conversation-employee-picker.css';

interface Props {
  employees: SiliconEmployee[];
  employeeId: string;
  currentEmployee?: SiliconEmployee;
  currentName?: string;
  label?: string;
  disabled?: boolean;
  onChange: (employeeId: string) => void;
  onChoose?: () => void;
}

export function ConversationEmployeePicker({ employees, employeeId, currentEmployee, currentName, label, disabled = false, onChange, onChoose }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { root, popover, position } = useAnchoredPopover(open && !disabled, setOpen, true);
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const expanded = open && !disabled;
  const employee = currentEmployee ?? employees.find(item => item.id === employeeId);
  const name = currentName ?? employee?.name ?? '选择同事';
  const keyword = query.trim().toLowerCase();
  const found = employees.filter(item => [item.name, item.roleName, item.intro].some(value => value.toLowerCase().includes(keyword)));

  useEffect(() => { if (expanded) search.current?.focus(); }, [expanded]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const choose = (id: string) => {
    if (id !== employeeId) onChange(id);
    setOpen(false);
    if (onChoose) onChoose();
    else trigger.current?.focus();
  };

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const options = Array.from(popover.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    if (!options.length) return;
    event.preventDefault();
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (current + 1) % options.length : current <= 0 ? options.length - 1 : current - 1;
    options[next]?.focus();
  };

  return (
    <div className="ent-chat-who" ref={root}>
      <button type="button" className="ent-chat-whobtn" ref={trigger} title={name} aria-label={label} aria-expanded={expanded}
        aria-haspopup="dialog" aria-controls={expanded ? popoverId : undefined} disabled={disabled}
        onClick={() => { setQuery(''); setOpen(current => !current); }}>
        <EmployeeFace employee={employee} name={name} size="sm" round />
        <strong>{name}</strong>
        <ChevronDown size={14} aria-hidden className={expanded ? 'up' : undefined} />
      </button>
      {expanded ? createPortal(
        <div id={popoverId} className="ent-chat-pop" ref={popover} role="dialog" aria-label="选择员工" style={{ ...position, maxHeight: Math.min(420, position.maxHeight) }} onKeyDown={navigate}>
          <label className="ent-chat-find">
            <Search size={13} aria-hidden />
            <input ref={search} value={query} placeholder="搜索员工" aria-label="搜索员工" onChange={event => setQuery(event.target.value)} />
          </label>
          {found.length ? <ul role="listbox" aria-label="选择员工">
            {found.map(item => (
              <li key={item.id} role="presentation">
                <button type="button" role="option" aria-selected={item.id === employeeId} onClick={() => choose(item.id)}>
                  <EmployeeFace employee={item} size="sm" round />
                  <strong title={item.name}>{item.name}</strong>
                  <small title={item.roleName}>{item.roleName}</small>
                </button>
              </li>
            ))}
          </ul> : <p className="ent-chat-none" role="status">没有匹配的同事</p>}
        </div>, root.current?.closest('[aria-modal="true"]') ?? document.body,
      ) : null}
    </div>
  );
}
