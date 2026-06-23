import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type BackendMessage = {
  status: string
}

type ChatResponse = {
  answer: string
}

function App() {
  const [backendStatus, setBackendStatus] = useState('백엔드 연결 확인 중...')
  const [backendError, setBackendError] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    const controller = new AbortController()

    const loadMessage = async () => {
      try {
        const response = await fetch('/api/', {
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const data = (await response.json()) as BackendMessage
        setBackendStatus(`백엔드 응답: ${data.status}`)
        setBackendError(null)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return
        }

        setBackendStatus('백엔드 응답을 불러오지 못했습니다.')
        setBackendError(err instanceof Error ? err.message : 'unknown error')
      }
    }

    loadMessage()

    return () => controller.abort()
  }, [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const trimmedQuestion = question.trim()
    if (!trimmedQuestion || isSubmitting) {
      return
    }

    setIsSubmitting(true)
    setChatError(null)
    setAnswer('')

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ question: trimmedQuestion }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = (await response.json()) as ChatResponse
      setAnswer(data.answer)
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'unknown error')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Gemini Chat</p>
          <h1>질문을 보내고 답변을 바로 받아보세요</h1>
          <p className="lead">{backendStatus}</p>
          {backendError ? <p className="error">에러: {backendError}</p> : null}
        </div>

        <form className="chat-form" onSubmit={handleSubmit}>
          <label className="field-label" htmlFor="question">
            질문
          </label>
          <textarea
            id="question"
            className="question-input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Gemini에게 물어볼 내용을 입력하세요."
            rows={6}
          />
          <div className="actions">
            <button type="submit" disabled={isSubmitting || !question.trim()}>
              {isSubmitting ? '전송 중...' : '질문 보내기'}
            </button>
          </div>
        </form>

        <section className="response-panel" aria-live="polite">
          <p className="response-label">응답</p>
          {chatError ? <p className="error">에러: {chatError}</p> : null}
          {answer ? <pre className="answer">{answer}</pre> : <p className="empty">아직 받은 답변이 없습니다.</p>}
        </section>
      </section>
    </main>
  )
}

export default App
