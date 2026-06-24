import type { ReactNode } from 'react'

type PrivateRouteProps = {
  isAllowed: boolean
  fallback: ReactNode
  children: ReactNode
}

function PrivateRoute({ isAllowed, fallback, children }: PrivateRouteProps) {
  if (!isAllowed) {
    return fallback
  }

  return children
}

export default PrivateRoute
