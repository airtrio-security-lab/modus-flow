import { useEffect, useState } from 'react';
import { api, errorText, setToken } from '../lib/api';
import type { Personas } from '../lib/types';

/**
 * Demo sign-in. In production this screen is replaced by the company SSO
 * (OIDC, ADR-0009); here the jury picks a fictional employee.
 */
export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [data, setData] = useState<Personas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api<Personas>('/demo/personas')
      .then(setData)
      .catch((e) => setError(e?.status === 404 ? 'Демо-вход выключен на этом сервере. Вход выполняется через корпоративный SSO.' : errorText(e)));
  }, []);

  async function signIn(userId: string) {
    setBusy(userId);
    setError(null);
    try {
      const { token } = await api<{ token: string }>('/demo/login', { json: { userId }, idempotent: false });
      setToken(token);
      onSignedIn();
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  }

  return (
    <main className="login">
      <div className="login-box">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          <span>
            MODUS FLOW
            <small>Обратная связь и предложения сотрудников</small>
          </span>
        </div>
        <div className="stack">
          <h1>Войдите как сотрудник</h1>
          <p className="muted">
            Каждый вопрос получает ответственного и срок. Автор видит, на каком этапе его обращение, а руководство видит, что
            требует решения.
          </p>
        </div>
        <div className="notice warn">
          Демонстрационный стенд. Люди и обращения вымышлены. Выбор сотрудника заменяет вход через корпоративный SSO, который
          подключается при внедрении.
        </div>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {data && (
          <div className="list" aria-label={`Сотрудники: ${data.organizationName}`}>
            {data.personas.map((p) => (
              <button key={p.userId} className="persona" onClick={() => void signIn(p.userId)} disabled={busy !== null}>
                <span className="name">{p.name}</span>
                <span className="dept">{busy === p.userId ? 'Входим…' : p.department}</span>
                <span className="hint">
                  {p.title}. {cap(p.hint.split(': ')[1] ?? p.hint)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
