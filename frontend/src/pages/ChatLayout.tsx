import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Divider,
  Grid,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import {
  ApiError,
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  loadLastChatSessionId,
  loadLocalChatMessages,
  sendChatMessage,
  sendSearchQuery,
  storeLastChatSessionId,
  storeLocalChatMessages,
  type ChatMessage,
  type ChatSessionDetail,
  type ChatSessionSummary,
  type User,
} from '../api'

const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatDate(value: string) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed)
}

function roleMeta(role: ChatMessage['role']) {
  if (role === 'user') {
    return { label: '나', color: 'primary' as const }
  }

  if (role === 'assistant') {
    return { label: 'Gemini', color: 'secondary' as const }
  }

  return { label: '시스템', color: 'default' as const }
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const meta = roleMeta(message.role)

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2,
        bgcolor:
          message.role === 'user'
            ? 'rgba(15, 118, 110, 0.05)'
            : message.role === 'assistant'
              ? 'rgba(14, 165, 233, 0.05)'
              : 'background.paper',
        borderColor:
          message.role === 'user'
            ? 'rgba(15, 118, 110, 0.22)'
            : message.role === 'assistant'
              ? 'rgba(14, 165, 233, 0.22)'
              : 'divider',
      }}
    >
      <Stack spacing={1}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', gap: 2 }}>
          <Chip label={meta.label} color={meta.color} size="small" />
          <Typography variant="caption" color="text.secondary">
            {formatDate(message.created_at)}
          </Typography>
        </Stack>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {message.content}
        </Typography>
      </Stack>
    </Paper>
  )
}

type ChatLayoutProps = {
  token: string
  user: User | null
  onLogout: () => Promise<void>
  onSessionExpired: () => void
}

function createSyntheticMessage(
  role: ChatMessage['role'],
  content: string,
  id: number,
  createdAt: string,
): ChatMessage {
  return {
    id,
    role,
    content,
    model: 'local-search',
    created_at: createdAt,
  }
}

function formatSearchAnswer(response: {
  answer: string
  results: Array<{ title: string; link: string; snippet: string }>
}) {
  const sources = response.results
    .map((result, index) => {
      const lines = [
        `${index + 1}. ${result.title}`,
        result.link,
        result.snippet,
      ].filter(Boolean)
      return lines.join('\n')
    })
    .join('\n\n')

  return sources ? `${response.answer}\n\n참고한 출처\n${sources}` : response.answer
}

