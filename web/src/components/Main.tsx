import type { ComponentPropsWithoutRef, ReactNode } from 'react'

export interface MainProps extends ComponentPropsWithoutRef<'main'> {
  children?: ReactNode
}

/**
 * Standard main content wrapper. Provides id="main-content" and tabIndex={-1}
 * for dependable skip-link targeting across all browsers (including Safari).
 */
export function Main({ className = 'page', children, ...props }: MainProps) {
  return (
    <main id="main-content" tabIndex={-1} className={className} {...props}>
      {children}
    </main>
  )
}
