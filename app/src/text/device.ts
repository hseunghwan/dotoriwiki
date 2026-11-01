/** The phone's language as a BCP 47 tag. Hermes answers from the Android system locale. */
export const deviceTag = (): string | undefined => Intl.DateTimeFormat().resolvedOptions().locale;
