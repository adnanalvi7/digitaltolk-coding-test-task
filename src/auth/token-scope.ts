export const TokenScope = {
  TranslationsRead: 'translations:read',
  TranslationsWrite: 'translations:write',
  LocalesWrite: 'locales:write',
  ExportRead: 'export:read',
} as const;

export type TokenScope = (typeof TokenScope)[keyof typeof TokenScope];

export const ALL_TOKEN_SCOPES: readonly TokenScope[] = Object.values(TokenScope);

export function isTokenScope(value: string): value is TokenScope {
  return (ALL_TOKEN_SCOPES as readonly string[]).includes(value);
}
