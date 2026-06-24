import { Box, Button, Container, Paper, Stack, Typography } from '@mui/material'

function NotFoundPage() {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        py: 6,
        px: 2,
        background:
          'radial-gradient(circle at top left, rgba(14, 165, 233, 0.14), transparent 30%), radial-gradient(circle at bottom right, rgba(15, 118, 110, 0.12), transparent 28%), linear-gradient(180deg, #f8fafc 0%, #eef6fb 100%)',
      }}
    >
      <Container maxWidth="sm">
        <Paper elevation={4} sx={{ p: { xs: 3, md: 5 }, borderRadius: 4 }}>
          <Stack spacing={2.5} sx={{ alignItems: 'flex-start' }}>
            <Typography variant="overline" color="primary" sx={{ fontWeight: 800, letterSpacing: 1.2 }}>
              404
            </Typography>
            <Typography variant="h3" component="h1" sx={{ fontWeight: 800 }}>
              페이지를 찾을 수 없습니다.
            </Typography>
            <Typography variant="body1" color="text.secondary">
              로그인 또는 회원가입으로 이동해 주세요.
            </Typography>
            <Button variant="contained" href="/login">
              로그인으로 이동
            </Button>
          </Stack>
        </Paper>
      </Container>
    </Box>
  )
}

export default NotFoundPage
