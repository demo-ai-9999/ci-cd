import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'
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
  LinearProgress,
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
  uploadDocumentSummary,
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

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern =
    /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(`[^`]+`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(__([^_]+)__)|(_([^_]+)_)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }

    if (match[2] && match[3]) {
      nodes.push(
        <a key={`${match.index}-link`} href={match[3]} target="_blank" rel="noreferrer">
          {match[2]}
        </a>,
      )
    } else if (match[4]) {
      nodes.push(
        <code key={`${match.index}-code`} style={{ padding: '0 0.25rem', background: 'rgba(15, 23, 42, 0.08)', borderRadius: 4 }}>
          {match[4].slice(1, -1)}
        </code>,
      )
    } else if (match[6]) {
      nodes.push(<strong key={`${match.index}-bold`}>{match[6]}</strong>)
    } else if (match[8]) {
      nodes.push(<em key={`${match.index}-italic1`}>{match[8]}</em>)
    } else if (match[10]) {
      nodes.push(<strong key={`${match.index}-bold2`}>{match[10]}</strong>)
    } else if (match[12]) {
      nodes.push(<em key={`${match.index}-italic2`}>{match[12]}</em>)
    }

    lastIndex = pattern.lastIndex
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}

function MarkdownContent({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) {
      index += 1
      continue
    }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim()
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !lines[index].startsWith('```')) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) {
        index += 1
      }

      blocks.push(
        <Box
          key={`${index}-codeblock`}
          component="pre"
          sx={{
            m: 0,
            p: 1.5,
            borderRadius: 2,
            overflowX: 'auto',
            bgcolor: 'rgba(15, 23, 42, 0.06)',
            border: '1px solid',
            borderColor: 'divider',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            whiteSpace: 'pre-wrap',
          }}
        >
          {language ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>{language}</Typography> : null}
          <code>{codeLines.join('\n')}</code>
        </Box>,
      )
      continue
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const headingVariant = (
        level === 1
          ? 'h3'
          : level === 2
            ? 'h4'
            : level === 3
              ? 'h5'
              : 'h6'
      ) as 'h3' | 'h4' | 'h5' | 'h6'
      blocks.push(
        <Typography key={`${index}-heading`} variant={headingVariant} sx={{ fontWeight: 800, mt: 0.5 }}>
          {renderInlineMarkdown(headingMatch[2])}
        </Typography>,
      )
      index += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push(
        <Box
          key={`${index}-quote`}
          sx={{
            borderLeft: '4px solid',
            borderColor: 'primary.main',
            pl: 2,
            py: 1,
            bgcolor: 'rgba(14, 165, 233, 0.05)',
            borderRadius: 1,
          }}
        >
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
            {renderInlineMarkdown(quoteLines.join('\n'))}
          </Typography>
        </Box>,
      )
      continue
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2])
      const items: string[] = []
      while (index < lines.length) {
        const current = lines[index]
        const currentMatch = current.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
        if (!currentMatch) break
        items.push(currentMatch[3])
        index += 1
      }

      blocks.push(
        <Box key={`${index}-list`} component={ordered ? 'ol' : 'ul'} sx={{ pl: 3, my: 0 }}>
          {items.map((item, itemIndex) => (
            <li key={`${index}-item-${itemIndex}`}>
              <Typography variant="body2" component="span">
                {renderInlineMarkdown(item)}
              </Typography>
            </li>
          ))}
        </Box>,
      )
      continue
    }

    const paragraphLines: string[] = [line]
    index += 1
    while (index < lines.length && lines[index].trim() && !lines[index].startsWith('```')) {
      const nextLine = lines[index]
      if (/^(#{1,6})\s+/.test(nextLine) || /^>\s?/.test(nextLine) || /^(\s*)([-*+]|\d+\.)\s+/.test(nextLine)) {
        break
      }
      paragraphLines.push(nextLine)
      index += 1
    }

    blocks.push(
      <Typography key={`${index}-paragraph`} variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {renderInlineMarkdown(paragraphLines.join('\n'))}
      </Typography>,
    )
  }

  return <Stack spacing={1}>{blocks}</Stack>
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
        <MarkdownContent content={message.content} />
      </Stack>
    </Paper>
  )
}

function isDocumentUploadUserMessage(message: ChatMessage) {
  return message.role === 'user' && message.content.startsWith('[파일 업로드] ')
}

function isDocumentUploadSystemMessage(message: ChatMessage) {
  return message.role === 'system' && message.content.startsWith('[문서 내용 ')
}

