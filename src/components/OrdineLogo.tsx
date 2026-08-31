export default function OrdineLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="28" height="28" rx="6" fill="var(--c-primary)"/>
      {/* Large arc r=12 */}
      <path d="M 26 14 A 12 12 0 1 1 14 2" stroke="var(--c-accent)" strokeWidth="2.4" strokeLinecap="round" fill="none"/>
      {/* Medium arc r=8.5 */}
      <path d="M 22.5 14 A 8.5 8.5 0 1 1 14 5.5" stroke="var(--c-accent)" strokeWidth="2.4" strokeLinecap="round" fill="none"/>
      {/* Small arc r=5 */}
      <path d="M 19 14 A 5 5 0 1 1 14 9" stroke="var(--c-accent)" strokeWidth="2.4" strokeLinecap="round" fill="none"/>
      {/* Free + in top-right gap */}
      <line x1="16.5" y1="7.5" x2="25.5" y2="7.5" stroke="var(--c-accent)" strokeWidth="2.4" strokeLinecap="round"/>
      <line x1="21" y1="3" x2="21" y2="12" stroke="var(--c-accent)" strokeWidth="2.4" strokeLinecap="round"/>
    </svg>
  );
}
