export enum ExportFormat {
  Flat = 'flat',
  Nested = 'nested',
}

export interface ExportEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * Strategy for serialising one locale's entries. Adding a format (e.g. YAML)
 * means adding a class and registering it — no existing class changes.
 */
export abstract class ExportFormatter {
  abstract readonly format: ExportFormat;
  abstract readonly contentType: string;
  /**
   * Serialises a whole locale. Implementations must yield to the event loop
   * while doing O(n) work, so a cold build never stalls other requests.
   */
  abstract render(entries: readonly ExportEntry[]): Promise<string>;
}

export const EXPORT_FORMATTERS = Symbol('EXPORT_FORMATTERS');
