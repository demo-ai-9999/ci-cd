import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  Grid,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { login, type User } from '../api'

function AuthHero() {
  return (
    <Paper
      elevation={0}
      sx={{
        height: '100%',
        p: { xs: 3, md: 5 },
        color: 'common.white',
        background:
          'linear-gradient(145deg, rgba(15, 118, 110, 0.98), rgba(14, 165, 233, 0.88))',
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 4,
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(circle at top left, rgba(255, 255, 255, 0.22), transparent 28%), radial-gradient(circle at bottom right, rgba(255, 255, 255, 0.16), transparent 26%)',
          pointerEvents: 'none',
        }}
      />
      <Stack spacing={3} sx={{ position: 'relative', zIndex: 1, maxWidth: 600 }}>
        <Stack spacing={1}>
          <Chip
            label="Gemini Backend"
            sx={{
              alignSelf: 'flex-start',
              bgcolor: 'rgba(255, 255, 255, 0.18)',
              color: 'common.white',
              fontWeight: 700,
            }}
          />
          <Typography variant="h3" component="h1" sx={{ fontWeight: 800, lineHeight: 1.05 }}>
            로그인, 회원가입, 채팅이 한 흐름으로 이어집니다.
          </Typography>
          <Typography variant="body1" sx={{ color: 'rgba(255, 255, 255, 0.88)', maxWidth: 560 }}>
            백엔드 세션 토큰을 저장하고, 새로고침 후에도 인증 상태와 채팅 화면을
            복원합니다.
          </Typography>
        </Stack>
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
          {['Bearer 세션', '회원가입', '대화방 목록', '메시지 히스토리'].map((label) => (
            <Chip
              key={label}
              label={label}
              sx={{
                bgcolor: 'rgba(255, 255, 255, 0.16)',
                color: 'common.white',
                fontWeight: 600,
              }}
            />
          ))}
        </Stack>
      </Stack>
    </Paper>
  )
}

function AuthHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <Stack spacing={1}>
      <Chip
        label="My Project"
        size="small"
        sx={{ alignSelf: 'flex-start', fontWeight: 700, letterSpacing: 0.6 }}
      />
      <Typography variant="h4" component="h2" sx={{ fontWeight: 800 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {subtitle}
      </Typography>
    </Stack>
  )
}

type LoginPageProps = {
  prefillUsername: string
  notice: string | null
  onSuccess: (token: string, user: User) => void
  onGoSignUp: () => void
}

function LoginPage({ prefillUsername, notice, onSuccess, onGoSignUp }: LoginPageProps) {
  const [username, setUsername] = useState(prefillUsername)
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setUsername(prefillUsername)
  }, [prefillUsername])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return

    const trimmedUsername = username.trim()
    const trimmedPassword = password.trim()

    if (!trimmedUsername || !trimmedPassword) {
      setError('아이디와 비밀번호를 입력해 주세요.')
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const response = await login(trimmedUsername, trimmedPassword)
      onSuccess(response.access_token, response.user)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '로그인에 실패했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        py: { xs: 3, md: 6 },
        px: { xs: 2, sm: 3 },
        background:
          'radial-gradient(circle at top left, rgba(14, 165, 233, 0.14), transparent 30%), radial-gradient(circle at bottom right, rgba(15, 118, 110, 0.12), transparent 28%), linear-gradient(180deg, #f8fafc 0%, #eef6fb 100%)',
      }}
    >
      <Container maxWidth="lg">
        <Grid container spacing={3} sx={{ alignItems: 'stretch' }}>
          <Grid size={{ xs: 12, md: 7 }}>
            <AuthHero />
          </Grid>
          <Grid size={{ xs: 12, md: 5 }}>
            <Paper elevation={4} sx={{ p: { xs: 3, md: 4 }, borderRadius: 4, height: '100%' }}>
              <Stack spacing={3}>
                <AuthHeader
                  title="로그인"
                  subtitle="세션이 살아 있으면 새로고침 후에도 채팅 화면에 머뭅니다."
                />
                {notice ? <Alert severity="info">{notice}</Alert> : null}
                <Box component="form" onSubmit={handleSubmit}>
                  <Stack spacing={2}>
                    <TextField
                      label="아이디"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="username"
                      placeholder="username"
                      fullWidth
                    />
                    <TextField
                      label="비밀번호"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                      placeholder="password"
                      fullWidth
                    />

                    {error ? <Alert severity="error">{error}</Alert> : null}

                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                      <Button type="submit" variant="contained" disabled={submitting} fullWidth>
                        {submitting ? '로그인 중...' : '로그인'}
                      </Button>
                      <Button type="button" variant="outlined" onClick={onGoSignUp} fullWidth>
                        회원가입
                      </Button>
                    </Stack>
                  </Stack>
                </Box>
              </Stack>
            </Paper>
          </Grid>
        </Grid>
      </Container>
    </Box>
  )
}

export default LoginPage
