export enum TagMatchMode {
  Any = 'any',
  All = 'all',
}

export interface TagFilter {
  readonly names: readonly string[];
  readonly mode: TagMatchMode;
}

/** Read model of the aggregate: a key with its per-locale values and tags. */
export interface TranslationKeyView {
  readonly id: string;
  readonly key: string;
  readonly description: string | null;
  readonly values: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateTranslationCommand {
  readonly key: string;
  readonly description: string | null;
  /** locale code → value */
  readonly values: ReadonlyMap<string, string>;
  readonly tags: readonly string[];
}

export interface UpdateTranslationCommand {
  readonly id: string;
  /** `undefined` = leave unchanged, `null` = clear. */
  readonly description: string | null | undefined;
  /** Merged by locale; a `null` value removes that locale's translation. */
  readonly values: ReadonlyMap<string, string | null> | undefined;
  /** Replaces the full tag set when provided. */
  readonly tags: readonly string[] | undefined;
}

export interface SearchTranslationsQuery {
  readonly keyPrefix: string | undefined;
  readonly text: string | undefined;
  readonly tags: TagFilter | undefined;
  readonly localeCode: string | undefined;
  readonly cursor: string | undefined;
  readonly limit: number;
}

export interface SearchCriteria {
  readonly keyPrefix: string | undefined;
  readonly text: string | undefined;
  readonly tags: TagFilter | undefined;
  readonly localeCode: string | undefined;
  readonly afterId: string | undefined;
  readonly limit: number;
}

export interface TranslationPage {
  readonly items: readonly TranslationKeyView[];
  readonly nextCursor: string | null;
}
