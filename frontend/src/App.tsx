import { useEffect, useState } from 'react'
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import {
  ApiError,
  clearAuthStorage,
  getCurrentUser,
  loadStoredToken,
  loadStoredUser,
  logout,
  storeAuth,
  type User,
} from './api'
import ChatLayout from './pages/ChatLayout'
import LoginPage from './pages/LoginPage'
import NotFoundPage from './pages/NotFoundPage'
import PrivateRoute from './components/PrivateRoute'
import RegisterPage from './pages/RegisterPage'
import './App.css'

type RouteName = 'login' | 'signup' | 'chat' | 'not-found'
type AuthState = 'loading' | 'signed-out' | 'signed-in'

const theme = createTheme({
  palette: {
    primary: {
      main: '#0f766e',
    },
    secondary: {
      main: '#0ea5e9',
    },
  },
  shape: {
    borderRadius: 16,
  },
  typography: {
    fontFamily:
      "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
})

function resolveRoute(pathname: string): RouteName {
  if (pathname === '/signup') return 'signup'
  if (pathname === '/chat') return 'chat'
  if (pathname === '/login' || pathname === '/') return 'login'
  return 'not-found'
}

function pathForRoute(route: Exclude<RouteName, 'not-found'>) {
  return route === 'login' ? '/login' : `/${route}`
}

function App() {
  const [route, setRoute] = useState<RouteName>(() => resolveRoute(window.location.pathname))
  const [authState, setAuthState] = useState<AuthState>('loading')
  const [token, setToken] = useState<string | null>(() => loadStoredToken())
  const [user, setUser] = useState<User | null>(() => loadStoredUser())
  const [authNotice, setAuthNotice] = useState<string | null>(null)
  const [loginPrefill, setLoginPrefill] = useState('')

  useEffect(() => {
    const onPopState = () => {
      setRoute(resolveRoute(window.location.pathname))
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    const currentRoute = resolveRoute(window.location.pathname)
    if (currentRoute !== route) {
      setRoute(currentRoute)
    }
  }, [route])

  useEffect(() => {
    let active = true

    const bootstrapAuth = async () => {
      if (!token) {
        if (!active) return
        setUser(null)
        setAuthState('signed-out')
        return
      }

      try {
        const currentUser = await getCurrentUser(token)
        if (!active) return
        setUser(currentUser)
        setAuthState('signed-in')
        storeAuth(token, currentUser)
      } catch (error) {
        if (!active) return
        clearAuthStorage()
        setToken(null)
        setUser(null)
        setAuthState('signed-out')
        setAuthNotice(
          error instanceof ApiError && error.status === 401
            ? '세션이 만료되어 다시 로그인해 주세요.'
            : '로그인 상태를 확인하지 못했습니다.',
        )
      }
    }

    setAuthState('loading')
    bootstrapAuth()

    return () => {
      active = false
    }
  }, [token])

  useEffect(() => {
    if (authState === 'loading') {
      return
    }

    if (authState === 'signed-in') {
      if (route !== 'chat') {
        window.history.replaceState({}, '', pathForRoute('chat'))
        setRoute('chat')
      }
      return
    }

    if (route === 'chat') {
      window.history.replaceState({}, '', pathForRoute('login'))
      setRoute('login')
      return
    }

    if (route === 'not-found') {
      window.history.replaceState({}, '', pathForRoute('login'))
      setRoute('login')
    }
  }, [authState, route])

  const handleNavigate = (nextRoute: Exclude<RouteName, 'not-found'>) => {
    window.history.pushState({}, '', pathForRoute(nextRoute))
    setRoute(nextRoute)
  }

  const handleLoginSuccess = (nextToken: string, nextUser: User) => {
    storeAuth(nextToken, nextUser)
    setToken(nextToken)
    setUser(nextUser)
    setAuthNotice(null)
    setLoginPrefill('')
    window.history.replaceState({}, '', pathForRoute('chat'))
    setRoute('chat')
    setAuthState('signed-in')
  }

  const handleLogout = async () => {
    try {
      await logout(token)
    } finally {
      clearAuthStorage()
      setToken(null)
      setUser(null)
      setAuthState('signed-out')
      setAuthNotice('로그아웃되었습니다.')
      window.history.replaceState({}, '', pathForRoute('login'))
      setRoute('login')
    }
  }

  const handleSignUpSuccess = (username: string) => {
    setLoginPrefill(username)
    setAuthNotice('회원가입이 완료되었습니다. 바로 로그인해 주세요.')
    handleNavigate('login')
  }

  const handleSessionExpired = () => {
    clearAuthStorage()
    setToken(null)
    setUser(null)
    setAuthState('signed-out')
    setAuthNotice('세션이 만료되어 다시 로그인해 주세요.')
    window.history.replaceState({}, '', pathForRoute('login'))
    setRoute('login')
  }

  if (authState === 'loading') {
    return (
      <main className="app-shell">
        <section className="loading-panel">
          <p className="eyebrow">My Project</p>
          <h1>로그인 상태를 확인하는 중입니다.</h1>
          <p className="muted">잠시만 기다려 주세요.</p>
        </section>
      </main>
    )
  }

  if (route === 'signup') {
    return (
      <RegisterPage
        notice={authNotice}
        onSuccess={handleSignUpSuccess}
        onGoLogin={() => handleNavigate('login')}
      />
    )
  }

  if (route === 'login') {
    return (
      <LoginPage
        prefillUsername={loginPrefill}
        notice={authNotice}
        onSuccess={handleLoginSuccess}
        onGoSignUp={() => handleNavigate('signup')}
      />
    )
  }

  if (route === 'not-found') {
    return <NotFoundPage />
  }

  return (
    <PrivateRoute
      isAllowed={authState === 'signed-in' && Boolean(token)}
      fallback={
        <LoginPage
          prefillUsername={loginPrefill}
          notice={authNotice}
          onSuccess={handleLoginSuccess}
          onGoSignUp={() => handleNavigate('signup')}
        />
      }
    >
      <ChatLayout
        token={token ?? ''}
        user={user}
        onLogout={handleLogout}
        onSessionExpired={handleSessionExpired}
      />
    </PrivateRoute>
  )
}

function AppWithTheme() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  )
}

export default AppWithTheme
