/** RJ POS wordmark for operator screens. Plain SVG, no external assets. */
export function BrandMark({ size = 30 }: { size?: number }): React.ReactNode {
  return <span className="brand" aria-label="RJ POS">
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#d29b3d" />
      <path d="M8 23V9h6.2c2.6 0 4.2 1.4 4.2 3.7 0 1.7-.9 2.9-2.4 3.4l2.8 6.9h-3L13.2 17H10.6v6H8Zm2.6-8.2h3.4c1.1 0 1.8-.6 1.8-1.6s-.7-1.6-1.8-1.6h-3.4v3.2Z" fill="#14261e" />
      <path d="M22 9h2.6v9.4c0 3-1.6 4.8-4.4 4.8-.6 0-1.2-.1-1.7-.3l.5-2.3c.3.1.6.2.9.2 1.4 0 2.1-.8 2.1-2.3V9Z" fill="#14261e" />
    </svg>
    <span className="brand-word">RJ <b>POS</b></span>
  </span>;
}