function ChatLayout({ token, user, onLogout, onSessionExpired }: ChatLayoutProps) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(() => loadLastChatSessionId())
  const [sessionDetail, setSessionDetail] = useState<ChatSessionDetail | null>(null)
  const [newSessionTitle, setNewSessionTitle] = useState('')
  const [messageDraft, setMessageDraft] = useState('')
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [localMessagesBySessionId, setLocalMessagesBySessionId] = useState<Record<number, ChatMessage[]>>(() =>
    loadLocalChatMessages(),
  )
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const mergeMessages = (baseMessages: ChatMessage[], sessionId: number) => {
    const localMessages = localMessagesBySessionId[sessionId] ?? []
    if (localMessages.length === 0) {
      return baseMessages
    }

    return [...baseMessages, ...localMessages].sort((left, right) => {
      const timeDelta = new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
      if (timeDelta !== 0) {
        return timeDelta
      }
      return left.id - right.id
    })
  }

  useEffect(() => {
    storeLocalChatMessages(localMessagesBySessionId)
  }, [localMessagesBySessionId])

  const reloadSessions = async (preferredSessionId: number | null = null) => {
    const sessionList = await listChatSessions(token)

    if (sessionList.length === 0) {
      const created = await createChatSession(token, '기본 대화')
      setSessions([created])
      setSelectedSessionId(created.id)
      storeLastChatSessionId(created.id)
      return created.id
    }

    setSessions(sessionList)

    const storedSessionId = preferredSessionId ?? loadLastChatSessionId() ?? sessionList[0].id
    const nextSelected = sessionList.some((item) => item.id === storedSessionId)
      ? storedSessionId
      : sessionList[0].id

    setSelectedSessionId(nextSelected)
    storeLastChatSessionId(nextSelected)
    return nextSelected
  }

  const loadSessionDetail = async (sessionId: number) => {
    const detail = await getChatSession(token, sessionId)
    setSessionDetail({
      ...detail,
      messages: mergeMessages(detail.messages, sessionId),
    })
    setActionError(null)
    return detail
  }

  useEffect(() => {
    let cancelled = false
    setSessionsLoading(true)
    setActionError(null)

    const bootstrap = async () => {
      try {
        const nextSelected = await reloadSessions()
        if (cancelled) return
        if (nextSelected !== null) {
          await loadSessionDetail(nextSelected)
        }
      } catch (error) {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired()
          return
        }
        setActionError(error instanceof Error ? error.message : '대화방 목록을 불러오지 못했습니다.')
      } finally {
        if (!cancelled) {
          setSessionsLoading(false)
        }
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    if (selectedSessionId === null) {
      return
    }

    let cancelled = false
    setDetailLoading(true)

    const loadDetail = async () => {
      try {
        await loadSessionDetail(selectedSessionId)
      } catch (error) {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired()
          return
        }
        setActionError(error instanceof Error ? error.message : '대화방 상세를 불러오지 못했습니다.')
      } finally {
        if (!cancelled) {
          setDetailLoading(false)
        }
      }
    }

    loadDetail()
    return () => {
      cancelled = true
    }
  }, [selectedSessionId, token])

  const handleCreateSession = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const title = newSessionTitle.trim() || null

    try {
      const created = await createChatSession(token, title)
      setSessions((current) => [created, ...current])
      setSelectedSessionId(created.id)
      storeLastChatSessionId(created.id)
      setNewSessionTitle('')
      await loadSessionDetail(created.id)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired()
        return
      }
      setActionError(error instanceof Error ? error.message : '대화방을 만들지 못했습니다.')
    }
  }

  const handleSelectSession = (sessionId: number) => {
    setSelectedSessionId(sessionId)
    storeLastChatSessionId(sessionId)
  }

  const handleSendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (sending) return

    const trimmedMessage = messageDraft.trim()
    if (!trimmedMessage) return

    setSending(true)
    setActionError(null)

    try {
      if (isSearchMode) {
        let activeSessionId = selectedSessionId
        if (activeSessionId === null) {
          const created = await createChatSession(token, '정보 검색')
          setSessions((current) => [created, ...current])
          setSelectedSessionId(created.id)
          storeLastChatSessionId(created.id)
          activeSessionId = created.id
          await loadSessionDetail(created.id)
        }

        const response = await sendSearchQuery(token, trimmedMessage)
        const createdAt = new Date().toISOString()
        const localMessageBaseId = -Date.now() * 2
        const userMessage = createSyntheticMessage(
          'user',
          `[검색요청] ${trimmedMessage}`,
          localMessageBaseId,
          createdAt,
        )
        const assistantMessage = createSyntheticMessage(
          'assistant',
          formatSearchAnswer(response),
          localMessageBaseId + 1,
          createdAt,
        )

        setLocalMessagesBySessionId((current) => {
          const nextMessages = current[activeSessionId] ?? []
          const mergedMessages = [...nextMessages, userMessage, assistantMessage]
          return {
            ...current,
            [activeSessionId]: mergedMessages,
          }
        })

        setSessionDetail((current) =>
          current && current.id === activeSessionId
            ? {
                ...current,
                messages: [...current.messages, userMessage, assistantMessage],
                updated_at: new Date().toISOString(),
              }
            : current,
        )

        setSessions((current) =>
          current.map((session) =>
            session.id === activeSessionId
              ? {
                  ...session,
                  updated_at: new Date().toISOString(),
                }
              : session,
          ),
        )
      } else {
        if (selectedSessionId === null) return
        await sendChatMessage(token, selectedSessionId, trimmedMessage)
        await Promise.all([loadSessionDetail(selectedSessionId), reloadSessions(selectedSessionId)])
      }

      setMessageDraft('')
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired()
        return
      }
      setActionError(error instanceof Error ? error.message : '메시지를 전송하지 못했습니다.')
    } finally {
      setSending(false)
    }
  }

  const handleArchiveSession = async () => {
    if (selectedSessionId === null) return

    const confirmed = window.confirm('이 대화방을 보관하시겠습니까?')
    if (!confirmed) return

    try {
      await deleteChatSession(token, selectedSessionId)
      const nextSelected = await reloadSessions()
      if (nextSelected !== null) {
        await loadSessionDetail(nextSelected)
      } else {
        setSessionDetail(null)
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired()
        return
      }
      setActionError(error instanceof Error ? error.message : '대화방을 보관하지 못했습니다.')
    }
  }

  const selectedSession = sessions.find((item) => item.id === selectedSessionId) ?? null
  const chatLocked = !selectedSession || selectedSession.is_archived

  return (
    <Box
      sx={{
        minHeight: '100vh',
        py: { xs: 2, md: 3 },
        px: { xs: 1.5, sm: 2 },
        background:
          'radial-gradient(circle at top left, rgba(14, 165, 233, 0.14), transparent 30%), radial-gradient(circle at bottom right, rgba(15, 118, 110, 0.12), transparent 28%), linear-gradient(180deg, #f8fafc 0%, #eef6fb 100%)',
      }}
    >
      <Container maxWidth="xl">
        <Grid container spacing={2.5} sx={{ alignItems: 'stretch' }}>
          <Grid size={{ xs: 12, lg: 3 }}>
            <Paper elevation={3} sx={{ p: 2.5, borderRadius: 4, height: '100%' }}>
              <Stack spacing={2.5}>
                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 2 }}>
                  <Box>
                    <Chip label="채팅" color="primary" size="small" />
                    <Typography variant="h5" component="h1" sx={{ mt: 1, fontWeight: 800 }}>
                      대화방
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {user ? `${user.username} 님, 환영합니다.` : '인증된 사용자만 접근할 수 있습니다.'}
                    </Typography>
                  </Box>
                  <Button variant="outlined" onClick={onLogout} size="small">
                    로그아웃
                  </Button>
                </Stack>

                <Box component="form" onSubmit={handleCreateSession}>
                  <Stack spacing={1.5}>
                    <TextField
                      label="새 대화방 제목"
                      value={newSessionTitle}
                      onChange={(event) => setNewSessionTitle(event.target.value)}
                      placeholder="예: 프로젝트 정리"
                      fullWidth
                    />
                    <Button type="submit" variant="contained" fullWidth>
                      새 대화방 만들기
                    </Button>
                  </Stack>
                </Box>

                <Divider />

                <Box>
                  <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      대화 목록
                    </Typography>
                    {sessionsLoading ? <CircularProgress size={18} /> : null}
                  </Stack>

                  {sessionsLoading ? (
                    <Typography variant="body2" color="text.secondary">
                      대화방 목록을 불러오는 중입니다.
                    </Typography>
                  ) : sessions.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      아직 대화방이 없습니다.
                    </Typography>
                  ) : (
                    <List disablePadding sx={{ display: 'grid', gap: 1 }}>
                      {sessions.map((session) => {
                        const selected = session.id === selectedSessionId
                        return (
                          <ListItemButton
                            key={session.id}
                            selected={selected}
                            onClick={() => handleSelectSession(session.id)}
                            sx={{
                              borderRadius: 2,
                              border: '1px solid',
                              borderColor: selected ? 'primary.main' : 'divider',
                              alignItems: 'flex-start',
                            }}
                          >
                            <ListItemText
                              primary={
                                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                    {session.title}
                                  </Typography>
                                  {session.is_archived ? (
                                    <Chip label="보관됨" size="small" variant="outlined" />
                                  ) : null}
                                </Stack>
                              }
                              secondary={
                                <Typography variant="caption" color="text.secondary">
                                  {formatDate(session.updated_at)}
                                </Typography>
                              }
                            />
                          </ListItemButton>
                        )
                      })}
                    </List>
                  )}
                </Box>
              </Stack>
            </Paper>
          </Grid>

          <Grid size={{ xs: 12, lg: 9 }}>
            <Paper elevation={3} sx={{ p: { xs: 2.5, md: 3 }, borderRadius: 4, height: '100%' }}>
              <Stack spacing={2.5} sx={{ height: '100%' }}>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  sx={{ justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' }, gap: 2 }}
                >
                  <Box>
                    <Chip label="Gemini Chat" color="secondary" size="small" />
                    <Typography variant="h5" component="h2" sx={{ mt: 1, fontWeight: 800 }}>
                      {selectedSession?.title ?? '대화방을 선택해 주세요'}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {selectedSession
                        ? `${selectedSession.is_archived ? '보관된 대화방입니다.' : '메시지를 보내면 최근 맥락을 포함해 답변합니다.'} · ${formatDate(selectedSession.updated_at)}`
                        : '로그인 후 대화방 목록이 표시됩니다.'}
                    </Typography>
                  </Box>

                  <Button
                    variant="outlined"
                    onClick={handleArchiveSession}
                    disabled={!selectedSession || selectedSession.is_archived}
                  >
                    보관
                  </Button>
                </Stack>

                {actionError ? <Alert severity="error">{actionError}</Alert> : null}

                <Paper
                  variant="outlined"
                  sx={{
                    flex: 1,
                    minHeight: 380,
                    p: 2,
                    bgcolor: 'rgba(255, 255, 255, 0.72)',
                    overflow: 'auto',
                  }}
                >
                  <Stack spacing={1.5}>
                    {detailLoading ? (
                      <Stack sx={{ alignItems: 'center', justifyContent: 'center', py: 8 }}>
                        <CircularProgress />
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                          메시지를 불러오는 중입니다.
                        </Typography>
                      </Stack>
                    ) : sessionDetail?.messages.length ? (
                      sessionDetail.messages.map((message) => (
                        <MessageBubble key={message.id} message={message} />
                      ))
                    ) : (
                      <Stack sx={{ alignItems: 'center', justifyContent: 'center', py: 8, textAlign: 'center' }}>
                        <Avatar
                          sx={{
                            bgcolor: 'primary.main',
                            mb: 2,
                            width: 56,
                            height: 56,
                          }}
                        >
                          G
                        </Avatar>
                        <Typography variant="h6" sx={{ fontWeight: 800 }}>
                          아직 대화가 없습니다.
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: 420 }}>
                          메시지를 보내면 이 공간에 사용자와 어시스턴트의 대화가 쌓입니다.
                        </Typography>
                      </Stack>
                    )}
                  </Stack>
                </Paper>

                <Box component="form" onSubmit={handleSendMessage}>
                  <Stack spacing={1.5}>
                    <Stack direction="row" sx={{ alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                      <Button
                        type="button"
                        variant={isSearchMode ? 'contained' : 'outlined'}
                        color={isSearchMode ? 'secondary' : 'primary'}
                        onClick={() => {
                          setIsSearchMode((current) => {
                            return !current
                          })
                          setActionError(null)
                        }}
                      >
                        [정보 검색]
                      </Button>
                      <Typography variant="body2" color="text.secondary">
                        {isSearchMode ? '검색 모드로 요청합니다.' : '일반 채팅 모드로 요청합니다.'}
                      </Typography>
                    </Stack>

                    <TextField
                      label="메시지"
                      value={messageDraft}
                      onChange={(event) => setMessageDraft(event.target.value)}
                      placeholder="Gemini에게 질문을 입력하세요."
                      multiline
                      minRows={5}
                      disabled={chatLocked}
                      fullWidth
                    />

                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: 'center' }}>
                      <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                        {isSearchMode
                          ? '검색 모드에서는 정보 검색 백엔드 엔드포인트를 사용합니다.'
                          : selectedSession?.is_archived
                            ? '보관된 대화방에는 메시지를 보낼 수 없습니다.'
                            : '최근 대화 맥락을 함께 전송합니다.'}
                      </Typography>
                      <Button
                        type="submit"
                        variant="contained"
                        disabled={
                          sending ||
                          !messageDraft.trim() ||
                          chatLocked
                        }
                      >
                        {sending ? '전송 중...' : isSearchMode ? '검색하기' : '메시지 보내기'}
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

export default ChatLayout
