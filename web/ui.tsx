import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { Priority, TaskStatus } from '../src/shared/types.js';

export type IconName =
  | 'plus'
  | 'grid'
  | 'arrow'
  | 'search'
  | 'chevron'
  | 'close'
  | 'check'
  | 'clock'
  | 'link'
  | 'comment'
  | 'box'
  | 'refresh'
  | 'activity'
  | 'download'
  | 'menu'
  | 'robot'
  | 'external'
  | 'alert'
  | 'branch'
  | 'play'
  | 'file'
  | 'settings'
  | 'layers';
const paths: Record<IconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  link: (
    <>
      <path d="m10 13 4-4M8 15l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m2 2 1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" />
    </>
  ),
  comment: <path d="M20 11.5a8 8 0 0 1-8 8H4l1.5-4A8 8 0 1 1 20 11.5Z" />,
  box: (
    <>
      <path d="m12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5M12 13v9M8 5l9 5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6.2 7a7 7 0 0 1 11.5-2L20 8M4 16l2.3 3A7 7 0 0 0 18 17" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  robot: (
    <>
      <rect x="4" y="7" width="16" height="13" rx="4" />
      <path d="M12 3v4M2 12v4m20-4v4M9 16h6" />
      <path d="M8 11h1m6 0h1" strokeWidth="3" />
    </>
  ),
  external: (
    <>
      <path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6" />
    </>
  ),
  alert: (
    <>
      <path d="m12 3 10 18H2L12 3Z" />
      <path d="M12 9v5m0 3v.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10m0-4h6a6 6 0 0 0 6-6" />
    </>
  ),
  play: <path d="m8 4 12 8-12 8V4Z" />,
  file: (
    <>
      <path d="M13 3H5v18h14V9l-6-6Zm0 0v6h6M8 13h8M8 17h6" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="8" cy="7" r="3" />
      <circle cx="16" cy="17" r="3" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5" />
    </>
  ),
};
export function Icon({
  name,
  size = 18,
  className = '',
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export const STATUS_LABEL: Record<TaskStatus, string> = {
  ready: '待领取',
  running: '进行中',
  review: '待验收',
  done: '已完成',
  blocked: '已阻塞',
  cancelled: '已取消',
};
export const PRIORITY_LABEL: Record<Priority, string> = {
  high: '高优先',
  normal: '普通',
  low: '低优先',
};
export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`status-badge ${status}`}>
      <span className="status-dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}
export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`priority-badge ${priority}`}>
      <span className="priority-bars">
        <i />
        <i />
        <i />
      </span>
      {PRIORITY_LABEL[priority]}
    </span>
  );
}
export function formatDate(value: string, short = false) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '未知时间'
    : new Intl.DateTimeFormat(
        'zh-CN',
        short
          ? { month: '2-digit', day: '2-digit' }
          : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false },
      ).format(date);
}
export function relativeTime(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return formatDate(value, true);
}
export function Empty({
  icon = 'box',
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={23} />
      </span>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
  optional = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  optional?: boolean;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {optional && <small>可选</small>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
export function Dialog({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  busy = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === 'Tab' && element) {
        const focusable = [
          ...element.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
          ),
        ].filter((item) => item.offsetParent !== null);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = oldOverflow;
      previous?.focus();
    };
  }, [busy]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <div className="modal-header">
          <div>
            <h2 id={id}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="关闭弹窗" onClick={onClose} disabled={busy}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function FormActions({
  onClose,
  busy,
  label,
  danger = false,
}: {
  onClose: () => void;
  busy: boolean;
  label: string;
  danger?: boolean;
}) {
  return (
    <div className="form-actions">
      <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
        取消
      </button>
      <button className={`button ${danger ? 'danger' : 'primary'}`} type="submit" disabled={busy}>
        {busy ? (
          <>
            <span className="spinner small" />
            正在保存…
          </>
        ) : (
          label
        )}
      </button>
    </div>
  );
}
