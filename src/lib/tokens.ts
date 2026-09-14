/** CSS-token helpers for chrome that must not hard-code hex. */

/** Single fallback when an agent has no accent — replaces duplicated #8b95a7. */
export const KEEL_AGENT_FALLBACK = "var(--keel-agent-fallback)";

/** Resolve an agent accent to a CSS value (catalogue hex or fallback token). */
export function agentAccent(accent: string | null | undefined): string {
  const value = accent?.trim();
  return value ? value : KEEL_AGENT_FALLBACK;
}
