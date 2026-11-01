/**
 * Every sentence the app shows, by locale, picked once at startup from the phone's language.
 * ko is the shape: en must match it key for key, so a missing or extra key fails tsc, and
 * text.test.ts fails on any Hangul in en. Words the gateway sends (domain names, verdict text
 * from an older gateway, failure details) are shown as they come.
 */

import type { MemoListItemWire } from '../lib/wire';
import type { Stage } from '../lib/memos';
import { deviceTag } from './device';
import { en } from './en';
import { ko } from './ko';

export type { Stage };
export type Locale = 'ko' | 'en';
export type Copy = typeof ko;
export type VerdictId = NonNullable<MemoListItemWire['verdict_id']>;
/** MemoFailureWire.code values the app words. Any other code gets failure.unknown. */
export type FailureCode = 'llm' | 'scope' | 'input-modified' | 'append-only' | 'frontmatter' | 'type' | 'empty' | 'interrupted';

export const COPY: { readonly [L in Locale]: Copy } = { ko, en };

/** Korean for any ko tag, English for everything else. */
export const localeFor = (tag: string | undefined): Locale => (/^ko(?:[-_]|$)/i.test(tag ?? '') ? 'ko' : 'en');

export const locale: Locale = localeFor(deviceTag());
export const copy: Copy = COPY[locale];
