/** Public chat limits. Generous for a real visitor, tight enough to stop scripted cost abuse. */
export const PUBLIC_CHAT_LIMITS = {
  perVisitor: { limit: 20, windowSeconds: 10 * 60 },
  perIp: { limit: 60, windowSeconds: 10 * 60 },
  perAgent: { limit: 600, windowSeconds: 60 * 60 },
  /** Voice notes and screenshots cost an extra 0G call each. */
  mediaPerVisitor: { limit: 10, windowSeconds: 10 * 60 },
} as const;