function getDisplayMessages(messages: ChatMessage[]) {
  return messages.reduce<ChatMessage[]>((visibleMessages, message, index) => {
    if (isDocumentUploadSystemMessage(message)) {
      return visibleMessages
    }

    let displayMessage = message

    if (isDocumentUploadUserMessage(message)) {
      displayMessage = {
        ...message,
        content: message.content.replace('[파일 업로드] ', '[파일요약] '),
      }
    } else if (message.role === 'assistant') {
      const previousRelevantMessage = [...messages.slice(0, index)].reverse().find((item) => item.role !== 'system')
      if (previousRelevantMessage && isDocumentUploadUserMessage(previousRelevantMessage)) {
        displayMessage = {
          ...message,
          content: `[파일요약] ${message.content}`,
        }
      }
    }

    visibleMessages.push(displayMessage)
    return visibleMessages
  }, [])
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
  const [selectedDocumentFile, setSelectedDocumentFile] = useState<File | null>(null)
  const [localMessagesBySessionId, setLocalMessagesBySessionId] = useState<Record<number, ChatMessage[]>>(() =>
    loadLocalChatMessages(),
  )
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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

  const isProcessing = sessionsLoading || detailLoading || sending || uploading

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

  const handleDocumentFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    setSelectedDocumentFile(file)
    setActionError(null)
  }

  const handleSendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isProcessing) return

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

  const handleDocumentSummary = async () => {
    if (isProcessing) return

    if (!selectedDocumentFile) {
      setActionError('요약할 문서를 먼저 선택해 주세요.')
      return
    }

    if (selectedSessionId !== null && chatLocked) {
      setActionError('보관된 대화방에는 파일을 업로드할 수 없습니다.')
      return
    }

    setUploading(true)
    setActionError(null)

    try {
      let activeSessionId = selectedSessionId
      if (activeSessionId === null) {
        const inferredTitle = selectedDocumentFile.name.replace(/\.[^.]+$/, '').trim() || '문서 요약'
        const created = await createChatSession(token, inferredTitle)
        setSessions((current) => [created, ...current])
        setSelectedSessionId(created.id)
        storeLastChatSessionId(created.id)
        activeSessionId = created.id
        await loadSessionDetail(created.id)
      }

      const response = await uploadDocumentSummary(token, selectedDocumentFile, activeSessionId)
      const nextSessionId = response.session_id
      setSelectedSessionId(nextSessionId)
      storeLastChatSessionId(nextSessionId)
      await Promise.all([loadSessionDetail(nextSessionId), reloadSessions(nextSessionId)])
      setSelectedDocumentFile(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired()
        return
      }
      setActionError(error instanceof Error ? error.message : '파일 요약을 처리하지 못했습니다.')
    } finally {
      setUploading(false)
    }
  }

  const handleArchiveSession = async () => {
    if (selectedSessionId === null) return

    const confirmed = window.confirm('이 대화방을 삭제하시겠습니까?')
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
      setActionError(error instanceof Error ? error.message : '대화방을 삭제하지 못했습니다.')
    }
  }

  const selectedSession = sessions.find((item) => item.id === selectedSessionId) ?? null
  const chatLocked = !selectedSession || selectedSession.is_archived
  const uploadLocked = selectedSession?.is_archived ?? false
  const displayMessages = getDisplayMessages(sessionDetail?.messages ?? [])

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
                    삭제
                  </Button>
                </Stack>

                {actionError ? <Alert severity="error">{actionError}</Alert> : null}

                {isProcessing ? (
                  <Stack spacing={1} sx={{ py: 0.5 }}>
                    <LinearProgress />
                    <Typography variant="caption" color="text.secondary">
                      처리 중
                    </Typography>
                  </Stack>
                ) : null}

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
                    ) : displayMessages.length ? (
                      displayMessages.map((message) => (
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
                      disabled={chatLocked || isProcessing}
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
                        disabled={isProcessing || !messageDraft.trim() || chatLocked}
                      >
                        {isProcessing ? '처리 중...' : isSearchMode ? '검색하기' : '메시지 보내기'}
                      </Button>
                    </Stack>

                    <Divider />

                    <Stack spacing={1.5}>
                      <Stack direction="row" sx={{ alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                        <input
                          ref={fileInputRef}
                          type="file"
                          hidden
                          accept=".pdf,.txt,application/pdf,text/plain"
                          onChange={handleDocumentFileChange}
                        />
                        <Button
                          type="button"
                          variant="outlined"
                          onClick={() => {
                            fileInputRef.current?.click()
                          }}
                          disabled={isProcessing || uploadLocked}
                        >
                          [업로드]
                        </Button>
                        <Button
                          type="button"
                          variant="contained"
                          onClick={handleDocumentSummary}
                          disabled={isProcessing || !selectedDocumentFile || uploadLocked}
                        >
                          {uploading ? '요약 중...' : '[문서 파일 요약]'}
                        </Button>
                        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                          {selectedDocumentFile
                            ? `선택된 파일: ${selectedDocumentFile.name}`
                            : 'PDF 또는 텍스트 파일을 선택해 요약할 수 있습니다.'}
                        </Typography>
                      </Stack>
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
