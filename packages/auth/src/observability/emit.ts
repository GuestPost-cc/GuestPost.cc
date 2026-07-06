export interface AuthEvent {
  type:
    | "LOGIN"
    | "LOGOUT"
    | "PASSWORD_RESET"
    | "SESSION_EXPIRED"
    | "OAUTH_LINKED"
  userId?: string
  timestamp: Date
  metadata?: Record<string, string | boolean | number>
}

function createEmitter() {
  const listeners: Array<(event: AuthEvent) => void> = []

  return {
    emit(event: AuthEvent) {
      for (const listener of listeners) {
        try {
          listener(event)
        } catch {
          // swallow listener errors
        }
      }
    },
    on(listener: (event: AuthEvent) => void) {
      listeners.push(listener)
      return () => {
        const idx = listeners.indexOf(listener)
        if (idx !== -1) listeners.splice(idx, 1)
      }
    },
  }
}

const emitter = createEmitter()

export function emitLogin(ctx: {
  userId: string
  method: "email" | "oauth"
  provider?: string
}) {
  emitter.emit({
    type: "LOGIN",
    userId: ctx.userId,
    timestamp: new Date(),
    metadata: {
      method: ctx.method,
      ...(ctx.provider ? { provider: ctx.provider } : {}),
    },
  })
}

export function emitLogout(ctx: { userId: string }) {
  emitter.emit({
    type: "LOGOUT",
    userId: ctx.userId,
    timestamp: new Date(),
  })
}

export function emitPasswordReset(ctx: { userId: string }) {
  emitter.emit({
    type: "PASSWORD_RESET",
    userId: ctx.userId,
    timestamp: new Date(),
  })
}

export function emitSessionExpired(ctx: { userId: string }) {
  emitter.emit({
    type: "SESSION_EXPIRED",
    userId: ctx.userId,
    timestamp: new Date(),
  })
}

export function emitOAuthLinked(ctx: { userId: string; provider: string }) {
  emitter.emit({
    type: "OAUTH_LINKED",
    userId: ctx.userId,
    timestamp: new Date(),
    metadata: { provider: ctx.provider },
  })
}

export function onAuthEvent(listener: (event: AuthEvent) => void) {
  return emitter.on(listener)
}
